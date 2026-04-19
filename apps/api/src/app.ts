import { createHmac, randomBytes } from "node:crypto";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentManifest, RunbookDefinition, UserSummary } from "@wireguard-ops-cockpit/domain";
import { createTmuxAdapter } from "@wireguard-ops-cockpit/tmux-adapter";
import { AUTH_COOKIE, clearAuthCookie, parseCookies, serializeAuthCookie } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { CockpitDatabase } from "./db.js";
import { AGENTS, RUNBOOKS, buildAgentCommand, findAgent, findRunbook } from "./registries.js";

interface AppOptions {
  config?: AppConfig;
  bootstrapUsers?: Array<{ username: string; password: string; role?: "admin" }>;
}

interface LoginAttemptState {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function terminalUrl(baseUrl: string | null, sessionId: string, signingSecret: Buffer): string | null {
  if (!baseUrl) {
    return null;
  }

  const token = createHmac("sha256", signingSecret).update(sessionId).digest("hex");
  return `${baseUrl.replace(/\/$/, "")}/attach?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

function runbookOutput(runbook: RunbookDefinition, sessionName: string | null, actor: UserSummary) {
  return {
    summary: `${runbook.name} completed as a safe placeholder.`,
    lines: [
      "This runbook keeps privileged execution behind a future local integration point.",
      `Requested by ${actor.username}.`,
      sessionName ? `Linked session: ${sessionName}.` : "No tmux session linked to this request."
    ]
  };
}

function agentOutput(agent: AgentManifest, prompt: string, started: boolean, note: string) {
  return {
    summary: `${agent.name} ${started ? "started" : "recorded"} through the control plane.`,
    prompt,
    note
  };
}

async function requireActor(
  request: FastifyRequest,
  reply: FastifyReply,
  database: CockpitDatabase
): Promise<UserSummary | null> {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[AUTH_COOKIE];
  if (!token) {
    await reply.code(401).send({ message: "authentication required" });
    return null;
  }

  const actor = database.findUserByAuthToken(token);
  if (!actor) {
    await reply.code(401).send({ message: "authentication required" });
    return null;
  }

  return actor;
}

export async function createApp(options: AppOptions = {}) {
  const config = options.config || loadConfig();
  if (config.nodeEnv === "production" && config.adminPassword === "change-me-now") {
    throw new Error("COCKPIT_ADMIN_PASSWORD must be changed before running in production");
  }

  const database = new CockpitDatabase(config.dbPath);
  const tmux = createTmuxAdapter(config.tmuxMode);
  const terminalSigningSecret = randomBytes(32);
  const loginAttempts = new Map<string, LoginAttemptState>();

  database.initialize();
  database.seedAdmin(config.adminUsername, config.adminPassword);
  for (const user of options.bootstrapUsers || []) {
    database.createUser(user.username, user.password, user.role || "admin");
  }

  const app = Fastify({ logger: false });

  app.addHook("onClose", async () => {
    database.close();
  });

  app.get("/api/health", async () => ({
    ok: true,
    tmuxBackend: tmux.backend
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body || {}) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return reply.code(400).send({ message: "username and password are required" });
    }

    const loginKey = `${request.ip}:${body.username.toLowerCase()}`;
    const existingAttempt = loginAttempts.get(loginKey);
    const currentTime = Date.now();
    if (existingAttempt && existingAttempt.blockedUntil > currentTime) {
      return reply.code(429).send({ message: "too many login attempts, try again later" });
    }

    const actor = database.authenticateUser(body.username, body.password);
    if (!actor) {
      const nextAttempt =
        existingAttempt && currentTime - existingAttempt.windowStartedAt <= LOGIN_WINDOW_MS
          ? { ...existingAttempt, count: existingAttempt.count + 1 }
          : { count: 1, windowStartedAt: currentTime, blockedUntil: 0 };

      if (nextAttempt.count >= MAX_LOGIN_ATTEMPTS) {
        nextAttempt.blockedUntil = currentTime + LOGIN_BLOCK_MS;
      }

      loginAttempts.set(loginKey, nextAttempt);
      database.createAudit({
        actorId: null,
        action: "auth.login_failed",
        targetType: "user",
        targetId: null,
        details: {
          username: body.username,
          sourceIp: request.ip,
          blockedUntil: nextAttempt.blockedUntil || null
        }
      });
      return reply.code(401).send({ message: "invalid credentials" });
    }

    loginAttempts.delete(loginKey);
    const token = database.issueAuthSession(actor.id, config.sessionTtlHours);
    database.createAudit({
      actorId: actor.id,
      action: "auth.login",
      targetType: "user",
      targetId: actor.id,
      details: { username: actor.username }
    });

    reply.header(
      "set-cookie",
      serializeAuthCookie(token, config.sessionTtlHours * 60 * 60, config.cookieSecure)
    );

    return { user: actor };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[AUTH_COOKIE];
    if (token) {
      const actor = database.findUserByAuthToken(token);
      database.revokeAuthToken(token);
      if (actor) {
        database.createAudit({
          actorId: actor.id,
          action: "auth.logout",
          targetType: "user",
          targetId: actor.id,
          details: { username: actor.username }
        });
      }
    }

    reply.header("set-cookie", clearAuthCookie(config.cookieSecure));
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { user: actor };
  });

  app.get("/api/sessions", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { sessions: database.listSessions() };
  });

  app.post("/api/sessions", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const body = (request.body || {}) as { name?: string };
    const sessionSlug = slugify(body.name || "");
    if (!sessionSlug) {
      return reply.code(400).send({ message: "session name must include letters or numbers" });
    }

    const tmuxSessionName = `cockpit-${sessionSlug}`;
    const ensured = tmux.ensureSession(tmuxSessionName);
    let session = database.upsertSession({
      name: sessionSlug,
      tmuxSessionName,
      tmuxBackend: ensured.backend,
      terminalUrl: null
    });
    session = database.updateSessionTerminalUrl(
      session.id,
      terminalUrl(config.ttydBaseUrl, session.id, terminalSigningSecret)
    );
    database.recordSessionActivity(session.id);

    const job = database.createJob({
      sessionId: session.id,
      kind: "session.ensure",
      subjectId: session.id,
      status: "completed",
      requiresApproval: false,
      output: {
        summary: "Cockpit session ensured.",
        backend: ensured.backend,
        sessionId: session.id,
        requestedBy: actor.username
      },
      completedAt: new Date().toISOString()
    });

    database.createAudit({
      actorId: actor.id,
      action: "session.ensure",
      targetType: "cockpit-session",
      targetId: session.id,
      details: {
        sessionName: session.name,
        tmuxBackend: session.tmuxBackend
      }
    });

    return reply.code(201).send({ session, job });
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { sessionId } = request.params as { sessionId: string };
    const session = database.getSessionById(sessionId);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    return {
      session,
      jobs: database.listJobsForSession(sessionId)
    };
  });

  app.get("/api/runbooks", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { runbooks: RUNBOOKS };
  });

  app.post("/api/runbooks/:runbookId/execute", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { runbookId } = request.params as { runbookId: string };
    const runbook = findRunbook(runbookId);
    if (!runbook) {
      return reply.code(404).send({ message: "runbook not found" });
    }

    const body = (request.body || {}) as { sessionId?: string };
    const session = body.sessionId ? database.getSessionById(body.sessionId) : null;

    if (body.sessionId && !session) {
      return reply.code(404).send({ message: "session not found" });
    }

    if (runbook.requiresApproval) {
      const pendingJob = database.createJob({
        sessionId: session?.id || null,
        kind: "runbook",
        subjectId: runbook.id,
        status: "pending_approval",
        requiresApproval: true,
        output: {
          summary: `${runbook.name} is waiting for human approval.`,
          integration: "placeholder",
          requestedBy: actor.username,
          requestedByUserId: actor.id,
          sessionId: session?.id || null,
          sessionName: session?.name || null,
          runbookId: runbook.id
        }
      });

      const approval = database.createApproval({
        jobId: pendingJob.id,
        requestedBy: actor.id,
        reason: `${runbook.name} requires explicit approval before any host-facing integration exists.`
      });

      const job = database.updateJob(pendingJob.id, {
        status: "pending_approval",
        approvalId: approval.id,
        output: pendingJob.output
      });

      database.createAudit({
        actorId: actor.id,
        action: "runbook.requested",
        targetType: "runbook",
        targetId: runbook.id,
        details: {
          runbookId: runbook.id,
          sessionId: session?.id || null,
          approvalId: approval.id,
          requestedBy: actor.username
        }
      });

      if (session) {
        database.recordSessionActivity(session.id);
      }

      return reply.code(202).send({ job, approval });
    }

    const job = database.createJob({
      sessionId: session?.id || null,
      kind: "runbook",
      subjectId: runbook.id,
      status: "completed",
      requiresApproval: false,
      output: runbookOutput(runbook, session?.name || null, actor),
      completedAt: new Date().toISOString()
    });

    if (session) {
      database.recordSessionActivity(session.id);
    }

    database.createAudit({
      actorId: actor.id,
      action: "runbook.executed",
      targetType: "runbook",
      targetId: runbook.id,
      details: { runbookId: runbook.id, sessionId: session?.id || null }
    });

    return reply.code(201).send({ job });
  });

  app.get("/api/approvals", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { status } = (request.query || {}) as { status?: "pending" | "approved" | "rejected" };
    return { approvals: database.listApprovals(status) };
  });

  app.post("/api/approvals/:approvalId/decision", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { approvalId } = request.params as { approvalId: string };
    const approval = database.getApproval(approvalId);
    if (!approval) {
      return reply.code(404).send({ message: "approval not found" });
    }

    if (approval.status !== "pending") {
      return reply.code(409).send({ message: "approval already decided" });
    }

    const body = (request.body || {}) as { decision?: "approved" | "rejected"; reason?: string };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return reply.code(400).send({ message: "decision must be approved or rejected" });
    }

    const updatedApproval = database.decideApproval(approvalId, {
      status: body.decision,
      decidedBy: actor.id,
      reason: body.reason || null
    });

    const job = database.getJob(approval.jobId);
    if (!job) {
      return reply.code(500).send({ message: "approval job not found" });
    }

    let updatedJob;
    if (body.decision === "approved") {
      const runbook = job.subjectId ? findRunbook(job.subjectId) : undefined;
      updatedJob = database.updateJob(job.id, {
        status: "completed",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...(job.output || {}),
          ...(runbook ? runbookOutput(runbook, null, actor) : {}),
          approvalDecision: "approved"
        }
      });
    } else {
      updatedJob = database.updateJob(job.id, {
        status: "rejected",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...(job.output || {}),
          approvalDecision: "rejected",
          summary: "Execution was rejected before any host-facing action could run."
        }
      });
    }

    if (updatedJob.sessionId) {
      database.recordSessionActivity(updatedJob.sessionId);
    }

    database.createAudit({
      actorId: actor.id,
      action: "approval.decided",
      targetType: "approval",
      targetId: updatedApproval.id,
      details: {
        decision: updatedApproval.status,
        jobId: updatedApproval.jobId
      }
    });

    return { approval: updatedApproval, job: updatedJob };
  });

  app.get("/api/agents", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { agents: AGENTS };
  });

  app.post("/api/agents/:agentId/launch", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { agentId } = request.params as { agentId: string };
    const agent = findAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ message: "agent not found" });
    }

    const body = (request.body || {}) as { sessionId?: string; prompt?: string };
    if (!body.sessionId) {
      return reply.code(400).send({ message: "sessionId is required" });
    }

    const session = database.getSessionById(body.sessionId);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const prompt = (body.prompt || "Inspect the current maintenance context and report back.")
      .trim()
      .slice(0, 240);
    const command = buildAgentCommand(config.repoRoot, prompt);
    const launch = tmux.launchCommand(session.tmuxSessionName, "agent-demo", command);
    database.recordSessionActivity(session.id);

    const job = database.createJob({
      sessionId: session.id,
      kind: "agent",
      subjectId: agent.id,
      status: "completed",
      requiresApproval: false,
      output: agentOutput(agent, prompt, launch.started, launch.note),
      completedAt: new Date().toISOString()
    });

    database.createAudit({
      actorId: actor.id,
      action: "agent.launched",
      targetType: "agent",
      targetId: agent.id,
      details: {
        sessionId: session.id,
        tmuxBackend: launch.backend
      }
    });

    return reply.code(201).send({ job });
  });

  app.get("/api/audits", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { limit } = (request.query || {}) as { limit?: string };
    return { audits: database.listAudits(Number(limit || "50")) };
  });

  app.get("/api/dashboard", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return {
      user: actor,
      sessions: database.listSessions(),
      runbooks: RUNBOOKS,
      agents: AGENTS,
      approvals: database.listApprovals("pending"),
      audits: database.listAudits(20)
    };
  });

  return app;
}

import { createHash, createHmac } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AgentManifest,
  ExecutionPlan,
  ExecutionReview,
  ExecutionRiskClass,
  RunbookDefinition,
  ScheduledRunbook,
  ScheduledRunbookMode,
  UserSummary
} from "@wireguard-ops-cockpit/domain";
import { createTmuxAdapter } from "@wireguard-ops-cockpit/tmux-adapter";
import { AUTH_COOKIE, clearAuthCookie, parseCookies, serializeAuthCookie } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { CockpitDatabase } from "./db.js";
import {
  computeRunbookVersionHash,
  INTERNAL_EXECUTION_AGENTS,
  RUNBOOKS,
  buildAgentCommand,
  buildRunbookDispatch,
  findAgent,
  listScripts,
  listAgents,
  findRunbook
} from "./registries.js";

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
  return `${baseUrl.replace(/\/$/, "")}/?arg=${encodeURIComponent(sessionId)}&arg=${encodeURIComponent(token)}`;
}

function createPlanHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function recomputePlanHash(plan: ExecutionPlan): string {
  return createPlanHash({
    targetType: plan.targetType,
    targetId: plan.targetId,
    sessionId: plan.sessionId,
    requestedBy: plan.requestedBy,
    normalizedInput: plan.normalizedInput,
    riskClass: plan.riskClass
  });
}

function review(
  actorId: string | null,
  verdict: ExecutionReview["verdict"],
  summary: string,
  details: Record<string, unknown> = {}
): ExecutionReview {
  return {
    actorId,
    verdict,
    summary,
    details
  };
}

function normalizePrompt(value: string | undefined) {
  const basePrompt = (value || "Inspect the current maintenance context and report back.").trim();
  const withoutControlChars = basePrompt.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const compact = withoutControlChars.replace(/\s+/g, " ").trim();
  const normalized = (compact || "Inspect the current maintenance context and report back.").slice(0, 240);

  return {
    prompt: normalized,
    removedControlChars: withoutControlChars !== basePrompt,
    truncated: normalized.length < compact.length
  };
}

function isHighRiskRunbook(runbook: RunbookDefinition) {
  return runbook.requiresApproval || runbook.privilegedHelperRequested;
}

function validateWeekday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function validateTimeUtc(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function computeNextWeeklyRunAt(weekday: number, timeUtc: string, from = new Date()): string {
  const [hoursText, minutesText] = timeUtc.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const target = new Date(from);
  target.setUTCSeconds(0, 0);
  target.setUTCHours(hours, minutes, 0, 0);

  let daysAhead = (weekday - from.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && target.getTime() <= from.getTime()) {
    daysAhead = 7;
  }

  target.setUTCDate(from.getUTCDate() + daysAhead);
  return target.toISOString();
}

function planJobOutput(plan: ExecutionPlan, summary: string) {
  return {
    summary,
    planId: plan.id,
    planHash: plan.planHash,
    targetType: plan.targetType,
    targetId: plan.targetId,
    riskClass: plan.riskClass,
    plannerVerdict: plan.plannerReview.verdict,
    safetyVerdict: plan.safetyReview.verdict,
    policyVerdict: plan.policyReview.verdict
  };
}

function scheduleJobOutput(schedule: ScheduledRunbook, summary: string) {
  return {
    summary,
    scheduleId: schedule.id,
    runbookId: schedule.runbookId,
    effectiveMode: schedule.effectiveMode,
    nextRunAt: schedule.nextRunAt
  };
}

function runbookDispatchOutput(
  runbook: RunbookDefinition,
  sessionName: string,
  tmuxSessionName: string,
  windowName: string,
  actor: UserSummary,
  note: string
) {
  return {
    summary: `${runbook.name} dispatched to the host tmux executor.`,
    lines: [
      `Requested by ${actor.username}.`,
      `Linked session: ${sessionName}.`,
      `tmux target: ${tmuxSessionName}:${windowName}.`,
      note,
      `Manual attach: sudo -u wgops tmux attach -t ${tmuxSessionName}`
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
  if (config.nodeEnv === "production" && config.terminalSigningSecret === "development-terminal-secret") {
    throw new Error("COCKPIT_TERMINAL_SIGNING_SECRET must be changed before running in production");
  }

  const database = new CockpitDatabase(config.dbPath);
  const tmux = createTmuxAdapter(config.tmuxMode);
  const agents = listAgents();
  const scripts = listScripts();
  const terminalSigningSecret = Buffer.from(config.terminalSigningSecret, "utf8");
  const loginAttempts = new Map<string, LoginAttemptState>();
  const scheduleLocks = new Set<string>();

  function createRunbookPlan(
    actor: UserSummary,
    runbook: RunbookDefinition,
    session: { id: string; name: string } | null,
    options: { trigger: "manual" | "scheduled"; autoDispatch: boolean; scheduleId?: string } = {
      trigger: "manual",
      autoDispatch: true
    }
  ) {
    const riskClass: ExecutionRiskClass = runbook.requiresApproval || runbook.privilegedHelperRequested ? "high" : "low";
    const normalizedInput = {
      runbookId: runbook.id,
      sessionId: session?.id || null,
      sessionName: session?.name || null,
      trigger: options.trigger,
      scheduleId: options.scheduleId || null
    };

    const plannerReview = review(
      INTERNAL_EXECUTION_AGENTS.planner.id,
      "passed",
      `${INTERNAL_EXECUTION_AGENTS.planner.name} normalized ${runbook.name} into a bounded runbook request.`,
      {
        integration: runbook.integration,
        privilegedHelperRequested: runbook.privilegedHelperRequested,
        sessionLinked: Boolean(session)
      }
    );
    const safetyReview = review(
      INTERNAL_EXECUTION_AGENTS.safety.id,
      runbook.requiresApproval ? "approval_required" : "passed",
      runbook.requiresApproval
        ? `${INTERNAL_EXECUTION_AGENTS.safety.name} escalated ${runbook.name} for human approval before any host-facing step can run.`
        : `${INTERNAL_EXECUTION_AGENTS.safety.name} found the placeholder runbook bounded to a low-risk contract.`,
      {
        requiresApproval: runbook.requiresApproval,
        requestedBy: actor.username,
        riskClass
      }
    );
    const policyReview = review(
      null,
      "passed",
      "Deterministic policy gate confirmed the runbook is allowlisted and the request stayed within the manifest contract.",
      {
        runbookId: runbook.id,
        targetType: "runbook"
      }
    );
    const preExecutionHook = review(
      null,
      "passed",
      session
        ? "Pre-exec hook bound the runbook request to the selected cockpit session."
        : "Pre-exec hook accepted the runbook request without a linked tmux session.",
      {
        sessionId: session?.id || null
      }
    );
    const runtimeHook = review(
      null,
      runbook.requiresApproval ? "not_run" : options.autoDispatch ? "pending" : "not_run",
      runbook.requiresApproval
        ? "Runtime hook is waiting for approval before dispatch."
        : options.autoDispatch
          ? "Runtime hook is armed for bounded placeholder dispatch."
          : "Runtime hook is waiting for an operator or schedule policy to dispatch the bounded executor.",
      {}
    );
    const postExecutionHook = review(
      null,
      runbook.requiresApproval ? "not_run" : options.autoDispatch ? "pending" : "not_run",
      runbook.requiresApproval
        ? "Post-exec verification will run only after approval and dispatch."
        : options.autoDispatch
          ? "Post-exec verification will confirm the placeholder output and audit trail."
          : "Post-exec verification will start only after a later bounded dispatch occurs.",
      {}
    );

    return database.createExecutionPlan({
      sessionId: session?.id || null,
      targetType: "runbook",
      targetId: runbook.id,
      requestedBy: actor.id,
      status: runbook.requiresApproval ? "pending_approval" : "ready",
      riskClass,
      requiresApproval: runbook.requiresApproval,
      planHash: createPlanHash({
        targetType: "runbook",
        targetId: runbook.id,
        sessionId: session?.id || null,
        requestedBy: actor.id,
        normalizedInput,
        riskClass
      }),
      planSummary:
        options.trigger === "scheduled"
          ? `${runbook.name} was generated by a weekly schedule and will still pass planner, safety review, policy validation, and hooks before any bounded execution continues.`
          : `${runbook.name} will run through planner, safety review, policy validation, and hooks before the bounded executor can continue.`,
      normalizedInput,
      plannerReview,
      safetyReview,
      policyReview,
      preExecutionHook,
      runtimeHook,
      postExecutionHook
    });
  }

  function createPendingApprovalForPlan(plan: ExecutionPlan, actor: UserSummary, reason: string) {
    const pendingJob = database.createJob({
      sessionId: plan.sessionId,
      kind: "execution.plan",
      subjectId: plan.id,
      status: "pending_approval",
      requiresApproval: true,
      output: planJobOutput(plan, reason)
    });
    const approval = database.createApproval({
      jobId: pendingJob.id,
      requestedBy: actor.id,
      reason
    });
    const job = database.updateJob(pendingJob.id, {
      status: "pending_approval",
      approvalId: approval.id,
      output: planJobOutput(plan, reason)
    });
    const updatedPlan = database.updateExecutionPlan(plan.id, {
      approvalId: approval.id,
      status: "pending_approval"
    });

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.pending_approval",
      targetType: "execution-plan",
      targetId: updatedPlan.id,
      details: {
        approvalId: approval.id,
        requestedBy: actor.username
      }
    });

    if (plan.sessionId) {
      database.recordSessionActivity(plan.sessionId);
    }

    return { plan: updatedPlan, job, approval };
  }

  function createReadyPlanRecord(plan: ExecutionPlan, actor: UserSummary, summary: string) {
    const job = database.createJob({
      sessionId: plan.sessionId,
      kind: "execution.plan",
      subjectId: plan.id,
      status: "completed",
      requiresApproval: false,
      output: planJobOutput(plan, summary),
      completedAt: new Date().toISOString()
    });

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.ready",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        jobId: job.id,
        requestedBy: actor.username
      }
    });

    if (plan.sessionId) {
      database.recordSessionActivity(plan.sessionId);
    }

    return { plan, job };
  }

  function pauseSchedule(scheduleId: string, actorId: string | null, summary: string, details: Record<string, unknown>) {
    const schedule = database.updateScheduledRunbook(scheduleId, {
      status: "paused"
    });
    database.createAudit({
      actorId,
      action: "schedule.paused",
      targetType: "scheduled-runbook",
      targetId: schedule.id,
      details: {
        ...details,
        summary
      }
    });
    return schedule;
  }

  async function processDueScheduledRunbooks() {
    const dueSchedules = database.listDueScheduledRunbooks(new Date().toISOString());

    for (const schedule of dueSchedules) {
      if (scheduleLocks.has(schedule.id)) {
        continue;
      }

      scheduleLocks.add(schedule.id);
      try {
        const actor = database.getUserById(schedule.ownerId);
        const runbook = findRunbook(schedule.runbookId);
        const session = database.getSessionByIdForActor(schedule.sessionId, schedule.ownerId);

        if (!actor || !runbook || !session) {
          pauseSchedule(schedule.id, actor?.id || null, "Scheduled runbook paused because actor, runbook, or session no longer resolves.", {
            actorFound: Boolean(actor),
            runbookFound: Boolean(runbook),
            sessionFound: Boolean(session)
          });
          continue;
        }

        const currentVersionHash = computeRunbookVersionHash(runbook);
        if (currentVersionHash !== schedule.runbookVersionHash) {
          pauseSchedule(schedule.id, actor.id, "Scheduled runbook paused because the reviewed runbook version changed.", {
            expectedRunbookVersionHash: schedule.runbookVersionHash,
            currentRunbookVersionHash: currentVersionHash
          });
          continue;
        }

        if (isHighRiskRunbook(runbook) && schedule.effectiveMode !== "scheduled-plan-only") {
          pauseSchedule(schedule.id, actor.id, "Scheduled runbook paused because high-risk runbooks cannot auto-dispatch in this slice.", {
            effectiveMode: schedule.effectiveMode,
            runbookId: runbook.id
          });
          continue;
        }

        const plan = createRunbookPlan(actor, runbook, session, {
          trigger: "scheduled",
          autoDispatch: schedule.effectiveMode === "scheduled-auto",
          scheduleId: schedule.id
        });

        database.createAudit({
          actorId: actor.id,
          action: "execution.plan.created",
          targetType: "execution-plan",
          targetId: plan.id,
          details: {
            targetType: plan.targetType,
            targetId: plan.targetId,
            sessionId: session.id,
            riskClass: plan.riskClass,
            scheduleId: schedule.id,
            trigger: "scheduled"
          }
        });

        let executedAt: string | null = null;
        if (runbook.requiresApproval) {
          createPendingApprovalForPlan(
            plan,
            actor,
            `${runbook.name} was generated by a weekly schedule and requires human approval before dispatch.`
          );
        } else if (schedule.effectiveMode === "scheduled-auto") {
          executeRunbookPlan(plan, actor, runbook);
          executedAt = new Date().toISOString();
        } else {
          createReadyPlanRecord(plan, actor, `${runbook.name} was generated by a weekly schedule and is ready for operator review.`);
        }

        const nextRunAt = computeNextWeeklyRunAt(schedule.weekday, schedule.timeUtc, new Date(new Date(schedule.nextRunAt).getTime() + 1000));
        const updatedSchedule = database.updateScheduledRunbook(schedule.id, {
          lastPlannedAt: new Date().toISOString(),
          lastRunAt: executedAt,
          nextRunAt
        });

        database.createAudit({
          actorId: actor.id,
          action: "schedule.triggered",
          targetType: "scheduled-runbook",
          targetId: updatedSchedule.id,
          details: {
            effectiveMode: updatedSchedule.effectiveMode,
            executedAt,
            nextRunAt: updatedSchedule.nextRunAt,
            runbookId: updatedSchedule.runbookId
          }
        });
      } finally {
        scheduleLocks.delete(schedule.id);
      }
    }
  }

  function createAgentPlan(actor: UserSummary, agent: AgentManifest, sessionId: string, prompt?: string) {
    const normalizedPrompt = normalizePrompt(prompt);
    const riskClass: ExecutionRiskClass = agent.requiresApproval || agent.privilegedHelperRequested ? "high" : "moderate";
    const normalizedInput = {
      sessionId,
      prompt: normalizedPrompt.prompt,
      promptLength: normalizedPrompt.prompt.length
    };

    const plannerReview = review(
      INTERNAL_EXECUTION_AGENTS.planner.id,
      "passed",
      `${INTERNAL_EXECUTION_AGENTS.planner.name} reduced the agent request to a bounded launch contract for ${agent.name}.`,
      {
        integration: agent.integration,
        promptLength: normalizedPrompt.prompt.length,
        truncated: normalizedPrompt.truncated
      }
    );
    const safetyReview = review(
      INTERNAL_EXECUTION_AGENTS.safety.id,
      agent.requiresApproval ? "approval_required" : "passed",
      agent.requiresApproval
        ? `${INTERNAL_EXECUTION_AGENTS.safety.name} requires explicit approval before ${agent.name} can request any privileged helper.`
        : `${INTERNAL_EXECUTION_AGENTS.safety.name} accepted the prompt because the launch path stays inside the bounded local agent launcher contract.`,
      {
        removedControlChars: normalizedPrompt.removedControlChars,
        truncated: normalizedPrompt.truncated,
        requiresApproval: agent.requiresApproval
      }
    );
    const policyReview = review(
      null,
      "passed",
      "Deterministic policy gate confirmed the agent manifest is allowlisted and no browser-supplied shell command crosses the boundary.",
      {
        agentId: agent.id,
        targetType: "agent"
      }
    );
    const preExecutionHook = review(
      null,
      "passed",
      normalizedPrompt.removedControlChars || normalizedPrompt.truncated
        ? "Pre-exec hook normalized the agent prompt before dispatching the bounded launch request."
        : "Pre-exec hook accepted the agent prompt without modifications.",
      {
        removedControlChars: normalizedPrompt.removedControlChars,
        truncated: normalizedPrompt.truncated,
        sessionId
      }
    );
    const runtimeHook = review(
      null,
      agent.requiresApproval ? "not_run" : "pending",
      agent.requiresApproval
        ? "Runtime hook is waiting for approval before dispatch."
        : "Runtime hook is ready to observe the bounded local agent launch.",
      {}
    );
    const postExecutionHook = review(
      null,
      agent.requiresApproval ? "not_run" : "pending",
      agent.requiresApproval
        ? "Post-exec verification will only run after approval."
        : "Post-exec verification will capture the launch result and keep the session auditable.",
      {}
    );

    return database.createExecutionPlan({
      sessionId,
      targetType: "agent",
      targetId: agent.id,
      requestedBy: actor.id,
      status: agent.requiresApproval ? "pending_approval" : "ready",
      riskClass,
      requiresApproval: agent.requiresApproval,
      planHash: createPlanHash({
        targetType: "agent",
        targetId: agent.id,
        sessionId,
        requestedBy: actor.id,
        normalizedInput,
        riskClass
      }),
      planSummary: `${agent.name} will launch only after planner and safety review, deterministic policy validation, and hook checks have passed.`,
      normalizedInput,
      plannerReview,
      safetyReview,
      policyReview,
      preExecutionHook,
      runtimeHook,
      postExecutionHook
    });
  }

  function executeRunbookPlan(plan: ExecutionPlan, actor: UserSummary, runbook: RunbookDefinition) {
    const session = plan.sessionId ? database.getSessionByIdForActor(plan.sessionId, plan.requestedBy) : null;
    if (!session) {
      throw new Error("session not found for runbook plan");
    }
    const dispatch = buildRunbookDispatch(config.repoRoot, runbook);
    const launch = tmux.launchCommand(session.tmuxSessionName, dispatch.windowName, dispatch.command);
    const job = database.createJob({
      sessionId: session.id,
      kind: "runbook",
      subjectId: runbook.id,
      status: "running",
      requiresApproval: false,
      output: {
        ...runbookDispatchOutput(runbook, session.name, session.tmuxSessionName, dispatch.windowName, actor, launch.note),
        planId: plan.id,
        planHash: plan.planHash,
        tmuxBackend: launch.backend,
        tmuxWindowName: dispatch.windowName
      }
    });

    const updatedPlan = database.updateExecutionPlan(plan.id, {
      status: "executed",
      executedJobId: job.id,
      runtimeHook: review(
        null,
        "passed",
        "Runtime hook dispatched the runbook into the host tmux session through the bounded executor contract.",
        { jobId: job.id, backend: launch.backend, windowName: dispatch.windowName }
      ),
      postExecutionHook: review(
        null,
        "pending",
        "Post-exec verification is waiting for the operator or a future runtime callback to confirm the final outcome.",
        { jobId: job.id, tmuxSessionName: session.tmuxSessionName, windowName: dispatch.windowName }
      )
    });

    database.recordSessionActivity(session.id);

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.executed",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        executedJobId: job.id
      }
    });
    database.createAudit({
      actorId: actor.id,
      action: "runbook.dispatched",
      targetType: "runbook",
      targetId: runbook.id,
      details: {
        runbookId: runbook.id,
        sessionId: session.id,
        tmuxSessionName: session.tmuxSessionName,
        tmuxWindowName: dispatch.windowName
      }
    });

    return { plan: updatedPlan, job };
  }

  function executeAgentPlan(plan: ExecutionPlan, actor: UserSummary, agent: AgentManifest) {
    const session = plan.sessionId ? database.getSessionRuntimeTargetForActor(plan.sessionId, plan.requestedBy) : null;
    if (!session) {
      throw new Error("session not found for agent plan");
    }

    const prompt =
      typeof plan.normalizedInput.prompt === "string"
        ? plan.normalizedInput.prompt
        : "Inspect the current maintenance context and report back.";
    const command = buildAgentCommand(config.repoRoot, agent, prompt);
    const launch = tmux.launchCommand(session.tmuxSessionName, slugify(`agent-${agent.id}`), command);
    const job = database.createJob({
      sessionId: session.id,
      kind: "agent",
      subjectId: agent.id,
      status: "completed",
      requiresApproval: false,
      output: {
        ...agentOutput(agent, prompt, launch.started, launch.note),
        planId: plan.id,
        planHash: plan.planHash
      },
      completedAt: new Date().toISOString()
    });

    const updatedPlan = database.updateExecutionPlan(plan.id, {
      status: "executed",
      executedJobId: job.id,
      runtimeHook: review(
        null,
        "passed",
        "Runtime hook observed the bounded local agent launch complete through the tmux adapter contract.",
        { jobId: job.id, started: launch.started, backend: launch.backend }
      ),
      postExecutionHook: review(
        null,
        "passed",
        "Post-exec hook captured the launch outcome and preserved the audit trail for operator takeover.",
        { jobId: job.id }
      )
    });

    database.recordSessionActivity(session.id);
    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.executed",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        executedJobId: job.id
      }
    });
    database.createAudit({
      actorId: actor.id,
      action: "agent.launched",
      targetType: "agent",
      targetId: agent.id,
      details: {
        sessionId: session.id,
        tmuxBackend: launch.backend,
        planId: plan.id
      }
    });

    return { plan: updatedPlan, job };
  }

  database.initialize();
  database.seedAdmin(config.adminUsername, config.adminPassword);
  for (const user of options.bootstrapUsers || []) {
    database.createUser(user.username, user.password, user.role || "admin");
  }

  const app = Fastify({ logger: false }) as FastifyInstance & {
    processDueScheduledRunbooks?: () => Promise<void>;
  };

  const schedulerInterval = setInterval(() => {
    void processDueScheduledRunbooks();
  }, 30_000);

  app.processDueScheduledRunbooks = processDueScheduledRunbooks;

  app.addHook("onClose", async () => {
    clearInterval(schedulerInterval);
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

    return { sessions: database.listSessionsForActor(actor.id) };
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
    let session;
    try {
      session = database.upsertSession({
        name: sessionSlug,
        ownerId: actor.id,
        tmuxSessionName,
        tmuxBackend: ensured.backend,
        terminalUrl: null
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("another operator")) {
        return reply.code(409).send({ message: "session name already belongs to another operator" });
      }

      throw error;
    }
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
    const session = database.getSessionByIdForActor(sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    return {
      session,
      plans: database.listExecutionPlansForSession(sessionId),
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

  app.get("/api/schedules", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { schedules: database.listScheduledRunbooksForActor(actor.id) };
  });

  app.post("/api/schedules", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const body = (request.body || {}) as {
      runbookId?: string;
      sessionId?: string;
      weekday?: number;
      timeUtc?: string;
      mode?: ScheduledRunbookMode;
    };

    if (!body.runbookId || !body.sessionId || !validateWeekday(body.weekday) || !validateTimeUtc(body.timeUtc)) {
      return reply.code(400).send({ message: "runbookId, sessionId, weekday, and timeUtc are required" });
    }

    const requestedMode = body.mode || "scheduled-plan-only";
    if (requestedMode !== "scheduled-plan-only" && requestedMode !== "scheduled-auto") {
      return reply.code(400).send({ message: "mode must be scheduled-plan-only or scheduled-auto" });
    }

    const runbook = findRunbook(body.runbookId);
    if (!runbook) {
      return reply.code(404).send({ message: "runbook not found" });
    }

    if (requestedMode === "scheduled-auto" && isHighRiskRunbook(runbook)) {
      return reply.code(400).send({ message: "high-risk runbooks can only use scheduled-plan-only" });
    }

    const session = database.getSessionByIdForActor(body.sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const schedule = database.createScheduledRunbook({
      ownerId: actor.id,
      runbookId: runbook.id,
      sessionId: session.id,
      weekday: body.weekday,
      timeUtc: body.timeUtc,
      timezone: "UTC",
      requestedMode,
      effectiveMode: requestedMode,
      status: "draft",
      runbookVersionHash: computeRunbookVersionHash(runbook),
      nextRunAt: computeNextWeeklyRunAt(body.weekday, body.timeUtc)
    });

    database.createAudit({
      actorId: actor.id,
      action: "schedule.created",
      targetType: "scheduled-runbook",
      targetId: schedule.id,
      details: {
        runbookId: schedule.runbookId,
        sessionId: schedule.sessionId,
        requestedMode: schedule.requestedMode,
        nextRunAt: schedule.nextRunAt
      }
    });

    return reply.code(201).send({ schedule });
  });

  app.post("/api/schedules/:scheduleId/activate", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = database.getScheduledRunbookForActor(scheduleId, actor.id);
    if (!schedule) {
      return reply.code(404).send({ message: "schedule not found" });
    }

    const runbook = findRunbook(schedule.runbookId);
    const session = database.getSessionByIdForActor(schedule.sessionId, actor.id);
    if (!runbook || !session) {
      return reply.code(409).send({ message: "schedule target no longer resolves" });
    }

    const runbookVersionHash = computeRunbookVersionHash(runbook);
    const activated = database.updateScheduledRunbook(schedule.id, {
      status: "active",
      runbookVersionHash,
      nextRunAt: computeNextWeeklyRunAt(schedule.weekday, schedule.timeUtc)
    });

    database.createAudit({
      actorId: actor.id,
      action: "schedule.activated",
      targetType: "scheduled-runbook",
      targetId: activated.id,
      details: {
        effectiveMode: activated.effectiveMode,
        nextRunAt: activated.nextRunAt,
        runbookVersionHash: activated.runbookVersionHash
      }
    });

    return { schedule: activated };
  });

  app.post("/api/schedules/:scheduleId/pause", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = database.getScheduledRunbookForActor(scheduleId, actor.id);
    if (!schedule) {
      return reply.code(404).send({ message: "schedule not found" });
    }

    const paused = database.updateScheduledRunbook(schedule.id, {
      status: "paused"
    });

    database.createAudit({
      actorId: actor.id,
      action: "schedule.paused",
      targetType: "scheduled-runbook",
      targetId: paused.id,
      details: {
        effectiveMode: paused.effectiveMode
      }
    });

    return { schedule: paused };
  });

  app.get("/api/scripts", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { scripts };
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
    if (!body.sessionId) {
      return reply.code(400).send({ message: "sessionId is required" });
    }
    const session = body.sessionId ? database.getSessionByIdForActor(body.sessionId, actor.id) : null;

    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const plan = createRunbookPlan(actor, runbook, session);

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.created",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        sessionId: session?.id || null,
        riskClass: plan.riskClass
      }
    });

    if (runbook.requiresApproval) {
      return reply.code(202).send(
        createPendingApprovalForPlan(
          plan,
          actor,
          `${runbook.name} requires explicit approval before dispatching the bounded host helper.`
        )
      );
    }

    const executed = executeRunbookPlan(plan, actor, runbook);
    return reply.code(201).send(executed);
  });

  app.get("/api/approvals", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { status } = (request.query || {}) as { status?: "pending" | "approved" | "rejected" };
    return { approvals: database.listApprovalsForActor(actor.id, status) };
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

    if (approval.requestedBy !== actor.id) {
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

    database.createAudit({
      actorId: actor.id,
      action: "approval.decided",
      targetType: "approval",
      targetId: updatedApproval.id,
      details: {
        decision: updatedApproval.status,
        jobId: updatedApproval.jobId,
        planHash: job.subjectId && job.kind === "execution.plan" ? database.getExecutionPlan(job.subjectId)?.planHash || null : null
      }
    });

    if (job.kind === "execution.plan") {
      const plan = job.subjectId ? database.getExecutionPlan(job.subjectId) : null;
      if (!plan) {
        return reply.code(500).send({ message: "execution plan not found" });
      }

      if (body.decision === "approved") {
        const recomputedHash = recomputePlanHash(plan);
        if (recomputedHash !== plan.planHash) {
          const blockedPlan = database.updateExecutionPlan(plan.id, {
            status: "blocked",
            preExecutionHook: review(
              null,
              "blocked",
              "Pre-exec hook detected a plan hash mismatch and refused to dispatch the approved action.",
              {
                expectedPlanHash: recomputedHash,
                planHash: plan.planHash
              }
            )
          });
          const blockedJob = database.updateJob(job.id, {
            status: "failed",
            approvalId: updatedApproval.id,
            completedAt: new Date().toISOString(),
            output: {
              ...planJobOutput(blockedPlan, "Execution plan integrity check failed before dispatch."),
              approvalDecision: "approved",
              integrityError: "plan hash mismatch"
            }
          });

          return reply.code(409).send({
            message: "plan integrity check failed",
            approval: updatedApproval,
            plan: blockedPlan,
            job: blockedJob
          });
        }

        if (plan.targetType === "runbook") {
          const runbook = findRunbook(plan.targetId);
          if (!runbook) {
            return reply.code(500).send({ message: "runbook not found for approved plan" });
          }

          const executed = executeRunbookPlan(
            database.updateExecutionPlan(plan.id, {
              approvalId: updatedApproval.id,
              preExecutionHook: review(
                null,
                "passed",
                "Pre-exec hook revalidated the exact approved plan hash immediately before dispatch.",
                { planHash: plan.planHash }
              )
            }),
            actor,
            runbook
          );
          const planJob = database.updateJob(job.id, {
            status: "completed",
            approvalId: updatedApproval.id,
            completedAt: new Date().toISOString(),
            output: {
              ...planJobOutput(executed.plan, "Execution plan approved and dispatched into the host tmux executor."),
              approvalDecision: "approved",
              executedJobId: executed.job.id
            }
          });

          return { approval: updatedApproval, plan: executed.plan, job: executed.job, planJob };
        }

        const agent = findAgent(plan.targetId);
        if (!agent) {
          return reply.code(500).send({ message: "agent not found for approved plan" });
        }

        const executed = executeAgentPlan(
          database.updateExecutionPlan(plan.id, {
            approvalId: updatedApproval.id,
            preExecutionHook: review(
              null,
              "passed",
              "Pre-exec hook revalidated the exact approved plan hash immediately before dispatch.",
              { planHash: plan.planHash }
            )
          }),
          actor,
          agent
        );
        const planJob = database.updateJob(job.id, {
          status: "completed",
          approvalId: updatedApproval.id,
          completedAt: new Date().toISOString(),
          output: {
            ...planJobOutput(executed.plan, "Execution plan approved and dispatched."),
            approvalDecision: "approved",
            executedJobId: executed.job.id
          }
        });

        return { approval: updatedApproval, plan: executed.plan, job: executed.job, planJob };
      }

      const rejectedPlan = database.updateExecutionPlan(plan.id, {
        status: "rejected",
        approvalId: updatedApproval.id,
        postExecutionHook: review(
          null,
          "blocked",
          "Post-exec hook recorded a human rejection before any bounded executor was allowed to run.",
          { approvalId: updatedApproval.id }
        )
      });
      const rejectedJob = database.updateJob(job.id, {
        status: "rejected",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...planJobOutput(rejectedPlan, "Execution plan rejected before dispatch."),
          approvalDecision: "rejected"
        }
      });

      return { approval: updatedApproval, plan: rejectedPlan, job: rejectedJob };
    }

    let updatedJob;
    if (body.decision === "approved") {
      updatedJob = database.updateJob(job.id, {
        status: "completed",
        approvalId: updatedApproval.id,
        completedAt: new Date().toISOString(),
        output: {
          ...(job.output || {}),
          summary: "Execution was approved and dispatched.",
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

    return { approval: updatedApproval, job: updatedJob };
  });

  app.get("/api/agents", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return { agents };
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

    const session = database.getSessionRuntimeTargetForActor(body.sessionId, actor.id);
    if (!session) {
      return reply.code(404).send({ message: "session not found" });
    }

    const plan = createAgentPlan(actor, agent, session.id, body.prompt);

    database.createAudit({
      actorId: actor.id,
      action: "execution.plan.created",
      targetType: "execution-plan",
      targetId: plan.id,
      details: {
        targetType: plan.targetType,
        targetId: plan.targetId,
        sessionId: session.id,
        riskClass: plan.riskClass
      }
    });

    if (agent.requiresApproval) {
      const pendingJob = database.createJob({
        sessionId: session.id,
        kind: "execution.plan",
        subjectId: plan.id,
        status: "pending_approval",
        requiresApproval: true,
        output: planJobOutput(plan, `${agent.name} is waiting for human approval before launch.`)
      });
      const approval = database.createApproval({
        jobId: pendingJob.id,
        requestedBy: actor.id,
        reason: `${agent.name} requires explicit approval before launch.`
      });
      const job = database.updateJob(pendingJob.id, {
        status: "pending_approval",
        approvalId: approval.id,
        output: planJobOutput(plan, `${agent.name} is waiting for human approval before launch.`)
      });
      const updatedPlan = database.updateExecutionPlan(plan.id, {
        approvalId: approval.id,
        status: "pending_approval"
      });

      return reply.code(202).send({ plan: updatedPlan, job, approval });
    }

    const executed = executeAgentPlan(plan, actor, agent);
    return reply.code(201).send(executed);
  });

  app.get("/api/audits", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    const { limit } = (request.query || {}) as { limit?: string };
    return { audits: database.listAuditsForActor(actor.id, Number(limit || "50")) };
  });

  app.get("/api/dashboard", async (request, reply) => {
    const actor = await requireActor(request, reply, database);
    if (!actor) {
      return;
    }

    return {
      user: actor,
      sessions: database.listSessionsForActor(actor.id),
      runbooks: RUNBOOKS,
      schedules: database.listScheduledRunbooksForActor(actor.id),
      scripts,
      agents,
      approvals: database.listApprovalsForActor(actor.id, "pending"),
      audits: database.listAuditsForActor(actor.id, 20)
    };
  });

  return app;
}

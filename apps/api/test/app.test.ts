import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { SafetyReviewRunner } from "../src/safety-review.js";

type TestApp = Awaited<ReturnType<typeof createApp>>;

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiHost: "127.0.0.1",
    apiPort: 3001,
    dbPath: ":memory:",
    adminUsername: "admin",
    adminPassword: "test-password",
    sessionTtlHours: 12,
    cookieSecure: false,
    tmuxMode: "disabled",
    ttydBaseUrl: null,
    terminalSigningSecret: "test-terminal-secret",
    repoRoot: process.cwd(),
    plannerRuntime: "demo-local",
    copilotExecutable: "copilot",
    copilotModel: null,
    nodeEnv: "development",
    ...overrides
  };
}

async function createTestApp(
  openApps: TestApp[],
  overrides: Partial<AppConfig> = {},
  options: {
    bootstrapUsers?: Array<{ username: string; password: string; role?: "admin" }>;
    safetyReviewRunner?: SafetyReviewRunner;
  } = {}
): Promise<TestApp> {
  const app = await createApp({
    config: buildConfig(overrides),
    bootstrapUsers: options.bootstrapUsers,
    safetyReviewRunner: options.safetyReviewRunner
  });
  openApps.push(app);
  return app;
}

async function login(app: TestApp, password = "test-password") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      username: "admin",
      password
    }
  });

  const cookie = response.headers["set-cookie"];
  expect(cookie).toContain("cockpit_session=");
  return cookie;
}

async function loginAs(app: TestApp, username: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      username,
      password
    }
  });

  const cookie = response.headers["set-cookie"];
  expect(cookie).toContain("cockpit_session=");
  return cookie;
}

async function createSession(app: TestApp, cookie: string | string[], name = "Incident Debug") {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie },
    payload: { name }
  });

  expect(response.statusCode).toBe(201);
  return response.json().session as {
    id: string;
    name: string;
    tmuxBackend: string;
    terminal: { terminalUrl: string | null; note: string };
  };
}

function createTempDbPath(tempDirectories: string[]) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-api-test-"));
  tempDirectories.push(tempDirectory);
  return path.join(tempDirectory, "cockpit.sqlite");
}

describe("control API", () => {
  const openApps: TestApp[] = [];
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
    tempDirectories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  });

  it("requires authentication for protected endpoints", async () => {
    const app = await createTestApp(openApps);

    const response = await app.inject({
      method: "GET",
      url: "/api/me"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "authentication required" });
  });

  it("supports a login and logout cycle", async () => {
    const app = await createTestApp(openApps);

    const cookie = await login(app);
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("admin");

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie }
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rate limits repeated failed login attempts", async () => {
    const app = await createTestApp(openApps);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          username: "admin",
          password: "wrong-password"
        }
      });

      expect(response.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "wrong-password"
      }
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ message: "too many login attempts, try again later" });
  });

  it("creates sessions and records audit output", async () => {
    const app = await createTestApp(openApps);

    const cookie = await login(app);

    const created = {
      session: await createSession(app, cookie)
    };
    expect(created.session.name).toBe("incident-debug");
    expect(created.session.tmuxBackend).toBe("disabled");

    const audits = await app.inject({
      method: "GET",
      url: "/api/audits",
      headers: { cookie }
    });

    expect(audits.statusCode).toBe(200);
    expect(audits.json().audits.some((entry: { action: string }) => entry.action === "session.ensure")).toBe(
      true
    );
  });

  it("rejects empty session names", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
      payload: { name: "!!!" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "session name must include letters or numbers" });
  });

  it("configures terminal links when a ttyd base url exists", async () => {
    const app = await createTestApp(openApps, {
      ttydBaseUrl: "https://ttyd.example/bridge/"
    });
    const cookie = await login(app);

    const session = await createSession(app, cookie, "Terminal Attach");
    expect(session.terminal.terminalUrl).toContain("https://ttyd.example/bridge/");
    expect(session.terminal.terminalUrl).toContain("?arg=");
    expect(session.terminal.note).toContain("Browser terminal attachment");
  });

  it("returns dashboard data for authenticated users", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    await createSession(app, cookie, "Dashboard Session");

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { username: "admin" },
      sessions: [{ name: "dashboard-session" }],
      runbooks: expect.any(Array),
      schedules: expect.any(Array),
      scripts: expect.any(Array),
      agents: expect.any(Array),
      approvals: expect.any(Array),
      audits: expect.any(Array)
    });
  });

  it("creates and activates weekly schedules for low-risk runbooks", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Scheduled Disk Check");

    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { cookie },
      payload: {
        runbookId: "disk-health-check",
        sessionId: session.id,
        weekday: 5,
        timeUtc: "18:00",
        mode: "scheduled-auto"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().schedule).toMatchObject({
      runbookId: "disk-health-check",
      sessionId: session.id,
      requestedMode: "scheduled-auto",
      effectiveMode: "scheduled-auto",
      status: "draft"
    });

    const activated = await app.inject({
      method: "POST",
      url: `/api/schedules/${created.json().schedule.id}/activate`,
      headers: { cookie }
    });

    expect(activated.statusCode).toBe(200);
    expect(activated.json().schedule.status).toBe("active");
  });

  it("blocks scheduled-auto for high-risk runbooks", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Scheduled Upgrade Review");

    const response = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { cookie },
      payload: {
        runbookId: "nextcloud-update-plan",
        sessionId: session.id,
        weekday: 5,
        timeUtc: "18:00",
        mode: "scheduled-auto"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "high-risk runbooks can only use scheduled-plan-only" });
  });

  it("processes due low-risk schedules through the bounded executor path", async () => {
    const dbPath = createTempDbPath(tempDirectories);
    const app = await createTestApp(openApps, { dbPath });
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Automated Disk Check");

    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      headers: { cookie },
      payload: {
        runbookId: "disk-health-check",
        sessionId: session.id,
        weekday: 5,
        timeUtc: "18:00",
        mode: "scheduled-auto"
      }
    });
    const scheduleId = created.json().schedule.id as string;

    await app.inject({
      method: "POST",
      url: `/api/schedules/${scheduleId}/activate`,
      headers: { cookie }
    });

    const database = new BetterSqlite3(dbPath);
    database.prepare("UPDATE scheduled_runbooks SET next_run_at = ? WHERE id = ?").run("2026-04-01T00:00:00.000Z", scheduleId);
    database.close();

    await (app as unknown as { processDueScheduledRunbooks: () => Promise<void> }).processDueScheduledRunbooks();

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: { cookie }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().plans[0]).toMatchObject({
      targetType: "runbook",
      targetId: "disk-health-check",
      status: "executed"
    });
    expect(detail.json().jobs.some((job: { kind: string; subjectId: string }) => job.kind === "runbook" && job.subjectId === "disk-health-check")).toBe(true);

    const schedules = await app.inject({
      method: "GET",
      url: "/api/schedules",
      headers: { cookie }
    });
    expect(schedules.statusCode).toBe(200);
    expect(schedules.json().schedules[0].lastRunAt).not.toBeNull();
  });

  it("returns reviewable runbook and script definitions", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);

    const runbooks = await app.inject({
      method: "GET",
      url: "/api/runbooks",
      headers: { cookie }
    });
    const scripts = await app.inject({
      method: "GET",
      url: "/api/scripts",
      headers: { cookie }
    });

    expect(runbooks.statusCode).toBe(200);
    expect(runbooks.json().runbooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "disk-health-check",
          reviewStatus: "allowlisted",
          scriptIds: ["script-disk-health-check"]
        }),
        expect.objectContaining({
          id: "nextcloud-rollback-restore",
          reviewStatus: "allowlisted",
          scriptIds: ["script-nextcloud-rollback-restore"]
        })
      ])
    );
    expect(scripts.statusCode).toBe(200);
    expect(scripts.json().scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "script-disk-health-check",
          sourcePath: "bin/disk-health-check.sh"
        }),
        expect.objectContaining({
          id: "script-nextcloud-rollback-verify",
          sourcePath: "bin/nextcloud-rollback-verify.sh"
        })
      ])
    );
  });

  it("executes safe runbooks immediately when approval is not required", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Disk Check");

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks/disk-health-check/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().plan).toMatchObject({
      targetType: "runbook",
      targetId: "disk-health-check",
      status: "executed",
      riskClass: "low"
    });
    expect(response.json().job).toMatchObject({
      kind: "runbook",
      status: "running",
      requiresApproval: false
    });
    expect(response.json().job.output.summary).toContain("dispatched to the host tmux executor");

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: { cookie }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().plans[0]).toMatchObject({
      targetType: "runbook",
      targetId: "disk-health-check",
      status: "executed"
    });
  });

  it("gates privileged-marked runbooks behind approvals", async () => {
    const app = await createTestApp(openApps);

    const cookie = await login(app);
    const session = await createSession(app, cookie, "Nextcloud Upgrade");

    const runbook = await app.inject({
      method: "POST",
      url: "/api/runbooks/nextcloud-update-plan/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });

    expect(runbook.statusCode).toBe(202);
    expect(runbook.json().plan.status).toBe("pending_approval");
    expect(runbook.json().job.status).toBe("pending_approval");

    const approval = runbook.json().approval;
    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "reviewed" }
    });

    expect(decision.statusCode).toBe(200);
    expect(decision.json().plan.status).toBe("executed");
    expect(decision.json().job.status).toBe("running");
    expect(decision.json().approval.status).toBe("approved");
  });

  it("gates rollback restore behind approvals", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Nextcloud Rollback");

    const runbook = await app.inject({
      method: "POST",
      url: "/api/runbooks/nextcloud-rollback-restore/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });

    expect(runbook.statusCode).toBe(202);
    expect(runbook.json().plan).toMatchObject({
      targetType: "runbook",
      targetId: "nextcloud-rollback-restore",
      status: "pending_approval",
      riskClass: "high"
    });
    expect(runbook.json().job.status).toBe("pending_approval");

    const approval = runbook.json().approval;
    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "reviewed rollback manifest" }
    });

    expect(decision.statusCode).toBe(200);
    expect(decision.json().plan).toMatchObject({
      targetId: "nextcloud-rollback-restore",
      status: "executed"
    });
    expect(decision.json().job.status).toBe("running");
    expect(decision.json().approval.status).toBe("approved");
  });

  it("blocks approval dispatch when the stored plan hash no longer matches the approved payload", async () => {
    const dbPath = createTempDbPath(tempDirectories);
    const app = await createTestApp(openApps, { dbPath });
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Integrity Review");

    const queued = await app.inject({
      method: "POST",
      url: "/api/runbooks/nextcloud-update-plan/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });

    expect(queued.statusCode).toBe(202);

    const approvalId = queued.json().approval.id as string;
    const planId = queued.json().plan.id as string;
    const database = new BetterSqlite3(dbPath);
    database.prepare("UPDATE execution_plans SET plan_hash = ? WHERE id = ?").run("tampered-plan-hash", planId);
    database.close();

    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "reviewed" }
    });

    expect(decision.statusCode).toBe(409);
    expect(decision.json()).toMatchObject({
      message: "plan integrity check failed",
      approval: { id: approvalId, status: "approved" },
      plan: {
        id: planId,
        status: "blocked",
        preExecutionHook: { verdict: "blocked" }
      },
      job: {
        status: "failed",
        output: { integrityError: "plan hash mismatch" }
      }
    });
  });

  it("stores a reviewable safety report and can escalate a low-risk runbook to approval", async () => {
    const safetyReviewRunner: SafetyReviewRunner = async ({ runbookVersionHash }) => ({
      actorId: "safety-agent",
      verdict: "approval_required",
      summary: "Risk report requires human approval because the bounded helper could still delay operator visibility.",
      details: {
        schemaVersion: "runbook-safety-review/v1",
        source: "copilot-cli",
        parserVersion: "line-schema/v1",
        parseStatus: "ok",
        runbookId: "disk-health-check",
        runbookVersionHash,
        hazards: ["Disk pressure may hide backup headroom.", "Operator follow-up may still be required."],
        blastRadius: "single host",
        expectedImpact: "bounded diagnostics inside the selected task session",
        rollbackHint: "No rollback required for read-only diagnostics.",
        operatorChecks: ["Review the current disk usage snapshot."],
        inputHash: "input-hash",
        outputHash: "output-hash",
        exitCode: 0,
        model: "gpt-5.4"
      }
    });

    const app = await createTestApp(
      openApps,
      {
        plannerRuntime: "copilot-cli"
      },
      {
        safetyReviewRunner
      }
    );
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Risk Review");

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks/disk-health-check/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().plan).toMatchObject({
      targetType: "runbook",
      targetId: "disk-health-check",
      status: "pending_approval",
      requiresApproval: true,
      safetyReview: {
        verdict: "approval_required",
        summary: "Risk report requires human approval because the bounded helper could still delay operator visibility."
      }
    });
    expect(response.json().plan.normalizedInput.runbookVersionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.json().plan.safetyReview.details.hazards).toContain("Disk pressure may hide backup headroom.");

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: { cookie }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().plans[0]).toMatchObject({
      targetType: "runbook",
      targetId: "disk-health-check",
      status: "pending_approval",
      safetyReview: {
        verdict: "approval_required"
      }
    });
    expect(detail.json().plans[0].safetyReview.details.runbookVersionHash).toBe(
      response.json().plan.normalizedInput.runbookVersionHash
    );
  });

  it("blocks approval dispatch when the reviewed runbook version no longer matches the current allowlist", async () => {
    const dbPath = createTempDbPath(tempDirectories);
    const app = await createTestApp(openApps, { dbPath });
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Runbook Digest Review");

    const queued = await app.inject({
      method: "POST",
      url: "/api/runbooks/nextcloud-update-plan/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });

    expect(queued.statusCode).toBe(202);

    const approvalId = queued.json().approval.id as string;
    const planId = queued.json().plan.id as string;
    const database = new BetterSqlite3(dbPath);
    const storedPlan = database
      .prepare(
        "SELECT target_type, target_id, session_id, requested_by, risk_class, normalized_input_json FROM execution_plans WHERE id = ?"
      )
      .get(planId) as {
      target_type: string;
      target_id: string;
      session_id: string | null;
      requested_by: string;
      risk_class: string;
      normalized_input_json: string;
    };
    const normalizedInput = JSON.parse(storedPlan.normalized_input_json) as Record<string, unknown>;
    normalizedInput.runbookVersionHash = "tampered-runbook-hash";
    const planHash = createHash("sha256")
      .update(
        JSON.stringify({
          targetType: storedPlan.target_type,
          targetId: storedPlan.target_id,
          sessionId: storedPlan.session_id,
          requestedBy: storedPlan.requested_by,
          normalizedInput,
          riskClass: storedPlan.risk_class
        })
      )
      .digest("hex");
    database
      .prepare("UPDATE execution_plans SET normalized_input_json = ?, plan_hash = ? WHERE id = ?")
      .run(JSON.stringify(normalizedInput), planHash, planId);
    database.close();

    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "reviewed" }
    });

    expect(decision.statusCode).toBe(409);
    expect(decision.json()).toMatchObject({
      message: "runbook integrity check failed",
      approval: { id: approvalId, status: "approved" },
      plan: {
        id: planId,
        status: "blocked",
        preExecutionHook: { verdict: "blocked" }
      },
      job: {
        status: "failed",
        output: { integrityError: "runbook version hash mismatch" }
      }
    });
  });

  it("supports rejecting approvals and prevents double decisions", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Restart Review");

    const queued = await app.inject({
      method: "POST",
      url: "/api/runbooks/service-restart-request/execute",
      headers: { cookie },
      payload: { sessionId: session.id }
    });
    const approvalId = queued.json().approval.id as string;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: "rejected", reason: "unsafe right now" }
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().approval.status).toBe("rejected");
    expect(rejected.json().plan.status).toBe("rejected");
    expect(rejected.json().job.status).toBe("rejected");

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: "approved" }
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ message: "approval already decided" });
  });

  it("validates agent launches and records successful launch jobs", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);

    const missingSession = await app.inject({
      method: "POST",
      url: "/api/agents/planner-agent/launch",
      headers: { cookie },
      payload: { prompt: "inspect current state" }
    });
    expect(missingSession.statusCode).toBe(400);
    expect(missingSession.json()).toEqual({ message: "sessionId is required" });

    const session = await createSession(app, cookie, "Agent Debug");
    const launch = await app.inject({
      method: "POST",
      url: "/api/agents/planner-agent/launch",
      headers: { cookie },
      payload: {
        sessionId: session.id,
        prompt: "x".repeat(300)
      }
    });

    expect(launch.statusCode).toBe(201);
    expect(launch.json().plan).toMatchObject({
      targetType: "agent",
      targetId: "planner-agent",
      status: "executed",
      riskClass: "moderate"
    });
    expect(launch.json().job).toMatchObject({
      kind: "agent",
      status: "completed"
    });
    expect(launch.json().job.output.prompt).toHaveLength(240);
    expect(launch.json().job.output.note).toContain("disabled");
  });

  it("requires approval for the supervised repair agent and binds approval to the reviewed manifest", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Supervised Repair");

    const queued = await app.inject({
      method: "POST",
      url: "/api/agents/supervised-repair-agent/launch",
      headers: { cookie },
      payload: {
        sessionId: session.id,
        prompt: "Review the current Nextcloud maintenance blockers."
      }
    });

    expect(queued.statusCode).toBe(202);
    expect(queued.json().plan).toMatchObject({
      targetType: "agent",
      targetId: "supervised-repair-agent",
      status: "pending_approval",
      requiresApproval: true,
      riskClass: "high",
      normalizedInput: {
        promptContractId: "supervised-repair-v1",
        checkpointContractId: "supervised-repair-checkpoints-v1",
        supervisionMode: "session-observed",
        executionAuthority: "advisory-only"
      }
    });
    expect(queued.json().plan.normalizedInput.agentManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(queued.json().plan.normalizedInput.checkpointContractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(queued.json().plan.normalizedInput.checkpointContract).toHaveLength(3);

    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${queued.json().approval.id as string}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "launch the observed checkpoint actor" }
    });

    expect(decision.statusCode).toBe(200);
    expect(decision.json().plan.status).toBe("executed");
    expect(decision.json().job.status).toBe("completed");
    expect(decision.json().job.output).toMatchObject({
      promptContractId: "supervised-repair-v1",
      checkpointContractId: "supervised-repair-checkpoints-v1",
      supervisionMode: "session-observed"
    });
    expect(decision.json().job.output.checkpointContractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.json().job.output.activeCheckpointId).toBe("checkpoint-review-scope");
    expect(decision.json().job.output.checkpoints).toEqual([
      expect.objectContaining({ id: "checkpoint-review-scope", status: "awaiting_operator" }),
      expect.objectContaining({ id: "checkpoint-choose-follow-up", status: "planned" }),
      expect.objectContaining({ id: "checkpoint-verify-outcome", status: "planned" })
    ]);
  });

  it("advances structured checkpoints on launched supervised agent jobs", async () => {
    const app = await createTestApp(openApps);
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Checkpoint Advance");

    const queued = await app.inject({
      method: "POST",
      url: "/api/agents/supervised-repair-agent/launch",
      headers: { cookie },
      payload: {
        sessionId: session.id,
        prompt: "Review the current Nextcloud maintenance blockers."
      }
    });

    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${queued.json().approval.id as string}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "launch the observed checkpoint actor" }
    });

    const firstCheckpointId = decision.json().job.output.activeCheckpointId as string;
    const advanced = await app.inject({
      method: "POST",
      url: `/api/jobs/${decision.json().job.id as string}/checkpoints/${firstCheckpointId}/advance`,
      headers: { cookie }
    });

    expect(advanced.statusCode).toBe(200);
    expect(advanced.json().job.output).toMatchObject({
      activeCheckpointId: "checkpoint-choose-follow-up",
      lastCompletedCheckpointId: "checkpoint-review-scope",
      lastCompletedCheckpointLabel: "Review current bounded scope"
    });
    expect(advanced.json().job.output.checkpoints).toEqual([
      expect.objectContaining({ id: "checkpoint-review-scope", status: "completed" }),
      expect.objectContaining({ id: "checkpoint-choose-follow-up", status: "awaiting_operator" }),
      expect.objectContaining({ id: "checkpoint-verify-outcome", status: "planned" })
    ]);
  });

  it("blocks supervised agent launch approval when the reviewed manifest digest drifts", async () => {
    const dbPath = createTempDbPath(tempDirectories);
    const app = await createTestApp(openApps, { dbPath });
    const cookie = await login(app);
    const session = await createSession(app, cookie, "Supervised Agent Digest Review");

    const queued = await app.inject({
      method: "POST",
      url: "/api/agents/supervised-repair-agent/launch",
      headers: { cookie },
      payload: {
        sessionId: session.id,
        prompt: "Review the current Nextcloud maintenance blockers."
      }
    });

    expect(queued.statusCode).toBe(202);

    const approvalId = queued.json().approval.id as string;
    const planId = queued.json().plan.id as string;
    const database = new BetterSqlite3(dbPath);
    const storedPlan = database
      .prepare(
        "SELECT target_type, target_id, session_id, requested_by, risk_class, normalized_input_json FROM execution_plans WHERE id = ?"
      )
      .get(planId) as {
      target_type: string;
      target_id: string;
      session_id: string | null;
      requested_by: string;
      risk_class: string;
      normalized_input_json: string;
    };
    const normalizedInput = JSON.parse(storedPlan.normalized_input_json) as Record<string, unknown>;
    normalizedInput.agentManifestDigest = "tampered-agent-digest";
    const planHash = createHash("sha256")
      .update(
        JSON.stringify({
          targetType: storedPlan.target_type,
          targetId: storedPlan.target_id,
          sessionId: storedPlan.session_id,
          requestedBy: storedPlan.requested_by,
          normalizedInput,
          riskClass: storedPlan.risk_class
        })
      )
      .digest("hex");
    database
      .prepare("UPDATE execution_plans SET normalized_input_json = ?, plan_hash = ? WHERE id = ?")
      .run(JSON.stringify(normalizedInput), planHash, planId);
    database.close();

    const decision = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie },
      payload: { decision: "approved", reason: "launch the observed checkpoint actor" }
    });

    expect(decision.statusCode).toBe(409);
    expect(decision.json()).toMatchObject({
      message: "agent integrity check failed",
      approval: { id: approvalId, status: "approved" },
      plan: {
        id: planId,
        status: "blocked",
        preExecutionHook: { verdict: "blocked" }
      },
      job: {
        status: "failed",
        output: { integrityError: "agent manifest digest mismatch" }
      }
    });
  });

  it("scopes sessions, approvals and audits to the requesting actor", async () => {
    const app = await createTestApp(openApps, {}, {
      bootstrapUsers: [{ username: "operator-two", password: "operator-two-password" }]
    });
    const adminCookie = await login(app);
    const otherCookie = await loginAs(app, "operator-two", "operator-two-password");
    const adminSession = await createSession(app, adminCookie, "Private Session");

    const otherSessions = await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: otherCookie }
    });
    expect(otherSessions.statusCode).toBe(200);
    expect(otherSessions.json().sessions).toEqual([]);

    const missingSession = await app.inject({
      method: "GET",
      url: `/api/sessions/${adminSession.id}`,
      headers: { cookie: otherCookie }
    });
    expect(missingSession.statusCode).toBe(404);

    const queued = await app.inject({
      method: "POST",
      url: "/api/runbooks/nextcloud-update-plan/execute",
      headers: { cookie: adminCookie },
      payload: { sessionId: adminSession.id }
    });
    const approvalId = queued.json().approval.id as string;

    const otherApprovals = await app.inject({
      method: "GET",
      url: "/api/approvals?status=pending",
      headers: { cookie: otherCookie }
    });
    expect(otherApprovals.statusCode).toBe(200);
    expect(otherApprovals.json().approvals).toEqual([]);

    const forbiddenDecision = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie: otherCookie },
      payload: { decision: "approved" }
    });
    expect(forbiddenDecision.statusCode).toBe(404);

    const otherAudits = await app.inject({
      method: "GET",
      url: "/api/audits?limit=20",
      headers: { cookie: otherCookie }
    });
    expect(otherAudits.statusCode).toBe(200);
    expect(otherAudits.json().audits.some((entry: { action: string }) => entry.action === "session.ensure")).toBe(
      false
    );
  });
});

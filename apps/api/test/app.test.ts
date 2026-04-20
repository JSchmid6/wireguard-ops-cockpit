import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

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
    nodeEnv: "development",
    ...overrides
  };
}

async function createTestApp(
  openApps: TestApp[],
  overrides: Partial<AppConfig> = {},
  options: { bootstrapUsers?: Array<{ username: string; password: string; role?: "admin" }> } = {}
): Promise<TestApp> {
  const app = await createApp({
    config: buildConfig(overrides),
    bootstrapUsers: options.bootstrapUsers
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
      agents: expect.any(Array),
      approvals: expect.any(Array),
      audits: expect.any(Array)
    });
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// Zurueckziehen: James nimmt eine eigene Bestellung zurueck, solange auf dem Host
// nichts gelaufen ist. Der sicherheitskritische Kern: Zurueckziehen ist keine
// Entscheidung ueber einen Plan -- nie ein fremder Job, nie ein laufender, fertiger
// oder entschiedener, und die Freigabe-Route bleibt fuer jedes Token verschlossen.

type TestApp = Awaited<ReturnType<typeof createApp>>;
const openApps: TestApp[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openApps.length) await openApps.pop()!.close();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function config(dbPath: string): AppConfig {
  return {
    apiHost: "127.0.0.1", apiPort: 3001, dbPath, adminUsername: "admin", adminPassword: "test-password",
    sessionTtlHours: 12, cookieSecure: false, tmuxMode: "disabled", ttydBaseUrl: null,
    terminalSigningSecret: "test-terminal-secret", executionEnvelopeSecret: "test-envelope-secret",
    repoRoot: process.cwd(), plannerRuntime: "demo-local", copilotExecutable: "copilot", copilotModel: null,
    opencodeExecutable: "opencode", opencodeModel: null, safetyOpencodeModel: null, requireModelDiversity: false,
    approvalTtlMinutes: 30, maxFailedChangesPerHour: 3, agentBrokerSocket: null, executorBrokerSocket: null,
    executorBrokerSecret: null, nodeEnv: "development", webUrl: "https://cockpit.example",
  };
}

const intent = "Pakete auf dem VPS aktualisieren.";

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "withdraw-api-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "cockpit.sqlite");
  const app = await createApp({
    config: config(dbPath),
    bootstrapUsers: [{ username: "hermes-automation", password: "unusable-random-password", role: "automation" }],
  });
  openApps.push(app);
  const database = new CockpitDatabase(dbPath);
  database.initialize();
  const admin = database.authenticateUser("admin", "test-password")!;
  const automation = database.authenticateUser("hermes-automation", "unusable-random-password")!;
  // Auch mit dem Scope der Freigabe-Route kann James nicht freigeben oder ablehnen.
  const token = database.rotateApiToken(automation.id, "hermes", [
    "GET /api/hermes/jobs/:jobId", "POST /api/hermes/jobs/:jobId/withdraw", "POST /api/hermes/jobs/:jobId/approval",
  ]);
  const other = database.createUser("other-automation", "unusable-random-password", "automation");
  const otherToken = database.rotateApiToken(other.id, "other", ["POST /api/hermes/jobs/:jobId/withdraw"]);
  const unscopedToken = database.rotateApiToken(other.id, "unscoped", ["GET /api/hermes/jobs/:jobId"]);
  const jamesSession = database.upsertSession({ name: "hermes-rb", ownerId: automation.id, tmuxSessionName: "cockpit-hermes-rb", tmuxBackend: "tmux", terminalUrl: null });
  const adminSession = database.upsertSession({ name: "admin-own", ownerId: admin.id, tmuxSessionName: "cockpit-admin-own", tmuxBackend: "tmux", terminalUrl: null });
  const make = (sessionId: string, status: string, phase: string, extra: Record<string, unknown> = {}, subjectId = "hermes-change") => {
    const created = database.createJob({ sessionId, kind: "runbook", subjectId, status: status as "running", requiresApproval: false, output: {} });
    return database.updateJob(created.id, {
      status: status as "running",
      output: { explanation: { intent, phase, completed: ["Planner proposal"] }, plan: "plan", ...extra },
      completedAt: null,
    });
  };
  const jobs = {
    waiting: make(jamesSession.id, "blocked_user_approval", "finished"),
    policy: make(jamesSession.id, "blocked_policy", "finished"),
    prerequisite: make(jamesSession.id, "blocked_prerequisite", "finished"),
    planning: make(jamesSession.id, "running", "planning"),
    research: make(jamesSession.id, "running", "planning", {}, "hermes-research"),
    executing: make(jamesSession.id, "running", "executing"),
    hostRunStarted: make(jamesSession.id, "blocked_user_approval", "finished", { hostRunRequestedAt: "2026-10-18T10:00:00.000Z" }),
    approved: make(jamesSession.id, "blocked_user_approval", "finished", { approval: { decision: "approved" } }),
    completed: make(jamesSession.id, "completed", "finished"),
    rejected: make(jamesSession.id, "rejected", "finished"),
    failed: make(jamesSession.id, "failed_execution", "finished"),
    finding: make(jamesSession.id, "blocked_policy", "finished", { updateReview: { result: "finding", findings: [{ title: "Riegel offen", guarantee: "D3", file: "x.ts" }] } }),
    foreign: make(adminSession.id, "blocked_user_approval", "finished"),
  };
  database.close();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
  const inspect = () => { const db = new CockpitDatabase(dbPath); db.initialize(); return db; };
  const withdraw = (jobId: string, headers: Record<string, string>, payload: Record<string, unknown> = { reason: "Karte erledigt" }) =>
    app.inject({ method: "POST", url: `/api/hermes/jobs/${jobId}/withdraw`, headers, payload });
  return {
    app, jobs, inspect, withdraw,
    admin: { cookie: String(login.headers["set-cookie"]).split(";")[0] },
    james: { authorization: `Bearer ${token}` },
    other: { authorization: `Bearer ${otherToken}` },
    unscoped: { authorization: `Bearer ${unscopedToken}` },
  };
}

describe("POST /api/hermes/jobs/:jobId/withdraw", () => {
  it("withdraws James' own waiting job: status withdrawn, reason recorded, audited", async () => {
    const { jobs, withdraw, james, inspect } = await setup();
    const response = await withdraw(jobs.waiting.id, james, { reason: "  Karte t_x erledigt, neu bestellt  " });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.status).toBe("withdrawn");
    const db = inspect();
    const job = db.getJob(jobs.waiting.id)!;
    expect(job.status).toBe("withdrawn");
    expect(job.completedAt).not.toBeNull();
    expect(job.output!.withdrawal).toMatchObject({ actorName: "hermes-automation", reason: "Karte t_x erledigt, neu bestellt", previousStatus: "blocked_user_approval" });
    expect(job.output!.explanation).toMatchObject({ phase: "finished", reason: "Withdrawn by its orderer: Karte t_x erledigt, neu bestellt" });
    expect(job.output!.approval).toBeUndefined();
    expect(job.output!.plan).toBe("plan");
    const audit = db.listAudits(50).find((entry) => entry.action === "hermes.job.withdrawn" && entry.targetId === jobs.waiting.id);
    expect(audit?.details).toMatchObject({ reason: "Karte t_x erledigt, neu bestellt", previousStatus: "blocked_user_approval" });
    // Kein Fehlschlag: zaehlt nicht zum Circuit Breaker, keine Entscheidung.
    expect(db.hasAudit("hermes.change.failed", jobs.waiting.id)).toBe(false);
    expect(db.hasAudit("hermes.change.rejected", jobs.waiting.id)).toBe(false);
    db.close();
  });

  it("withdraws a job stuck at policy or a prerequisite, and one still planning", async () => {
    const { jobs, withdraw, james, inspect } = await setup();
    for (const job of [jobs.policy, jobs.prerequisite, jobs.planning, jobs.research]) {
      expect((await withdraw(job.id, james)).statusCode).toBe(200);
    }
    const db = inspect();
    expect(db.getJob(jobs.planning.id)!.output!.withdrawal).toMatchObject({ previousStatus: "running", previousPhase: "planning" });
    expect(db.getJob(jobs.research.id)!.status).toBe("withdrawn");
    db.close();
  });

  it("refuses a foreign job with 403 and leaves it untouched", async () => {
    const { jobs, withdraw, james, other, inspect } = await setup();
    expect((await withdraw(jobs.foreign.id, james)).statusCode).toBe(403);
    expect((await withdraw(jobs.waiting.id, other)).statusCode).toBe(403);
    const db = inspect();
    expect(db.getJob(jobs.foreign.id)!.status).toBe("blocked_user_approval");
    expect(db.getJob(jobs.waiting.id)!.status).toBe("blocked_user_approval");
    expect(db.hasAudit("hermes.job.withdraw_refused", jobs.foreign.id)).toBe(true);
    db.close();
  });

  it("refuses executing, started, decided and finished jobs with 403", async () => {
    const { jobs, withdraw, james, inspect } = await setup();
    const refused = [jobs.executing, jobs.hostRunStarted, jobs.approved, jobs.completed, jobs.rejected, jobs.failed];
    for (const job of refused) {
      const response = await withdraw(job.id, james);
      expect(response.statusCode, job.status).toBe(403);
    }
    const db = inspect();
    for (const job of refused) expect(db.getJob(job.id)!.status).toBe(job.status);
    db.close();
  });

  it("keeps a real review finding in the inbox after James withdrew the job", async () => {
    const { app, jobs, withdraw, james, admin } = await setup();
    expect((await withdraw(jobs.finding.id, james)).statusCode).toBe(200);
    const inbox = await app.inject({ method: "GET", url: "/api/inbox", headers: admin });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().reviewFindings).toEqual([expect.objectContaining({ jobId: jobs.finding.id, status: "withdrawn", findings: [expect.objectContaining({ title: "Riegel offen" })] })]);
  });

  it("withdraws only once: a withdrawn job is final", async () => {
    const { jobs, withdraw, james } = await setup();
    expect((await withdraw(jobs.waiting.id, james)).statusCode).toBe(200);
    expect((await withdraw(jobs.waiting.id, james)).statusCode).toBe(403);
  });

  it("needs a reason, the scope and the automation role; unknown jobs are 404", async () => {
    const { jobs, withdraw, james, unscoped, admin, inspect } = await setup();
    expect((await withdraw(jobs.waiting.id, james, {})).statusCode).toBe(400);
    expect((await withdraw(jobs.waiting.id, james, { reason: "   " })).statusCode).toBe(400);
    expect((await withdraw(jobs.waiting.id, unscoped)).statusCode).toBe(403);
    // Jochen lehnt ab (Freigabe-Route); Zurueckziehen ist die Route des Bestellers.
    expect((await withdraw(jobs.waiting.id, admin)).statusCode).toBe(403);
    expect((await withdraw("00000000-0000-0000-0000-000000000000", james)).statusCode).toBe(404);
    const db = inspect();
    expect(db.getJob(jobs.waiting.id)!.status).toBe("blocked_user_approval");
    db.close();
  });

  it("never opens the approval route: approving or rejecting with James' token stays 403, and Jochen cannot approve a withdrawn job", async () => {
    const { app, jobs, withdraw, james, admin } = await setup();
    for (const decision of ["approved", "rejected"]) {
      const response = await app.inject({ method: "POST", url: `/api/hermes/jobs/${jobs.waiting.id}/approval`, headers: james, payload: { decision, reason: "ich selbst" } });
      expect(response.statusCode).toBe(403);
    }
    expect((await withdraw(jobs.waiting.id, james)).statusCode).toBe(200);
    const late = await app.inject({ method: "POST", url: `/api/hermes/jobs/${jobs.waiting.id}/approval`, headers: admin, payload: { decision: "approved", reason: "zu spaet" } });
    expect(late.statusCode).toBe(409);
  });
});

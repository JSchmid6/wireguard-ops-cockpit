import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, REACTIVATION_MAX_AGE_HOURS, REACTIVATION_MAX_COUNT } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";
import {
  approveExecutionEnvelope, createExecutionEnvelope, extendQueuedExecutionEnvelope, hashCanonical, renewExecutionEnvelope, verifyExecutionEnvelopeSignature,
  type ExecutionEnvelope,
} from "../src/hermes-security.js";

// Reaktivieren: Ein Job, der nur abgelaufen ist, bekommt eine neue Frist.
// Der sicherheitskritische Kern: Reaktivieren gibt nie frei — der neue
// Envelope trägt nie operatorApproved, der Job wartet weiter auf Jochen, und
// ein Automation-Token kann die Freigabe-Route gar nicht erst benutzen.

const SECRET = "test-envelope-secret";
const TTL = 30;
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
    terminalSigningSecret: "test-terminal-secret", executionEnvelopeSecret: SECRET,
    repoRoot: process.cwd(), plannerRuntime: "demo-local", copilotExecutable: "copilot", copilotModel: null,
    opencodeExecutable: "opencode", opencodeModel: null, safetyOpencodeModel: null, requireModelDiversity: false,
    approvalTtlMinutes: TTL, maxFailedChangesPerHour: 3, agentBrokerSocket: null, executorBrokerSocket: null,
    executorBrokerSecret: null, nodeEnv: "development", webUrl: "https://cockpit.example",
  };
}

const intent = "Pakete auf dem VPS aktualisieren.";
const plan = "```host-run\n{}\n```\n## Intent\nKeep packages current.";
const safety = { verdict: "flag", details: { findings: [] } };
const policy = { status: "blocked_user_approval", reason: "The doorkeeper found 1 evidenced finding(s)." };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reactivate-api-"));
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
  // Selbst mit dem Scope der Freigabe-Route kann James nicht freigeben.
  const token = database.rotateApiToken(automation.id, "hermes", [
    "GET /api/hermes/jobs/:jobId", "POST /api/hermes/jobs/:jobId/reactivate", "POST /api/hermes/jobs/:jobId/approval",
  ]);
  const unscoped = database.createUser("other-automation", "unusable-random-password", "automation");
  const unscopedToken = database.rotateApiToken(unscoped.id, "other", ["GET /api/hermes/jobs/:jobId"]);
  const jamesSession = database.upsertSession({ name: "hermes-rb", ownerId: automation.id, tmuxSessionName: "cockpit-hermes-rb", tmuxBackend: "tmux", terminalUrl: null });
  const adminSession = database.upsertSession({ name: "admin-own", ownerId: admin.id, tmuxSessionName: "cockpit-admin-own", tmuxBackend: "tmux", terminalUrl: null });
  // Ein echt signierter Job, ausgestellt `issuedMinutesAgo` vor jetzt.
  const blocked = (sessionId: string, ownerId: string, issuedMinutesAgo: number, status = "blocked_user_approval", extra: Record<string, unknown> = {}) => {
    const created = database.createJob({ sessionId, kind: "runbook", subjectId: "hermes-change", status: status as "blocked_user_approval", requiresApproval: false, output: {} });
    const envelope = createExecutionEnvelope({
      jobId: created.id, actorId: ownerId, sessionId, intent, evidence: [], plan, safety, policy, capabilities: ["host.run"],
      ttlMinutes: TTL, signingSecret: SECRET, now: new Date(Date.now() - issuedMinutesAgo * 60_000),
    });
    return database.updateJob(created.id, {
      status: status as "blocked_user_approval",
      output: { explanation: { intent }, plan, safety, policy, capabilities: ["host.run"], envelope, ...extra },
      completedAt: null,
    });
  };
  const jobs = {
    stale: blocked(jamesSession.id, automation.id, 31),
    fresh: blocked(jamesSession.id, automation.id, 1),
    foreignStale: blocked(adminSession.id, admin.id, 31),
    rejected: blocked(jamesSession.id, automation.id, 31, "rejected", { approval: { decision: "rejected" } }),
    running: blocked(jamesSession.id, automation.id, 31, "running", { approval: { decision: "approved" } }),
    completed: blocked(jamesSession.id, automation.id, 31, "completed", { approval: { decision: "approved" } }),
    reordered: blocked(jamesSession.id, automation.id, 31, "blocked_policy", { reorder: { requestedAt: "x" } }),
  };
  database.close();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
  const inspect = () => { const db = new CockpitDatabase(dbPath); db.initialize(); return db; };
  // Lässt die aktuelle Frist ablaufen, ohne sonst etwas am Job zu ändern.
  const expire = (jobId: string) => {
    const db = inspect();
    const current = db.getJob(jobId)!;
    const envelope = renewExecutionEnvelope(current.output!.envelope as ExecutionEnvelope, SECRET, TTL, new Date(Date.now() - 1000), new Date(Date.now() - 2000));
    db.updateJob(jobId, { status: current.status, output: { ...current.output, envelope } });
    db.close();
  };
  const backdate = (jobId: string, hours: number) => {
    const raw = new BetterSqlite3(dbPath);
    raw.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(new Date(Date.now() - hours * 3_600_000).toISOString(), jobId);
    raw.close();
  };
  const reactivate = (jobId: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url: `/api/hermes/jobs/${jobId}/reactivate`, headers, payload: {} });
  return {
    app, jobs, inspect, expire, backdate, reactivate,
    admin: { cookie: login.headers["set-cookie"] as string },
    james: { authorization: `Bearer ${token}` },
    unscoped: { authorization: `Bearer ${unscopedToken}` },
  };
}

describe("renewExecutionEnvelope", () => {
  const base = () => createExecutionEnvelope({
    jobId: "j", actorId: "a", sessionId: "s", intent, evidence: [], plan, safety, policy, capabilities: ["host.run"],
    ttlMinutes: TTL, signingSecret: SECRET, now: new Date("2026-10-11T08:00:00.000Z"),
  });

  it("only moves the deadline and keeps every reviewed hash", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    const renewed = renewExecutionEnvelope(base(), SECRET, TTL, new Date("2026-10-14T08:00:00.000Z"), now);
    expect(verifyExecutionEnvelopeSignature(renewed, SECRET)).toBe(true);
    expect(renewed.expiresAt).toBe("2026-10-11T12:30:00.000Z");
    const { digest: _a, issuedAt: _b, expiresAt: _c, ...kept } = renewed;
    const { digest: _d, issuedAt: _e, expiresAt: _f, ...original } = base();
    expect(kept).toEqual(original);
    expect(renewed.operatorApproved).toBeUndefined();
  });

  it("never passes the overall cap", () => {
    const renewed = renewExecutionEnvelope(base(), SECRET, TTL, new Date("2026-10-11T12:10:00.000Z"), new Date("2026-10-11T12:00:00.000Z"));
    expect(renewed.expiresAt).toBe("2026-10-11T12:10:00.000Z");
  });

  it("refuses an approved or forged envelope", () => {
    const approved = approveExecutionEnvelope(base(), SECRET, TTL);
    expect(() => renewExecutionEnvelope(approved, SECRET, TTL, new Date(Date.now() + 3_600_000))).toThrow(/approved/);
    expect(() => renewExecutionEnvelope({ ...base(), planHash: hashCanonical("other") }, SECRET, TTL, new Date(Date.now() + 3_600_000))).toThrow(/invalid/);
  });
});

describe("extendQueuedExecutionEnvelope", () => {
  const base = (capabilities: Array<"host.run" | "read.host"> = ["host.run"]) => createExecutionEnvelope({
    jobId: "j", actorId: "a", sessionId: "s", intent, evidence: [], plan, safety, policy, capabilities,
    ttlMinutes: TTL, signingSecret: SECRET, now: new Date("2026-10-11T08:00:00.000Z"),
  });

  it("keeps the operator's approval and every reviewed hash, only the deadline moves", () => {
    const approved = approveExecutionEnvelope(base(), SECRET, TTL, new Date("2026-10-11T08:00:00.000Z"));
    const now = new Date("2026-10-11T12:00:00.000Z");
    const extended = extendQueuedExecutionEnvelope(approved, SECRET, TTL, new Date("2026-10-12T08:00:00.000Z"), now);
    expect(verifyExecutionEnvelopeSignature(extended, SECRET)).toBe(true);
    expect(extended.expiresAt).toBe("2026-10-11T12:30:00.000Z");
    expect(extended.operatorApproved).toBe(true);
    const { digest: _a, issuedAt: _b, expiresAt: _c, ...kept } = extended;
    const { digest: _d, issuedAt: _e, expiresAt: _f, ...original } = approved;
    expect(kept).toEqual(original);
  });

  it("never passes the queue limit and refuses after it", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    expect(extendQueuedExecutionEnvelope(base(), SECRET, TTL, new Date("2026-10-11T12:05:00.000Z"), now).expiresAt).toBe("2026-10-11T12:05:00.000Z");
    expect(() => extendQueuedExecutionEnvelope(base(), SECRET, TTL, now, now)).toThrow(/queue limit/);
  });

  it("refuses a forged envelope and one without host.run", () => {
    const later = new Date(Date.now() + 3_600_000);
    expect(() => extendQueuedExecutionEnvelope({ ...base(), planHash: hashCanonical("other") }, SECRET, TTL, later)).toThrow(/invalid/);
    expect(() => extendQueuedExecutionEnvelope({ ...base(), operatorApproved: true }, SECRET, TTL, later)).toThrow(/invalid/);
    expect(() => extendQueuedExecutionEnvelope(base(["read.host"]), SECRET, TTL, later)).toThrow(/host run/);
  });
});

describe("POST /api/hermes/jobs/:jobId/reactivate", () => {
  it("gives an expired, undecided job a new deadline — and nothing else", async () => {
    const { jobs, reactivate, james, inspect } = await setup();
    const before = Date.now();
    const response = await reactivate(jobs.stale.id, james);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reactivation).toMatchObject({ count: 1, remaining: REACTIVATION_MAX_COUNT - 1 });
    expect(body.job.status).toBe("blocked_user_approval");
    expect(body.job.operatorLink).toBe(`https://cockpit.example/#karte-job-${jobs.stale.id}`);

    const db = inspect();
    const job = db.getJob(jobs.stale.id)!;
    const envelope = job.output!.envelope as ExecutionEnvelope;
    const original = jobs.stale.output!.envelope as ExecutionEnvelope;
    expect(Date.parse(envelope.expiresAt)).toBeGreaterThanOrEqual(before + TTL * 60_000 - 1000);
    expect(verifyExecutionEnvelopeSignature(envelope, SECRET)).toBe(true);
    for (const key of ["jobId", "actorId", "sessionId", "intentHash", "planHash", "safetyHash", "policyHash", "capabilities", "evidence"] as const) {
      expect(envelope[key]).toEqual(original[key]);
    }
    // Plan, Prüfung und Policy bleiben byte-gleich.
    expect(job.output!.plan).toBe(plan);
    expect(job.output!.safety).toEqual(safety);
    expect(job.output!.policy).toEqual(policy);
    expect(job.output!.reactivations).toEqual([expect.objectContaining({ previousExpiresAt: original.expiresAt, expiresAt: envelope.expiresAt })]);
    const audit = db.listAudits(20).find((entry) => entry.action === "hermes.change.reactivated" && entry.targetId === jobs.stale.id);
    expect(audit?.details).toMatchObject({ count: 1, maxCount: REACTIVATION_MAX_COUNT, previousExpiresAt: original.expiresAt });
    db.close();
  });

  it("never approves: the job keeps waiting, no approval is recorded, and James cannot approve himself", async () => {
    const { jobs, reactivate, james, admin, app, inspect, expire } = await setup();
    for (let round = 0; round < REACTIVATION_MAX_COUNT; round += 1) {
      if (round > 0) expire(jobs.stale.id);
      expect((await reactivate(jobs.stale.id, james)).statusCode).toBe(200);
      const db = inspect();
      const job = db.getJob(jobs.stale.id)!;
      expect(job.status).toBe("blocked_user_approval");
      expect((job.output!.envelope as ExecutionEnvelope).operatorApproved).toBeUndefined();
      expect(job.output!.approval).toBeUndefined();
      expect(db.hasAudit("hermes.change.approved", jobs.stale.id)).toBe(false);
      db.close();
    }
    // Die Freigabe-Route bleibt Jochens Sitzung vorbehalten — auch mit Scope.
    const selfApproval = await app.inject({ method: "POST", url: `/api/hermes/jobs/${jobs.stale.id}/approval`, headers: james, payload: { decision: "approved", reason: "ich selbst" } });
    expect(selfApproval.statusCode).toBe(403);
    const db = inspect();
    expect(db.getJob(jobs.stale.id)!.status).toBe("blocked_user_approval");
    db.close();
    // Jochens Freigabe scheitert nicht mehr an der Frist: der reaktivierte
    // Envelope besteht die volle Prüfung der Freigabe-Route.
    const approval = await app.inject({ method: "POST", url: `/api/hermes/jobs/${jobs.stale.id}/approval`, headers: admin, payload: { decision: "approved", reason: "gelesen, passt" } });
    expect(approval.json().message).not.toBe("execution envelope validation failed");
    expect(approval.json().job?.status).not.toBe("blocked_policy");
  });

  it("refuses a job whose envelope is still valid", async () => {
    const { jobs, reactivate, james } = await setup();
    const response = await reactivate(jobs.fresh.id, james);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("still valid");
  });

  it("refuses rejected, running, completed and re-ordered jobs", async () => {
    const { jobs, reactivate, james, inspect } = await setup();
    for (const job of [jobs.rejected, jobs.running, jobs.completed, jobs.reordered]) {
      const response = await reactivate(job.id, james);
      expect(response.statusCode).toBe(409);
      const db = inspect();
      expect(db.getJob(job.id)!.status).toBe(job.status);
      expect(db.getJob(job.id)!.output!.envelope).toEqual(job.output!.envelope);
      db.close();
    }
  });

  it("stops after the maximum number of reactivations", async () => {
    const { jobs, reactivate, james, expire } = await setup();
    for (let round = 0; round < REACTIVATION_MAX_COUNT; round += 1) {
      if (round > 0) expire(jobs.stale.id);
      expect((await reactivate(jobs.stale.id, james)).statusCode).toBe(200);
    }
    expire(jobs.stale.id);
    const response = await reactivate(jobs.stale.id, james);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ message: expect.stringContaining("limit"), limit: { count: REACTIVATION_MAX_COUNT } });
  });

  it("caps the new deadline at the overall age limit and refuses past it", async () => {
    const { jobs, reactivate, james, backdate, expire } = await setup();
    backdate(jobs.stale.id, REACTIVATION_MAX_AGE_HOURS - 0.1);
    const capped = await reactivate(jobs.stale.id, james);
    expect(capped.statusCode).toBe(200);
    expect(capped.json().reactivation.expiresAt).toBe(capped.json().reactivation.notAfter);
    expect(Date.parse(capped.json().reactivation.expiresAt) - Date.now()).toBeLessThan(TTL * 60_000);

    // Abgelaufen und älter als die Obergrenze: nur noch Neubestellung.
    expire(jobs.stale.id);
    backdate(jobs.stale.id, REACTIVATION_MAX_AGE_HOURS);
    const refused = await reactivate(jobs.stale.id, james);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("limit");
  });

  it("refuses when the stored job no longer matches its envelope", async () => {
    const { jobs, reactivate, james, inspect } = await setup();
    const db = inspect();
    const current = db.getJob(jobs.stale.id)!;
    db.updateJob(jobs.stale.id, { status: "blocked_user_approval", output: { ...current.output, plan: `${plan}\nrm -rf /srv` } });
    db.close();
    const response = await reactivate(jobs.stale.id, james);
    expect(response.statusCode).toBe(409);
    expect(response.json().envelopeErrors).toContain("reviewed plan drift");
    const after = inspect();
    expect(after.hasAudit("hermes.change.reactivate_refused", jobs.stale.id)).toBe(true);
    expect(after.getJob(jobs.stale.id)!.output!.envelope).toEqual(current.output!.envelope);
    after.close();
  });

  it("needs the scope, and James sees only his own jobs", async () => {
    const { jobs, reactivate, james, unscoped, admin } = await setup();
    expect((await reactivate(jobs.stale.id, unscoped)).statusCode).toBe(403);
    expect((await reactivate(jobs.foreignStale.id, james)).statusCode).toBe(404);
    expect((await reactivate("unknown", james)).statusCode).toBe(404);
    // Jochens Sitzung darf ebenfalls reaktivieren.
    expect((await reactivate(jobs.foreignStale.id, admin)).statusCode).toBe(200);
  });
});

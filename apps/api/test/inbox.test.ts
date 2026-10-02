import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { RETENTION_MARKER } from "../src/borg-retention.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";
import { approvalCard, cardLink, hermesJobCard, jobFindings, oneSentence, retentionAnomalyCard, sortCards } from "../src/inbox.js";

// "Wartet auf dich": die Karten lesen nur, was Job und Freigabe gespeichert
// haben; entschieden wird über die bestehenden Wege. Geprüft wird, dass jede
// Entscheidungslage als Karte erscheint, mit Frist und belegten Befunden, und
// dass "Neu bestellen lassen" einen abgelaufenen Job endgültig schließt.

type TestApp = Awaited<ReturnType<typeof createApp>>;
const openApps: TestApp[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openApps.length) await openApps.pop()!.close();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function job(output: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1", sessionId: "s", kind: "runbook", subjectId: "hermes-change", status: "blocked_user_approval",
    requiresApproval: false, approvalId: null, output, createdAt: "2026-10-02T11:50:00.000Z",
    updatedAt: "2026-10-02T11:50:00.000Z", completedAt: null, ...overrides,
  } as Parameters<typeof hermesJobCard>[0];
}

const hostRunOutput = {
  explanation: { intent: "Selbstupdate auf PR #25 einspielen. Danach die Dienste prüfen.", reason: "fallback" },
  policy: { reason: "The doorkeeper found 1 evidenced finding(s): S3:L1 borg repair." },
  envelope: { expiresAt: "2026-10-02T12:20:00.000Z" },
  safety: { details: {
    findings: [
      { title: "borg repair without the operator", class: "X4", where: "S3:L1", code: "cockpit-borg-action repair", path: "a repair can drop archives", severity: "high", evidenced: true },
      { title: "unproven guess", class: "X5", where: "nowhere", code: "", path: "", severity: "low", evidenced: false },
    ],
    backupGuard: [{ kind: "repair", where: "S3:L1", reason: "borg repair can delete archives", code: "cockpit-borg-action repair" }],
  } },
  updateReview: { findings: [{ title: "Doorkeeper approves root", guarantee: "G1", file: "apps/api/src/host-run.ts:461", code: "allowed: true", reason: "no operator in the loop", severity: "high", quoteFound: true }] },
};

describe("inbox cards", () => {
  it("cuts the intent to one sentence and builds a direct link", () => {
    expect(oneSentence("Selbstupdate einspielen. Danach prüfen.")).toBe("Selbstupdate einspielen.");
    expect(oneSentence("ohne Satzende\nzweite Zeile")).toBe("ohne Satzende zweite Zeile");
    expect(oneSentence("x".repeat(300))).toHaveLength(200);
    expect(cardLink("job-1", null)).toBe("/#karte-job-1");
    expect(cardLink("job-1", "https://cockpit.example/")).toBe("https://cockpit.example/#karte-job-1");
  });

  it("shows only evidenced doorkeeper findings, the backup bolt and the update reviewer", () => {
    const findings = jobFindings(hostRunOutput);
    expect(findings.map((finding) => [finding.source, finding.guarantee, finding.location])).toEqual([
      ["doorkeeper", "X4", "S3:L1"],
      ["backup-bolt", "repair", "S3:L1"],
      ["update-review", "G1", "apps/api/src/host-run.ts:461"],
    ]);
    expect(findings[0].detail).toContain("a repair can drop archives");
    expect(findings[2].detail).toContain("no operator in the loop");
    expect(jobFindings({})).toEqual([]);
  });

  it("turns a blocked Hermes job into a card with countdown data", () => {
    const card = hermesJobCard(job(hostRunOutput), NOW, null);
    expect(card).toMatchObject({
      id: "job-job-1", kind: "backup-bolt", jobId: "job-1",
      title: "Selbstupdate auf PR #25 einspielen.",
      reason: "The doorkeeper found 1 evidenced finding(s): S3:L1 borg repair.",
      expiresAt: "2026-10-02T12:20:00.000Z", expired: false, link: "/#karte-job-job-1",
    });
    expect(hermesJobCard(job(hostRunOutput), Date.parse("2026-10-02T12:21:00.000Z"), null).expired).toBe(true);
    // Ohne Envelope gibt es nichts freizugeben.
    const bare = hermesJobCard(job({ explanation: { reason: "why" } }), NOW, null);
    expect(bare).toMatchObject({ kind: "hermes-change", title: "Änderung von James", reason: "why", expiresAt: null, expired: true });
  });

  it("gives approvals the TTL as deadline and the retention anomaly no deadline", () => {
    const approval = { id: "a1", jobId: "j1", status: "pending", requestedBy: "u", decidedBy: null, reason: "risky", createdAt: "2026-10-02T11:45:00.000Z", decidedAt: null } as Parameters<typeof approvalCard>[0];
    const card = approvalCard(approval, job({ summary: "Restart Apache. Then check." }, { id: "j1", kind: "execution.plan" }), 30, NOW, null);
    expect(card).toMatchObject({ id: "approval-a1", kind: "approval", title: "Restart Apache.", reason: "risky", expiresAt: "2026-10-02T12:15:00.000Z", expired: false, approvalId: "a1" });
    expect(approvalCard(approval, null, 30, NOW, null).title).toBe("Freigabe");

    const anomaly = retentionAnomalyCard({ id: "0123456789abcdef", detectedAt: "2026-10-02T04:00:05.000Z", phase: "before-prune", count: 1, missing: [{ id: "a", name: "vmd61162-2026-09-30T00:37:11" }] }, NOW, null);
    expect(anomaly).toMatchObject({ id: "retention-0123456789abcdef", kind: "retention-anomaly", expiresAt: null, expired: false, anomalyId: "0123456789abcdef" });
    expect(anomaly.findings[0].detail).toContain("vmd61162-2026-09-30T00:37:11");
  });

  it("puts the nearest deadline first and expired cards last", () => {
    const at = (id: string, expiresAt: string | null, expired: boolean) => ({ ...hermesJobCard(job(hostRunOutput), NOW, null), id, expiresAt, expired });
    const sorted = sortCards([at("expired", "2026-10-02T11:00:00.000Z", true), at("none", null, false), at("late", "2026-10-02T12:25:00.000Z", false), at("soon", "2026-10-02T12:05:00.000Z", false)]);
    expect(sorted.map((card) => card.id)).toEqual(["soon", "late", "none", "expired"]);
  });
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

const anomalyId = "0123456789abcdef";

async function setup(options: { halted?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-api-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "cockpit.sqlite");
  const app = await createApp({
    config: config(dbPath),
    bootstrapUsers: [{ username: "hermes-automation", password: "unusable-random-password", role: "automation" }],
    borgRetentionRunner: async (action) => {
      if (action !== "borg.retention.status") return "{}\n";
      return `${RETENTION_MARKER}\n${JSON.stringify({
        version: "cockpit-borg-retention/v1", measuredAt: "2026-10-02T10:00:00.000Z", host: "lab0",
        installed: { service: true, timer: true, passphrase: "ok" }, settings: null, settingsError: null,
        timer: { active: "active", next: null }, service: { active: "inactive" },
        state: options.halted
          ? { status: "angehalten", anomaly: { id: anomalyId, detectedAt: "2026-10-02T04:00:05.000Z", phase: "before-prune", count: 1, missing: [{ id: "a".repeat(64), name: "vmd61162-2026-09-30T00:37:11" }] }, approval: null, baselineAt: null }
          : { status: "ok", anomaly: null, approval: null, baselineAt: null },
        inventory: { at: null, count: 0, archives: [] }, space: null, repoStats: null, runs: [],
      })}\n`;
    },
  });
  openApps.push(app);
  const database = new CockpitDatabase(dbPath);
  database.initialize();
  const admin = database.authenticateUser("admin", "test-password")!;
  const automation = database.authenticateUser("hermes-automation", "unusable-random-password")!;
  const token = database.rotateApiToken(automation.id, "hermes", ["GET /api/inbox", "GET /api/hermes/jobs/:jobId", "POST /api/inbox/jobs/:jobId/reorder"]);
  const jamesSession = database.upsertSession({ name: "hermes-rb", ownerId: automation.id, tmuxSessionName: "cockpit-hermes-rb", tmuxBackend: "tmux", terminalUrl: null });
  const adminSession = database.upsertSession({ name: "admin-own", ownerId: admin.id, tmuxSessionName: "cockpit-admin-own", tmuxBackend: "tmux", terminalUrl: null });
  const blocked = (sessionId: string, expiresAt: string) => database.createJob({
    sessionId, kind: "runbook", subjectId: "hermes-change", status: "blocked_user_approval", requiresApproval: false,
    output: { ...hostRunOutput, envelope: { expiresAt } },
  });
  const fresh = blocked(jamesSession.id, new Date(Date.now() + 20 * 60_000).toISOString());
  const stale = blocked(jamesSession.id, new Date(Date.now() - 60_000).toISOString());
  const foreign = blocked(adminSession.id, new Date(Date.now() + 10 * 60_000).toISOString());
  database.close();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
  const inspect = () => { const db = new CockpitDatabase(dbPath); db.initialize(); return db; };
  return { app, admin: { cookie: login.headers["set-cookie"] as string }, automation: { authorization: `Bearer ${token}` }, fresh, stale, foreign, inspect };
}

describe("GET /api/inbox", () => {
  it("lists every blocked Hermes job for the admin, with link, deadline and findings", async () => {
    const { app, admin, fresh, stale, foreign } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/inbox", headers: admin });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.cards.map((card: { jobId: string }) => card.jobId)).toEqual([foreign.id, fresh.id, stale.id]);
    const card = body.cards.find((item: { jobId: string }) => item.jobId === fresh.id);
    expect(card).toMatchObject({ kind: "backup-bolt", expired: false, link: `https://cockpit.example/#karte-job-${fresh.id}` });
    expect(card.findings).toHaveLength(3);
    expect(body.cards.at(-1).expired).toBe(true);
    expect(body.status).toHaveProperty("lastRuns");
    expect(body.status).toHaveProperty("backup");
    expect(body.status.disk === null || body.status.disk.totalBytes > 0).toBe(true);
    expect(body.reorders).toEqual([]);
  });

  it("shows James only his own jobs, and only with the scope", async () => {
    const { app, automation, fresh, stale } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/inbox", headers: automation });
    expect(response.statusCode).toBe(200);
    expect(response.json().cards.map((card: { jobId: string }) => card.jobId).sort()).toEqual([fresh.id, stale.id].sort());
    const unscoped = await app.inject({ method: "GET", url: "/api/inbox", headers: { authorization: "Bearer nope" } });
    expect(unscoped.statusCode).toBe(401);
  });

  it("hands James the direct link with a blocked job", async () => {
    const { app, automation, fresh } = await setup();
    const response = await app.inject({ method: "GET", url: `/api/hermes/jobs/${fresh.id}`, headers: automation });
    expect(response.json().job.operatorLink).toBe(`https://cockpit.example/#karte-job-${fresh.id}`);
  });

  it("shows a halted retention service until Jochen keeps it halted", async () => {
    const { app, admin, automation, inspect } = await setup({ halted: true });
    const first = await app.inject({ method: "GET", url: "/api/inbox", headers: admin });
    expect(first.json().cards.some((card: { anomalyId?: string }) => card.anomalyId === anomalyId)).toBe(true);

    expect((await app.inject({ method: "POST", url: `/api/inbox/retention/${anomalyId}/keep`, headers: admin, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/inbox/retention/not-an-id/keep", headers: admin, payload: { reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/inbox/retention/${anomalyId}/keep`, headers: automation, payload: { reason: "x" } })).statusCode).toBe(403);
    const kept = await app.inject({ method: "POST", url: `/api/inbox/retention/${anomalyId}/keep`, headers: admin, payload: { reason: "erst klären, wer gelöscht hat" } });
    expect(kept.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/inbox", headers: admin });
    expect(after.json().cards.some((card: { anomalyId?: string }) => card.anomalyId === anomalyId)).toBe(false);
    const db = inspect();
    expect(db.hasAudit("borg.retention.anomaly_kept", anomalyId)).toBe(true);
    db.close();
  });
});

describe("POST /api/inbox/jobs/:jobId/reorder", () => {
  it("closes an expired job for good and queues the re-order for James", async () => {
    const { app, admin, automation, stale, inspect } = await setup();
    const response = await app.inject({ method: "POST", url: `/api/inbox/jobs/${stale.id}/reorder`, headers: admin, payload: { note: "bitte neu" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().job.status).toBe("blocked_policy");
    expect(response.json().job.output.reorder).toMatchObject({ note: "bitte neu" });

    // Kein zweites Mal, keine Freigabe mehr.
    expect((await app.inject({ method: "POST", url: `/api/inbox/jobs/${stale.id}/reorder`, headers: admin, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/hermes/jobs/${stale.id}/approval`, headers: admin, payload: { decision: "approved", reason: "zu spät" } })).statusCode).toBe(409);

    const inbox = (await app.inject({ method: "GET", url: "/api/inbox", headers: automation })).json();
    expect(inbox.cards.some((card: { jobId: string }) => card.jobId === stale.id)).toBe(false);
    expect(inbox.reorders).toEqual([expect.objectContaining({ jobId: stale.id, intent: hostRunOutput.explanation.intent, note: "bitte neu" })]);
    const db = inspect();
    expect(db.hasAudit("hermes.change.reorder_requested", stale.id)).toBe(true);
    db.close();
  });

  it("refuses while the envelope is valid, for unknown jobs and for the automation token", async () => {
    const { app, admin, automation, fresh, stale } = await setup();
    expect((await app.inject({ method: "POST", url: `/api/inbox/jobs/${fresh.id}/reorder`, headers: admin, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/inbox/jobs/unknown/reorder", headers: admin, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/inbox/jobs/${stale.id}/reorder`, headers: automation, payload: {} })).statusCode).toBe(403);
  });
});

describe("decisions need a reason", () => {
  it("refuses a Hermes decision without a reason", async () => {
    const { app, admin, fresh } = await setup();
    const response = await app.inject({ method: "POST", url: `/api/hermes/jobs/${fresh.id}/approval`, headers: admin, payload: { decision: "rejected", reason: "   " } });
    expect(response.statusCode).toBe(400);
    const rejected = await app.inject({ method: "POST", url: `/api/hermes/jobs/${fresh.id}/approval`, headers: admin, payload: { decision: "rejected", reason: "nicht jetzt" } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().job.status).toBe("rejected");
  });
});

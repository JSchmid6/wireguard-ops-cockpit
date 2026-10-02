import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { parseRetentionReport, RETENTION_MARKER } from "../src/borg-retention.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// Die Cockpit-Seite des Aufräum-Diensts: Grenzen, Freigabe, Audit. Der Helfer
// ist ein Stub, der die Aufrufe mitschreibt und einen Zustand wie der echte
// `cockpit-borg-retention status` meldet.

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
    executorBrokerSecret: null, nodeEnv: "development",
  };
}

const anomalyId = "0123456789abcdef";

function statusOutput(settings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return `${RETENTION_MARKER}\n${JSON.stringify({
    version: "cockpit-borg-retention/v1",
    measuredAt: "2026-10-02T10:00:00.000Z",
    host: "lab0",
    installed: { service: true, timer: true, passphrase: "ok" },
    settings: { ...settings, approved: false, changedAt: null, source: "cockpit" },
    settingsError: null,
    timer: { active: "active", next: "2026-10-03T04:00:00.000Z" },
    service: { active: "inactive" },
    state: { status: "ok", anomaly: null, approval: null, baselineAt: "2026-10-02T04:00:10.000Z" },
    inventory: { at: "2026-10-02T04:00:10.000Z", count: 2, archives: [{ name: "vmd61162-2026-10-02T00:37:11", time: "2026-10-02T00:37:11.000000" }, { name: "vmd61162-2026-10-01T00:37:11", time: null }] },
    space: { totalBytes: 6_000_000_000_000, freeBytes: 780_000_000_000, usedPercent: 87 },
    repoStats: { at: "2026-10-02T04:01:00.000Z", uniqueCompressedBytes: 4_600_000_000_000, totalSizeBytes: 9_000_000_000_000 },
    runs: [{ start: "2026-10-02T04:00:00.000Z", end: "2026-10-02T04:01:00.000Z", result: "ok", before: 5, after: 3, pruned: 2, prunedNames: ["vmd61162-2026-09-27T00:37:11"], compacted: true, compactSkipped: null, settings, note: null }],
    ...extra,
  })}\n`;
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "borg-retention-api-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "cockpit.sqlite");
  const calls: Array<[string, string]> = [];
  let settings: Record<string, unknown> = { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" };
  let extra: Record<string, unknown> = {};
  let failNext: string | null = null;
  const app = await createApp({
    config: config(dbPath),
    bootstrapUsers: [{ username: "hermes-automation", password: "unusable-random-password", role: "automation" }],
    borgRetentionRunner: async (action, target) => {
      calls.push([action, target]);
      if (failNext) { const message = failNext; failNext = null; throw new Error(message); }
      if (action === "borg.retention.set" || action === "borg.retention.set-approved") {
        const before = settings;
        const [d, w, m, time] = [...target.split("-").slice(0, 3).map(Number), target.split("-")[3]];
        settings = { keepDaily: d, keepWeekly: w, keepMonthly: m, time };
        return `${JSON.stringify({ vorher: before, nachher: settings })}\n`;
      }
      if (action === "borg.retention.status") return statusOutput(settings, extra);
      return "{}\n";
    },
  });
  openApps.push(app);
  const database = new CockpitDatabase(dbPath);
  database.initialize();
  const automation = database.authenticateUser("hermes-automation", "unusable-random-password")!;
  const token = database.rotateApiToken(automation.id, "hermes", ["GET /api/borg/retention", "PUT /api/borg/retention", "POST /api/borg/retention/run", "POST /api/borg/retention/resume"]);
  database.close();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
  const cookie = login.headers["set-cookie"] as string;
  const audits = () => {
    const db = new CockpitDatabase(dbPath);
    db.initialize();
    const list = db.listAudits(100).filter((item) => item.action.startsWith("borg.retention."));
    db.close();
    return list;
  };
  return {
    app, calls, audits,
    admin: { cookie },
    automation: { authorization: `Bearer ${token}` },
    halt: () => { extra = { state: { status: "angehalten", anomaly: { id: anomalyId, detectedAt: "2026-10-02T04:00:05.000Z", phase: "before-prune", count: 1, missing: [{ id: "a".repeat(64), name: "vmd61162-2026-09-30T00:37:11" }] }, approval: null, baselineAt: null } }; },
    fail: (message: string) => { failNext = message; },
  };
}

describe("backup retention in the cockpit", () => {
  it("shows settings, bounds, status, runs, inventory and space", async () => {
    const { app, admin } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/borg/retention", headers: admin });
    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view).toMatchObject({
      available: true,
      bounds: { keepDaily: { floor: 1, min: 3, max: 30 }, keepWeekly: { min: 2, max: 12 }, keepMonthly: { min: 0, max: 24 } },
      window: { earliest: "04:00", latest: "22:00" },
      report: {
        settings: { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" },
        state: { status: "ok" },
        inventory: { count: 2 },
        space: { usedPercent: 87 },
        runs: [{ result: "ok", pruned: 2, compacted: true }],
      },
    });
  });

  it("applies a change inside the bounds without approval and records it", async () => {
    const { app, admin, automation, calls, audits } = await setup();
    const response = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, time: "06:30" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().report.settings).toMatchObject({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6, time: "06:30" });
    expect(calls).toContainEqual(["borg.retention.set", "7-4-6-06:30"]);
    // James darf innerhalb der Grenzen genauso.
    const byJames = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: automation, payload: { keepDaily: 5, keepWeekly: 2, keepMonthly: 0, time: "05:00" } });
    expect(byJames.statusCode).toBe(200);
    const changed = audits().filter((item) => item.action === "borg.retention.changed");
    expect(changed).toHaveLength(2);
    expect(changed.map((item) => item.details)).toContainEqual({ previous: { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" }, next: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, time: "06:30" } });
  });

  it("refuses values beyond the fixed bounds, also with an approval", async () => {
    const { app, admin, calls } = await setup();
    for (const payload of [
      { keepDaily: 31, keepWeekly: 2, keepMonthly: 0, time: "06:00" },
      { keepDaily: 3, keepWeekly: 2, keepMonthly: 25, time: "06:00" },
      { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "02:00" },
      { keepDaily: 0, keepWeekly: 0, keepMonthly: 0, time: "06:00", approval: { confirmed: true, reason: "Platz schaffen, Jochen" } },
    ]) {
      const response = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls.filter(([action]) => action !== "borg.retention.status")).toEqual([]);
  });

  it("needs Jochen's approval below the minimum, and only his session can give it", async () => {
    const { app, admin, automation, calls, audits } = await setup();
    const below = { keepDaily: 2, keepWeekly: 1, keepMonthly: 0, time: "06:00" };
    const asked = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload: below });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toMatchObject({ needsApproval: true });
    const james = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: automation, payload: { ...below, approval: { confirmed: true, reason: "James gibt sich selbst frei" } } });
    expect(james.statusCode).toBe(403);
    const unconfirmed = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload: { ...below, approval: { confirmed: false, reason: "RAID ist voll, kurzzeitig" } } });
    expect(unconfirmed.statusCode).toBe(403);
    const noReason = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload: { ...below, approval: { confirmed: true, reason: "kurz" } } });
    expect(noReason.statusCode).toBe(403);
    expect(calls.filter(([action]) => action.startsWith("borg.retention.set"))).toEqual([]);

    const approved = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload: { ...below, approval: { confirmed: true, reason: "RAID ist voll, kurzzeitig weniger behalten" } } });
    expect(approved.statusCode).toBe(200);
    expect(calls).toContainEqual(["borg.retention.set-approved", "2-1-0-06:00"]);
    const actions = audits().map((item) => item.action);
    expect(actions).toContain("borg.retention.approval_needed");
    expect(actions).toContain("borg.retention.approval_refused");
    const withApproval = audits().find((item) => item.action === "borg.retention.changed_with_approval")!;
    expect(withApproval.details).toMatchObject({ approvalReason: "RAID ist voll, kurzzeitig weniger behalten", next: { keepDaily: 2, keepWeekly: 1 } });
  });

  it("resumes after an anomaly only with Jochen's approval for the anomaly shown", async () => {
    const { app, admin, automation, calls, audits, halt } = await setup();
    halt();
    const view = (await app.inject({ method: "GET", url: "/api/borg/retention", headers: admin })).json();
    expect(view.report.state).toMatchObject({ status: "angehalten", anomaly: { id: anomalyId, count: 1 } });
    const james = await app.inject({ method: "POST", url: "/api/borg/retention/resume", headers: automation, payload: { anomalyId, approval: { confirmed: true, reason: "weiter machen bitte" } } });
    expect(james.statusCode).toBe(403);
    const bare = await app.inject({ method: "POST", url: "/api/borg/retention/resume", headers: admin, payload: { anomalyId } });
    expect(bare.statusCode).toBe(400);
    const badId = await app.inject({ method: "POST", url: "/api/borg/retention/resume", headers: admin, payload: { anomalyId: "../../etc", approval: { confirmed: true, reason: "Archive habe ich selbst gelöscht" } } });
    expect(badId.statusCode).toBe(400);
    expect(calls.filter(([action]) => action === "borg.retention.resume")).toEqual([]);
    const ok = await app.inject({ method: "POST", url: "/api/borg/retention/resume", headers: admin, payload: { anomalyId, approval: { confirmed: true, reason: "Archive habe ich selbst gelöscht" } } });
    expect(ok.statusCode).toBe(200);
    expect(calls).toContainEqual(["borg.retention.resume", anomalyId]);
    expect(audits().find((item) => item.action === "borg.retention.resumed")!.details).toMatchObject({ anomalyId, approvalReason: "Archive habe ich selbst gelöscht" });
  });

  it("starts the routine run freely and reports a refusing helper", async () => {
    const { app, automation, admin, calls, fail } = await setup();
    const run = await app.inject({ method: "POST", url: "/api/borg/retention/run", headers: automation });
    expect(run.statusCode).toBe(200);
    expect(calls).toContainEqual(["borg.retention.run", "state"]);
    fail("cockpit-borg-retention: needs Jochen's approval");
    const refused = await app.inject({ method: "PUT", url: "/api/borg/retention", headers: admin, payload: { keepDaily: 4, keepWeekly: 2, keepMonthly: 0, time: "06:00" } });
    expect(refused.statusCode).toBe(502);
  });

  it("says honestly when the service is not installed on this host", async () => {
    const { app, admin, fail } = await setup();
    fail("sudo: /usr/local/sbin/cockpit-borg-retention: command not found");
    const view = (await app.inject({ method: "GET", url: "/api/borg/retention", headers: admin })).json();
    expect(view.available).toBe(false);
    expect(view.report).toBeNull();
    expect(view.note).toContain("command not found");
    expect(view.note).not.toContain("/usr/local");
  });
});

describe("retention report parsing", () => {
  it("drops what does not fit its form", () => {
    const report = parseRetentionReport(statusOutput({ keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" }, {
      host: "lab0; rm -rf /",
      inventory: { at: "gestern", count: -1, archives: [{ name: "a b/c", time: "x" }] },
      runs: [{ result: "gelöscht", note: "passphrase=geheim at /media/RAID/backup_VServer/borg", settings: { keepDaily: 99 } }],
    }))!;
    expect(report.host).toBeNull();
    expect(report.inventory).toEqual({ at: null, count: 0, archives: [{ name: "[unlesbarer Name]", time: null }] });
    expect(report.runs[0]).toMatchObject({ result: "unbekannt", settings: null });
    expect(report.runs[0].note).not.toContain("geheim");
    expect(report.runs[0].note).not.toContain("/media");
    expect(parseRetentionReport("kein Block")).toBeNull();
    expect(parseRetentionReport(`${RETENTION_MARKER}\n{"version":"x"}`)).toBeNull();
  });
});

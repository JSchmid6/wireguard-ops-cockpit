import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// 16.10.2026: a self-update activation restarted the API while job 946bd6ae
// was planning. The promise carrying the job died with the process; the record
// stayed "running" with nothing behind it. Now the API takes every running
// Hermes job up again at start-up: a job that had not reached execution is
// planned again from its recorded request and runs through on its own;
// anything else ends with the reason, and both are noted on the job.

const BROKER_SECRET = "executor-broker-test-secret";
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function listen(socketPath: string, answer: (request: Record<string, any>) => Record<string, unknown>): Promise<Array<Record<string, any>>> {
  const seen: Array<Record<string, any>> = [];
  const server = net.createServer((connection) => {
    let input = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      seen.push(request);
      connection.end(JSON.stringify(answer(request)));
    });
  });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return new Promise((resolve) => server.listen(socketPath, () => resolve(seen)));
}

function config(dir: string, overrides: Partial<AppConfig>): AppConfig {
  return {
    apiHost: "127.0.0.1", apiPort: 3001, dbPath: path.join(dir, "cockpit.sqlite"),
    adminUsername: "admin", adminPassword: "test-password", sessionTtlHours: 12, cookieSecure: false,
    tmuxMode: "disabled", ttydBaseUrl: null, terminalSigningSecret: "test-terminal-secret",
    executionEnvelopeSecret: "test-envelope-secret", repoRoot: process.cwd(), plannerRuntime: "demo-local",
    copilotExecutable: "copilot", copilotModel: null, opencodeExecutable: "opencode", opencodeModel: null,
    safetyOpencodeModel: null, requireModelDiversity: false, approvalTtlMinutes: 30, maxFailedChangesPerHour: 3,
    agentBrokerSocket: null, executorBrokerSocket: null, executorBrokerSecret: null, nodeEnv: "development",
    ...overrides,
  };
}

const hostRun = {
  version: "cockpit-host-run/v1", name: "switch james", purpose: "switch the agent container to the new image", mutates: true,
  steps: [{ name: "switch", run: "docker compose -f /opt/hermes/docker-compose.yml up -d" }],
  checks: [{ name: "running", run: "docker ps --filter name=hermes --format '{{.Status}}' | grep -q Up" }],
  rollback: ["start the previous image again"],
  risk: ["contained"],
};
const plan = "```host-run\n" + JSON.stringify(hostRun) + "\n```\n## Intent\nSwitch James over.";
const changeIntent = "Switch James over to the new image";
const changeRequest = { intent: changeIntent, evidence: [], allowedCapabilities: [], execute: true, ownedSession: false };

type Seed = (db: CockpitDatabase, ids: { sessionId: string; dbPath: string }) => void;

// Seeds the database the way the API left it at the restart, then starts the API.
async function restart(seedJobs: Seed, agentAnswer?: (request: Record<string, any>) => Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "job-restart-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  seed.initialize();
  seed.seedAdmin("admin", "test-password");
  const admin = seed.authenticateUser("admin", "test-password")!;
  const session = seed.upsertSession({ name: "hermes-rb-x", ownerId: admin.id, tmuxSessionName: "cockpit-hermes-rb-x", tmuxBackend: "tmux", terminalUrl: null });
  seedJobs(seed, { sessionId: session.id, dbPath: path.join(dir, "cockpit.sqlite") });
  seed.close();

  const executorCalls = await listen(path.join(dir, "executor.sock"), (request) => {
    const expected = createHmac("sha256", BROKER_SECRET).update(JSON.stringify(request.payload)).digest("hex");
    if (request.signature !== expected) return { ok: false, error: "invalid request signature" };
    if (request.payload.action === "host.run") return { ok: true, output: JSON.stringify({ status: "started", jobId: request.payload.envelope.jobId }) };
    return { ok: true, output: JSON.stringify({ ok: true, logTail: "switched", state: {
      phase: "finished", status: "success", error: null, snapshot: { snapshotId: "snap-1" },
      steps: [{ index: 1, name: "switch", status: "success" }], checks: [{ index: 1, name: "running", status: "passed" }],
    } }) };
  });
  const agentCalls = await listen(path.join(dir, "agent.sock"), agentAnswer ?? ((request) => request.role === "planner"
    ? { ok: true, output: plan }
    : request.role === "research"
      ? { ok: true, output: "The hermes container runs image 0240fa4a and is healthy." }
      : { ok: true, output: "VERIFICATION_STATUS: passed\nEVIDENCE: container up\nREASON: done" }));
  const app = await createApp({
    config: config(dir, { executorBrokerSocket: path.join(dir, "executor.sock"), executorBrokerSecret: BROKER_SECRET, agentBrokerSocket: path.join(dir, "agent.sock") }),
    hostRunReviewRunner: async () => "VERDICT: pass\nNOTES: routine switch",
    hostRunPollMs: 10,
  });
  cleanup.push(() => app.close());
  const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  cleanup.push(() => inspect.close());
  const settled = async (jobId: string) => {
    const deadline = Date.now() + 10_000;
    while (inspect.getJob(jobId)?.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return inspect.getJob(jobId)!;
  };
  return { app, dir, inspect, settled, executorCalls, agentCalls };
}

const planning = (intent: string) => ({ phase: "planning", intent, reason: "Planner is producing a structured change plan." });

describe("Hermes jobs across an API restart", () => {
  it("plans a change job again that was planning, and it runs through on its own", async () => {
    let jobId = "";
    const flow = await restart((db, { sessionId }) => {
      jobId = db.createJob({
        sessionId, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false,
        output: { explanation: planning(changeIntent), request: changeRequest },
      }).id;
    });
    const job = await flow.settled(jobId);

    expect(job.status).toBe("completed");
    expect(job.output?.restarts).toEqual([expect.objectContaining({ phase: "planning", action: "replanned" })]);
    expect(job.output?.request).toEqual(changeRequest);
    expect(String(job.output?.result)).toContain("STATUS: success");
    expect(flow.agentCalls.map((call) => call.role)).toEqual(["planner", "verifier"]);
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope).toMatchObject({ jobId, gatePassed: true });
  });

  it("plans again as the job's owner, in the owner's session", async () => {
    let jobId = "";
    let ownerId = "";
    let ownerSession = "";
    const flow = await restart((db) => {
      // James orders with his automation account; the job is his, not the admin's.
      const owner = db.createUser("hermes-automation", "unusable-random-password", "automation");
      ownerId = owner.id;
      ownerSession = db.upsertSession({ name: "hermes-rb-j", ownerId: owner.id, tmuxSessionName: "cockpit-hermes-rb-j", tmuxBackend: "tmux", terminalUrl: null }).id;
      jobId = db.createJob({
        sessionId: ownerSession, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false,
        output: { explanation: planning(changeIntent), request: changeRequest },
      }).id;
    });
    const job = await flow.settled(jobId);

    expect(job.status).toBe("completed");
    const envelope = job.output?.envelope as Record<string, unknown>;
    expect(envelope).toMatchObject({ actorId: ownerId, sessionId: ownerSession, jobId });
    expect(envelope.operatorApproved).toBeUndefined();
  });

  it("plans a job again that was in review, dropping the interrupted attempt's plan", async () => {
    let jobId = "";
    const flow = await restart((db, { sessionId }) => {
      jobId = db.createJob({
        sessionId, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false,
        output: {
          explanation: { phase: "reviewing", intent: changeIntent, reason: "reviewing" }, request: { ...changeRequest, execute: false },
          plan: "## stale plan of the interrupted attempt", proposalPath: "/nonexistent/old.md",
        },
      }).id;
    });
    const job = await flow.settled(jobId);

    expect(job.status).toBe("completed");
    expect((job.output?.explanation as Record<string, unknown>).reason).toBe("Plan-only request completed without execution.");
    expect(job.output?.plan).toBe(plan);
    expect(job.output?.restarts).toEqual([expect.objectContaining({ phase: "reviewing", action: "replanned" })]);
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
  });

  it("researches again for a research job that was planning", async () => {
    let jobId = "";
    const flow = await restart((db, { sessionId }) => {
      jobId = db.createJob({
        sessionId, kind: "agent", subjectId: "hermes-research", status: "running", requiresApproval: false,
        output: {
          explanation: { phase: "planning", intent: "Which image does James run?", reason: "Planner is performing read-only research." },
          request: { intent: "Which image does James run?", evidence: [], ownedSession: false },
        },
      }).id;
    });
    const job = await flow.settled(jobId);

    expect(job.status).toBe("completed");
    expect(String(job.output?.answer)).toContain("0240fa4a");
    expect(job.output?.restarts).toEqual([expect.objectContaining({ phase: "planning", action: "replanned" })]);
    expect(flow.agentCalls.map((call) => call.role)).toEqual(["research"]);
  });

  it("ends what it cannot take up again, with the reason on the job, and never runs it", async () => {
    const ids: Record<string, string> = {};
    const flow = await restart((db, { sessionId }) => {
      const make = (key: string, output: Record<string, unknown>) => {
        ids[key] = db.createJob({ sessionId, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false, output }).id;
      };
      // Recorded before this change: no request to plan from.
      make("legacy", { explanation: planning(changeIntent) });
      // Execution had started outside the host door: steps may have run.
      make("executing", { explanation: { phase: "executing", intent: changeIntent, reason: "running" }, request: changeRequest, plan });
      // Two restarts already: the limit.
      make("limit", { explanation: planning(changeIntent), request: changeRequest, restarts: [
        { at: "2026-10-16T15:00:00.000Z", phase: "planning", action: "replanned", reason: "restart during planning" },
        { at: "2026-10-16T15:05:00.000Z", phase: "planning", action: "replanned", reason: "restart during planning" },
      ] });
    });
    const reasons: Record<string, string> = {};
    for (const key of ["legacy", "executing", "limit"]) {
      const job = await flow.settled(ids[key]);
      expect(job.status, key).toBe("failed_execution");
      const restarts = job.output?.restarts as Array<Record<string, unknown>>;
      expect(restarts.at(-1), key).toMatchObject({ action: "abandoned" });
      reasons[key] = String((job.output?.explanation as Record<string, unknown>).reason);
      expect(reasons[key], key).toContain("The Cockpit restarted while this job was running");
    }
    expect(reasons.legacy).toContain("no recorded request");
    expect(reasons.executing).toContain("phase executing");
    expect(reasons.limit).toContain("already planned again 2 times");
    // The executing job keeps what it reached; nothing is repeated.
    expect(flow.inspect.getJob(ids.executing)?.output?.plan).toBe(plan);
    expect(flow.agentCalls).toHaveLength(0);
    expect(flow.executorCalls).toHaveLength(0);
    // A restart is not a failure of the change runtime: the circuit breaker does not count it.
    const db = new BetterSqlite3(path.join(flow.dir, "cockpit.sqlite"), { readonly: true });
    cleanup.push(() => db.close());
    const audits = db.prepare("SELECT action, target_id AS targetId FROM audits").all() as Array<{ action: string; targetId: string }>;
    expect(audits.filter((audit) => audit.action === "hermes.change.failed")).toEqual([]);
    expect(audits.filter((audit) => audit.action === "hermes.job.abandoned").map((audit) => audit.targetId).sort()).toEqual([ids.legacy, ids.executing, ids.limit].sort());
  });

  it("does not plan a job again whose last progress is old", async () => {
    let jobId = "";
    const flow = await restart((db, { sessionId, dbPath }) => {
      jobId = db.createJob({
        sessionId, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false,
        output: { explanation: planning(changeIntent), request: changeRequest },
      }).id;
      // Left behind long ago: an old intent must not run unannounced.
      const raw = new BetterSqlite3(dbPath);
      raw.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 60 * 60_000).toISOString(), jobId);
      raw.close();
    });
    const job = await flow.settled(jobId);

    expect(job.status).toBe("failed_execution");
    expect(String((job.output?.explanation as Record<string, unknown>).reason)).toMatch(/last progress is 1\d\d min old/);
    expect(flow.agentCalls).toHaveLength(0);
  });

  it("reports the jobs a restart would interrupt on /api/health, without host-run followers", async () => {
    const flow = await restart(() => undefined);
    const admin = flow.inspect.authenticateUser("admin", "test-password")!;
    const session = flow.inspect.upsertSession({ name: "hermes-rb-y", ownerId: admin.id, tmuxSessionName: "cockpit-hermes-rb-y", tmuxBackend: "tmux", terminalUrl: null });
    const make = (subjectId: string, output: Record<string, unknown>) =>
      flow.inspect.createJob({ sessionId: session.id, kind: "runbook", subjectId, status: "running", requiresApproval: false, output });
    const idle = await flow.app.inject({ method: "GET", url: "/api/health" });
    expect(idle.json().jobs).toEqual({ active: 0, phases: {} });

    make("hermes-change", { explanation: planning(changeIntent) });
    make("hermes-research", { explanation: { phase: "planning", intent: "x", reason: "y" } });
    make("hermes-change", { explanation: { phase: "executing", intent: changeIntent, reason: "y" }, hostRunStartedAt: new Date().toISOString() });
    make("other-runbook", { explanation: planning(changeIntent) });
    const busy = await flow.app.inject({ method: "GET", url: "/api/health" });
    expect(busy.json().jobs).toEqual({ active: 2, phases: { planning: 2 } });
  });
});

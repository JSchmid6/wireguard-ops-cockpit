import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// The change circuit breaker through the API (incident 22.10.2026, card
// t_dc5c96c6): only real host failures count, per operation, with a higher
// global cap; the operator lets one blocked job through with the approval link.

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
    maxFailedChangesPerHourGlobal: 10,
    agentBrokerSocket: null, executorBrokerSocket: null, executorBrokerSecret: null, nodeEnv: "development",
    ...overrides,
  };
}

const hostRun = {
  version: "cockpit-host-run/v1", name: "apt maintenance", purpose: "update packages from the configured sources", mutates: true,
  steps: [{ name: "upgrade", run: "apt-get update && apt-get -y upgrade" }],
  checks: [{ name: "nothing pending", run: "test -z \"$(apt list --upgradable 2>/dev/null | tail -n +2)\"" }],
  rollback: ["downgrade the upgraded packages to the versions in /var/log/apt/history.log"],
  risk: ["contained"],
};
const plan = ["```host-run", JSON.stringify(hostRun), "```", "## Intent", "Keep the host's packages current."].join("\n");

async function setup(overrides: Partial<AppConfig> = {}, slot: { pollMs?: number; waitMs?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "breaker-flow-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  seed.initialize();
  seed.seedAdmin("admin", "test-password");
  const admin = seed.authenticateUser("admin", "test-password")!;
  const automation = seed.createUser("hermes-automation", "unusable-random-password", "automation");
  const bearer = seed.rotateApiToken(automation.id, "hermes", ["POST /api/hermes/runbook", "POST /api/hermes/jobs/:jobId/approval", "POST /api/hermes/jobs/:jobId/withdraw"]);
  const session = seed.upsertSession({ name: "hermes-flow", ownerId: admin.id, tmuxSessionName: "cockpit-hermes-flow", tmuxBackend: "tmux", terminalUrl: null });
  // James' own session: a job he orders there is his to withdraw.
  const automationSession = seed.upsertSession({ name: "hermes-james", ownerId: automation.id, tmuxSessionName: "cockpit-hermes-james", tmuxBackend: "tmux", terminalUrl: null });
  seed.close();

  // The host run's outcome, switched per test step.
  // busy: so many starts the helper still refuses because another run holds the host.
  const host: { status: "success" | "failed"; doorkeeper: string; busy: number; busyMessage: string; plan: string } = {
    status: "failed", doorkeeper: "VERDICT: pass\nNOTES: routine apt maintenance", busy: 0, busyMessage: "another host run is active: 3e06625f-0000", plan,
  };
  const executorCalls = await listen(path.join(dir, "executor.sock"), (request) => {
    const expected = createHmac("sha256", BROKER_SECRET).update(JSON.stringify(request.payload)).digest("hex");
    if (request.signature !== expected) return { ok: false, error: "invalid request signature" };
    if (request.payload.action === "host.run" && host.busy > 0) {
      host.busy -= 1;
      // Wie der Executor-Broker: rc 75 des Helfers, stderr als Fehlertext.
      return { ok: false, error: host.busyMessage };
    }
    if (request.payload.action === "host.run") return { ok: true, output: JSON.stringify({ status: "started", jobId: request.payload.envelope.jobId }) };
    const ok = host.status === "success";
    return { ok: true, output: JSON.stringify({ ok: true, logTail: "upgraded", state: {
      phase: "finished", status: host.status, error: ok ? null : "1 check(s) failed", snapshot: { snapshotId: "snap-1" },
      steps: [{ index: 1, name: "upgrade", status: "success" }], checks: [{ index: 1, name: "nothing pending", status: ok ? "passed" : "failed" }],
    } }) };
  });
  const agentCalls = await listen(path.join(dir, "agent.sock"), (request) => {
    if (request.role === "planner") return { ok: true, output: host.plan };
    return { ok: true, output: "VERIFICATION_STATUS: passed\nEVIDENCE: no upgradable packages\nREASON: done" };
  });
  const app = await createApp({
    config: config(dir, { executorBrokerSocket: path.join(dir, "executor.sock"), executorBrokerSecret: BROKER_SECRET, agentBrokerSocket: path.join(dir, "agent.sock"), ...overrides }),
    hostRunReviewRunner: async () => host.doorkeeper,
    hostRunPollMs: 10,
    hostRunSlotPollMs: slot.pollMs ?? 10,
    hostRunSlotWaitMs: slot.waitMs,
  });
  cleanup.push(() => app.close());
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  cleanup.push(() => inspect.close());

  const settled = async (jobId: string) => {
    const deadline = Date.now() + 10_000;
    while (inspect.getJob(jobId)?.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return inspect.getJob(jobId)!;
  };
  const submit = async (payload: { intent?: string; operation?: unknown }) => {
    const created = await app.inject({
      method: "POST", url: "/api/hermes/runbook", headers: { cookie },
      payload: { intent: "Keep the host's packages current", sessionId: session.id, timeoutMs: 0, ...payload },
    });
    expect([200, 202]).toContain(created.statusCode);
    return settled((created.json().jobId ?? created.json().id) as string);
  };
  const failures = () => {
    const fingerprint = String(inspect.listAuditsSince("hermes.change.failed", "1970-01-01T00:00:00Z", 1)[0]?.details.runtimeFingerprint ?? "");
    return inspect.listChangeFailuresSince(new Date(Date.now() - 3_600_000).toISOString(), fingerprint);
  };
  const explanationOf = (job: { output?: Record<string, unknown> | null }) => job.output?.explanation as { reason: string; evidence: string[]; phase: string };
  return { app, cookie, bearer, automationSessionId: automationSession.id, host, executorCalls, agentCalls, submit, settled, inspect, failures, explanationOf };
}

const brokenIntent = (body: string) => `Contain the web shell\n\n\`\`\`host-run\n${body}\n\`\`\``;

describe("change circuit breaker through the API", () => {
  it("does not count refusals before execution, and names field and expected value", async () => {
    const flow = await setup();
    const wrongVersion = await flow.submit({ intent: brokenIntent(JSON.stringify({ ...hostRun, version: "cockpit-host-run/v2" })), operation: "t_f3d18d16" });
    expect(wrongVersion.status).toBe("failed_execution");
    expect(flow.explanationOf(wrongVersion).reason).toContain('field version must be "cockpit-host-run/v1", got "cockpit-host-run/v2"');
    const typo = await flow.submit({ intent: brokenIntent(JSON.stringify({ ...hostRun, steps: undefined, step: hostRun.steps })), operation: "t_f3d18d16" });
    expect(flow.explanationOf(typo).reason).toContain("field steps must be an array of 1-24 objects");
    expect(flow.explanationOf(typo).reason).toContain("fields not in the contract, ignored: step");
    const noRollback = await flow.submit({ intent: brokenIntent(JSON.stringify({ ...hostRun, rollback: [] })), operation: "t_f3d18d16" });
    expect(flow.explanationOf(noRollback).reason).toContain("field rollback must be an array with at least one non-empty string");
    const badJson = await flow.submit({ intent: brokenIntent("{\"version\": \"cockpit-host-run/v1\","), operation: "t_f3d18d16" });
    expect(flow.explanationOf(badJson).reason).toMatch(/host-run manifest is not valid JSON: \S/);

    // Four refusals of one operation, none of them a failure on the host.
    for (const job of [wrongVersion, typo, noRollback, badJson]) expect(flow.inspect.hasAudit("hermes.change.failed", job.id)).toBe(false);
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
    flow.host.status = "success";
    const next = await flow.submit({ operation: "t_f3d18d16" });
    expect(next.status).toBe("completed");
  });

  it("opens per operation after real failures; independent operations still run", async () => {
    const flow = await setup();
    const failed = [];
    for (let index = 0; index < 3; index += 1) failed.push(await flow.submit({ operation: "t_f3d18d16" }));
    for (const job of failed) {
      expect(job.status).toBe("failed_verification");
      expect(flow.inspect.hasAudit("hermes.change.failed", job.id)).toBe(true);
    }
    expect(flow.failures().map((failure) => failure.key)).toEqual(Array(3).fill("operation:t_f3d18d16"));

    const plannerCalls = flow.agentCalls.filter((call) => call.role === "planner").length;
    const blocked = await flow.submit({ operation: "t_f3d18d16" });
    expect(blocked.status).toBe("blocked_user_approval");
    const detail = flow.explanationOf(blocked);
    for (const job of failed) expect(detail.reason).toContain(job.id);
    const closesAt = new Date(Date.parse(flow.failures()[0].at) + 3_600_000).toISOString();
    expect(detail.reason).toContain(`It closes at ${closesAt}`);
    expect(detail.evidence).toContain(`closesAt=${closesAt}`);
    expect(detail.evidence).toContain("breakerKey=operation:t_f3d18d16");
    expect(blocked.output?.breaker).toMatchObject({ scope: "operation", count: 3, limit: 3, jobIds: failed.map((job) => job.id) });
    // Stopped before planning.
    expect(flow.agentCalls.filter((call) => call.role === "planner")).toHaveLength(plannerCalls);
    expect(flow.inspect.hasAudit("hermes.change.breaker_blocked", blocked.id)).toBe(true);

    // The inbox offers it to Jochen as an open card with its link.
    const inbox = await flow.app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: flow.cookie } });
    const card = (inbox.json().cards as Array<Record<string, unknown>>).find((entry) => entry.jobId === blocked.id)!;
    expect(card).toMatchObject({ kind: "hermes-change", expired: false, link: expect.stringContaining(`job-${blocked.id}`) });
    expect(String(card.reason)).toContain("Circuit breaker is open");

    // Frigate update and Ubuntu updates are other operations: not blocked.
    flow.host.status = "success";
    expect((await flow.submit({ operation: "t_b31c5e70" })).status).toBe("completed");
    expect((await flow.submit({ operation: "t_b90d7c5e" })).status).toBe("completed");
  });

  it("without an operation the intent is the key", async () => {
    const flow = await setup();
    for (let index = 0; index < 3; index += 1) await flow.submit({});
    expect((await flow.submit({})).status).toBe("blocked_user_approval");
    flow.host.status = "success";
    expect((await flow.submit({ intent: "Update the Frigate container to the patched release" })).status).toBe("completed");
  });

  it("keeps a higher global cap across operations", async () => {
    const flow = await setup({ maxFailedChangesPerHourGlobal: 4 });
    for (let index = 0; index < 4; index += 1) expect((await flow.submit({ operation: `t_op${index}` })).status).toBe("failed_verification");
    const blocked = await flow.submit({ operation: "t_fresh" });
    expect(blocked.status).toBe("blocked_user_approval");
    expect(blocked.output?.breaker).toMatchObject({ scope: "global", count: 4, limit: 4 });
    expect(flow.explanationOf(blocked).reason).toContain("global cap");
  });

  it("lets exactly one job through on the operator's approval, audited", async () => {
    const flow = await setup();
    for (let index = 0; index < 3; index += 1) await flow.submit({ operation: "t_f3d18d16" });
    const blocked = await flow.submit({ operation: "t_f3d18d16" });
    expect(blocked.status).toBe("blocked_user_approval");

    flow.host.status = "success";
    const approved = await flow.app.inject({
      method: "POST", url: `/api/hermes/jobs/${blocked.id}/approval`, headers: { cookie: flow.cookie },
      payload: { decision: "approved", reason: "Web-Shell muss sofort zu" },
    });
    expect(approved.statusCode).toBe(202);
    const job = await flow.settled(blocked.id);
    expect(job.status).toBe("completed");
    expect(flow.executorCalls.filter((call) => call.payload.action === "host.run").map((call) => call.payload.envelope.jobId)).toContain(blocked.id);
    expect(flow.inspect.hasAudit("hermes.change.breaker_override", blocked.id)).toBe(true);
    expect(flow.inspect.hasAudit("hermes.change.breaker_passed", blocked.id)).toBe(true);
    expect((job.output?.request as Record<string, unknown>).breakerOverride).toMatchObject({ reason: "Web-Shell muss sofort zu" });

    // Only that job: the next one of the operation stays blocked.
    expect((await flow.submit({ operation: "t_f3d18d16" })).status).toBe("blocked_user_approval");
    // A second approval of the job that already ran is refused.
    const again = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${blocked.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "nochmal" } });
    expect(again.statusCode).toBe(409);
  });

  it("counts a failure after the override as a real failure, and a rejection ends the job", async () => {
    const flow = await setup();
    for (let index = 0; index < 3; index += 1) await flow.submit({ operation: "t_x" });
    const first = await flow.submit({ operation: "t_x" });
    const overridden = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${first.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "Notfall" } });
    expect(overridden.statusCode).toBe(202);
    expect((await flow.settled(first.id)).status).toBe("failed_verification");
    expect(flow.inspect.hasAudit("hermes.change.failed", first.id)).toBe(true);

    const second = await flow.submit({ operation: "t_x" });
    expect(second.status).toBe("blocked_user_approval");
    const rejected = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${second.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "rejected", reason: "erst Ursache klaeren" } });
    expect(rejected.statusCode).toBe(200);
    expect(flow.inspect.getJob(second.id)?.status).toBe("rejected");
    expect(flow.inspect.hasAudit("hermes.change.breaker_override_rejected", second.id)).toBe(true);
  });

  it("does not count a refusal of the API before it reaches the host (no executor broker)", async () => {
    const flow = await setup({ executorBrokerSocket: null });
    const jobs = [];
    for (let index = 0; index < 4; index += 1) jobs.push(await flow.submit({ operation: "t_nobroker" }));
    for (const job of jobs) {
      expect(job.status).toBe("failed_execution");
      expect(flow.explanationOf(job).reason).toContain("executor broker is not configured");
      expect(job.output?.executionStartedAt).toBeUndefined();
      expect(flow.inspect.hasAudit("hermes.change.failed", job.id)).toBe(false);
    }
  });

  it("counts a failure after a normal operator approval (doorkeeper finding)", async () => {
    const flow = await setup();
    flow.host.doorkeeper = [
      "VERDICT: flag", "FINDING: upgrade without pinning", "CLASS: X5", "WHERE: S1:L1",
      "CODE: apt-get update && apt-get -y upgrade", "PATH: an upgrade can break a service", "SEVERITY: high",
    ].join("\n");
    const waiting = await flow.submit({ operation: "t_review" });
    expect(waiting.status).toBe("blocked_user_approval");
    expect(waiting.output?.breaker).toBeUndefined();
    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${waiting.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "plan ok" } });
    expect(approved.statusCode).toBe(202);
    const finished = await flow.settled(waiting.id);
    expect(finished.status).toBe("failed_verification");
    expect(typeof finished.output?.executionStartedAt).toBe("string");
    expect(flow.failures().map((failure) => failure.jobId)).toEqual([waiting.id]);
  });

  it("refuses the pass to an automation token and after its window", async () => {
    const flow = await setup({ approvalTtlMinutes: 0.001 });
    for (let index = 0; index < 3; index += 1) await flow.submit({ operation: "t_y" });
    const blocked = await flow.submit({ operation: "t_y" });
    expect(blocked.status).toBe("blocked_user_approval");
    const byToken = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${blocked.id}/approval`, headers: { authorization: `Bearer ${flow.bearer}` }, payload: { decision: "approved", reason: "selbst" } });
    expect(byToken.statusCode).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const late = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${blocked.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "zu spaet" } });
    expect(late.statusCode).toBe(409);
    expect(late.json().message).toContain("override window expired");
    expect(flow.inspect.getJob(blocked.id)?.status).toBe("blocked_user_approval");
    expect(flow.inspect.hasAudit("hermes.change.breaker_override", blocked.id)).toBe(false);
  });

  it("refuses a malformed operation with the field and the expected form", async () => {
    const flow = await setup();
    const response = await flow.app.inject({ method: "POST", url: "/api/hermes/runbook", headers: { cookie: flow.cookie }, payload: { intent: "Keep the host's packages current", operation: "a b" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ field: "operation", message: expect.stringContaining("expected 1-80 characters") });
  });

  // Karte t_9c04b4de (22.10.2026, Jobs 55d92118/bcc6dc38/58a95c8e): der Helfer
  // weist einen zweiten Start ab, solange ein Lauf aktiv ist oder startet. Das
  // ist kein Fehllauf; der Job wartet auf den Platz.
  it("queues a job while another host run holds the host and starts it once the host is free", async () => {
    const flow = await setup();
    flow.host.status = "success";
    flow.host.busy = 2;
    const job = await flow.submit({ operation: "t_queue" });
    expect(job.status).toBe("completed");
    const starts = flow.executorCalls.filter((call) => call.payload.action === "host.run");
    expect(starts).toHaveLength(3);
    expect(job.output?.hostRunQueue).toMatchObject({ refusals: 2, lastRefusal: "another host run is active: 3e06625f-0000" });
    expect(flow.explanationOf(job).phase).toBe("finished");
    expect(flow.inspect.hasAudit("hermes.host_run.queued", job.id)).toBe(true);
    expect(flow.inspect.hasAudit("hermes.host_run.started", job.id)).toBe(true);
  });

  it("counts a real failure after the wait once, not the refusals before it", async () => {
    const flow = await setup();
    flow.host.busy = 3;
    flow.host.busyMessage = "another host run is starting";
    const job = await flow.submit({ operation: "t_queue_fail" });
    expect(job.status).toBe("failed_verification");
    expect(typeof job.output?.executionStartedAt).toBe("string");
    expect(flow.failures().map((failure) => failure.jobId)).toEqual([job.id]);
  });

  it("ends a job that finds no free slot as blocked_runner_busy, outside the breaker", async () => {
    const flow = await setup({}, { pollMs: 10, waitMs: 60 });
    flow.host.busy = Number.POSITIVE_INFINITY;
    const jobs = [];
    // Mehr als die Grenze des Vorgangs (3): keiner davon öffnet den Breaker.
    for (let index = 0; index < 4; index += 1) jobs.push(await flow.submit({ operation: "t_busy" }));
    for (const job of jobs) {
      expect(job.status).toBe("blocked_runner_busy");
      expect(job.output?.executionStartedAt).toBeUndefined();
      expect(job.output?.hostRunRequestedAt).toBeUndefined();
      expect(job.output?.breaker).toBeUndefined();
      expect(flow.explanationOf(job).reason).toContain("another host run is active: 3e06625f-0000");
      expect(flow.explanationOf(job).reason).toContain("nothing was executed");
      expect(flow.inspect.hasAudit("hermes.change.failed", job.id)).toBe(false);
    }
    expect(flow.failures()).toEqual([]);
    expect(flow.executorCalls.some((call) => call.payload.action === "host.status")).toBe(false);
  });

  it("lets James withdraw a job while it waits for the host; nothing starts afterwards", async () => {
    const flow = await setup({}, { pollMs: 200, waitMs: 60_000 });
    flow.host.busy = Number.POSITIVE_INFINITY;
    const created = await flow.app.inject({
      method: "POST", url: "/api/hermes/runbook", headers: { authorization: `Bearer ${flow.bearer}` },
      payload: { intent: "Keep the host's packages current", sessionId: flow.automationSessionId, timeoutMs: 0, operation: "t_wait" },
    });
    const jobId = created.json().jobId as string;
    const deadline = Date.now() + 10_000;
    while ((flow.inspect.getJob(jobId)?.output?.explanation as { phase?: string } | undefined)?.phase !== "waiting_for_host" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(flow.inspect.getJob(jobId)?.output?.hostRunRequestedAt).toBeUndefined();
    // Trifft das Zurückziehen genau einen neuen Startversuch, lehnt die API es ab
    // (der Start ist angefragt); im nächsten Wartetakt geht es durch.
    let withdrawn = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${jobId}/withdraw`, headers: { authorization: `Bearer ${flow.bearer}` }, payload: { reason: "Karte erledigt" } });
    while (withdrawn.statusCode === 403 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      withdrawn = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${jobId}/withdraw`, headers: { authorization: `Bearer ${flow.bearer}` }, payload: { reason: "Karte erledigt" } });
    }
    expect(withdrawn.statusCode).toBe(200);
    const startsAtWithdrawal = flow.executorCalls.filter((call) => call.payload.action === "host.run").length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(flow.inspect.getJob(jobId)?.status).toBe("withdrawn");
    expect(flow.executorCalls.filter((call) => call.payload.action === "host.run").length).toBe(startsAtWithdrawal);
    expect(flow.inspect.hasAudit("hermes.change.failed", jobId)).toBe(false);
  });

  it("keeps a queued job's approval alive: the envelope gets a fresh expiry, same content", async () => {
    // Freigabefenster 1,2 s, Host 2 s belegt: Ohne neue Frist käme der Start zu spät.
    const flow = await setup({ approvalTtlMinutes: 0.02 }, { pollMs: 100, waitMs: 60_000 });
    flow.host.status = "success";
    flow.host.busy = 20;
    const job = await flow.submit({ operation: "t_queue_extend" });
    expect(job.status).toBe("completed");
    const starts = flow.executorCalls.filter((call) => call.payload.action === "host.run");
    const first = starts[0].payload.envelope;
    const last = starts.at(-1)!.payload.envelope;
    expect(Date.parse(last.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    for (const key of ["jobId", "actorId", "sessionId", "intentHash", "planHash", "safetyHash", "policyHash", "manifestHash", "gatePassed", "capabilities"]) {
      expect(last[key]).toEqual(first[key]);
    }
    expect(last.operatorApproved).toBeUndefined();
    expect(starts.at(-1)!.payload.expiresAt).toBe(last.expiresAt);
    expect(starts.at(-1)!.payload.envelopeDigest).toBe(last.digest);
    expect(flow.inspect.hasAudit("hermes.host_run.envelope_extended", job.id)).toBe(true);
    expect((job.output?.hostRunQueue as { extensions: number }).extensions).toBeGreaterThan(0);
  }, 15_000);

  it("keeps the operator's approval while the approved job waits for the host", async () => {
    // Vorfall 24.10.2026 (Job a6ffb1fb): freigegeben, dann hinter einem anderen Lauf verfallen.
    const flow = await setup({ approvalTtlMinutes: 0.02 }, { pollMs: 100, waitMs: 60_000 });
    flow.host.plan = plan.replace('"risk":["contained"]', '"risk":["exposure"]');
    const blocked = await flow.submit({ operation: "t_queue_approved" });
    expect(blocked.status).toBe("blocked_user_approval");
    flow.host.status = "success";
    flow.host.busy = 20;
    const approved = await flow.app.inject({
      method: "POST", url: `/api/hermes/jobs/${blocked.id}/approval`, headers: { cookie: flow.cookie },
      payload: { decision: "approved", reason: "Rotation sofort" },
    });
    expect(approved.statusCode).toBe(202);
    // Beim Warten läuft der Job: kein Endstatus und kein completedAt aus der Zeit vor dem Klick.
    const deadline = Date.now() + 10_000;
    while ((flow.inspect.getJob(blocked.id)?.output?.explanation as { phase?: string } | undefined)?.phase !== "waiting_for_host" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const waiting = flow.inspect.getJob(blocked.id)!;
    expect(waiting.status).toBe("running");
    expect(waiting.completedAt).toBeNull();
    const job = await flow.settled(blocked.id);
    expect(job.status).toBe("completed");
    const starts = flow.executorCalls.filter((call) => call.payload.action === "host.run" && call.payload.envelope.jobId === blocked.id);
    const first = starts[0].payload.envelope;
    const last = starts.at(-1)!.payload.envelope;
    expect(first.operatorApproved).toBe(true);
    expect(last.operatorApproved).toBe(true);
    expect(last.planHash).toBe((blocked.output?.envelope as { planHash: string }).planHash);
    expect(last.manifestHash).toBe((blocked.output?.envelope as { manifestHash: string }).manifestHash);
    expect(Date.parse(last.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    expect(flow.inspect.hasAudit("hermes.host_run.envelope_extended", blocked.id)).toBe(true);
  }, 15_000);

  it("waits in the queue no longer than its limit, even with fresh expiries", async () => {
    const flow = await setup({ approvalTtlMinutes: 0.02 }, { pollMs: 50, waitMs: 1_500 });
    flow.host.busy = Number.POSITIVE_INFINITY;
    const started = Date.now();
    const job = await flow.submit({ operation: "t_queue_limit" });
    expect(job.status).toBe("blocked_runner_busy");
    expect(Date.now() - started).toBeLessThan(6_000);
    const queue = job.output?.hostRunQueue as { waitingSince: string; notAfter: string };
    expect(Date.parse(queue.notAfter) - Date.parse(queue.waitingSince)).toBe(1_500);
    const envelope = job.output?.envelope as { expiresAt: string };
    expect(Date.parse(envelope.expiresAt)).toBeLessThanOrEqual(Date.parse(queue.notAfter));
    expect(flow.explanationOf(job).reason).toContain("queue limit");
    expect(flow.inspect.hasAudit("hermes.change.failed", job.id)).toBe(false);
  }, 15_000);
});

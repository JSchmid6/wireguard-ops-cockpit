import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// The general host door through the API: planner → doorkeeper → start or
// operator. The planner and verifier answer from a fake agent broker, the
// doorkeeper is the injected review runner, the executor a fake broker that
// speaks the real wire format. What is checked is the API's decision: no
// deterministic rule (plan policy, protected paths, borg repair) stops a
// host-run plan; only the doorkeeper does.

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

// The 30.09. case (/etc/apt with *.save and ~ files): it used to stop by rule;
// here only the doorkeeper decides.
const hostRun = {
  version: "cockpit-host-run/v1", name: "apt maintenance", purpose: "update packages from the configured sources", mutates: true,
  steps: [
    { name: "sources", run: "ls -l /etc/apt/sources.list.save /etc/apt/trusted.gpg~" },
    { name: "upgrade", run: "apt-get update && apt-get -y upgrade" },
  ],
  checks: [{ name: "nothing pending", run: "test -z \"$(apt list --upgradable 2>/dev/null | tail -n +2)\"" }],
  rollback: ["downgrade the upgraded packages to the versions in /var/log/apt/history.log"],
  risk: ["contained"],
};
// Plus a borg repair: a repair can delete archives, so the backup bolt sends
// it to the operator whatever the doorkeeper says.
const hostRunWithRepair = { ...hostRun, steps: [...hostRun.steps, { name: "repair", run: "/usr/local/sbin/cockpit-borg-action repair" }] };
const planWith = (...manifests: Array<{ version: string }>) => [
  ...manifests.map((manifest) => "```" + (manifest.version.startsWith("cockpit-capability") ? "capability" : "host-run") + "\n" + JSON.stringify(manifest) + "\n```"),
  "## Intent", "Keep the host's packages current.",
].join("\n");

async function setup(options: { plan: string; doorkeeper: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "host-run-flow-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  seed.initialize();
  seed.seedAdmin("admin", "test-password");
  const admin = seed.authenticateUser("admin", "test-password")!;
  const session = seed.upsertSession({ name: "hermes-flow", ownerId: admin.id, tmuxSessionName: "cockpit-hermes-flow", tmuxBackend: "tmux", terminalUrl: null });
  seed.close();

  const executorCalls = await listen(path.join(dir, "executor.sock"), (request) => {
    const expected = createHmac("sha256", BROKER_SECRET).update(JSON.stringify(request.payload)).digest("hex");
    if (request.signature !== expected) return { ok: false, error: "invalid request signature" };
    if (request.payload.action === "host.run") return { ok: true, output: JSON.stringify({ status: "started", jobId: request.payload.envelope.jobId }) };
    return { ok: true, output: JSON.stringify({ ok: true, logTail: "upgraded", state: {
      phase: "finished", status: "success", error: null, snapshot: { snapshotId: "snap-1" },
      steps: [{ index: 1, name: "sources", status: "success" }], checks: [{ index: 1, name: "nothing pending", status: "passed" }],
    } }) };
  });
  const agentCalls = await listen(path.join(dir, "agent.sock"), (request) => request.role === "planner"
    ? { ok: true, output: options.plan }
    : { ok: true, output: "VERIFICATION_STATUS: passed\nEVIDENCE: no upgradable packages\nREASON: done" });
  const doorkeeperPrompts: string[] = [];
  const app = await createApp({
    config: config(dir, { executorBrokerSocket: path.join(dir, "executor.sock"), executorBrokerSecret: BROKER_SECRET, agentBrokerSocket: path.join(dir, "agent.sock") }),
    hostRunReviewRunner: async (prompt) => { doorkeeperPrompts.push(prompt); return options.doorkeeper; },
    hostRunPollMs: 10,
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
  const submit = async () => {
    const created = await app.inject({ method: "POST", url: "/api/hermes/runbook", headers: { cookie }, payload: { intent: "Keep the host's packages current", sessionId: session.id, timeoutMs: 0 } });
    expect(created.statusCode).toBe(202);
    return settled(created.json().jobId as string);
  };
  return { app, cookie, executorCalls, agentCalls, doorkeeperPrompts, submit, settled };
}

describe("host door through the API", () => {
  it("starts the run on the doorkeeper's pass, although rules would have flagged the plan", async () => {
    const flow = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: pass\nNOTES: routine apt maintenance" });
    const job = await flow.submit();

    expect(job.status).toBe("completed");
    expect(flow.doorkeeperPrompts).toHaveLength(1);
    expect(flow.doorkeeperPrompts[0]).toContain("S1:L1  ls -l /etc/apt/sources.list.save /etc/apt/trusted.gpg~");
    expect(flow.doorkeeperPrompts[0]).toContain("[protected-path]");
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope).toMatchObject({ gatePassed: true, capabilities: ["host.run"], jobId: job.id });
    expect(start.payload.envelope.operatorApproved).toBeUndefined();
    expect(job.output?.result).toContain("STATUS: success");
    expect(flow.agentCalls.map((call) => call.role)).toEqual(["planner", "verifier"]);
  });

  it("sends an evidenced finding to the operator, and runs exactly that plan after approval", async () => {
    const flow = await setup({ plan: planWith(hostRunWithRepair), doorkeeper: [
      "VERDICT: flag",
      "FINDING: borg repair without the operator",
      "CLASS: X4",
      "WHERE: S3:L1",
      "CODE: /usr/local/sbin/cockpit-borg-action repair",
      "PATH: a repair can drop damaged archives from the only off-host backup; no snapshot restores them",
      "SEVERITY: high",
    ].join("\n") });
    const job = await flow.submit();

    expect(job.status).toBe("blocked_user_approval");
    expect((job.output?.envelope as Record<string, unknown>).gatePassed).toBeUndefined();
    expect(JSON.stringify(job.output?.policy)).toContain("S3:L1");
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);

    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${job.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved" } });
    expect(approved.statusCode).toBe(202);
    const finished = await flow.settled(job.id);
    expect(finished.status).toBe("completed");
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope.gatePassed).toBeUndefined();
    expect(start.payload.envelope).toMatchObject({ operatorApproved: true, manifestHash: (job.output?.envelope as Record<string, unknown>).manifestHash });
    expect(start.payload.manifest).toEqual(job.output?.hostRun);
  });

  it("keeps a run that deletes backups for the operator although the doorkeeper passed it", async () => {
    const prune = { ...hostRun, name: "free space", purpose: "free space on Lab0", steps: [
      { name: "space", run: "df -h /" },
      { name: "delete", run: "borg delete --glob-archives 'vmd61162-2025-*' ssh://borg@10.0.0.5/media/RAID/backup_VServer/borg" },
    ] };
    const flow = await setup({ plan: planWith(prune), doorkeeper: "VERDICT: pass\nNOTES: the operator asked for it" });
    const job = await flow.submit();

    expect(job.status).toBe("blocked_user_approval");
    const policy = job.output?.policy as { reason: string; evidence: string[] };
    expect(policy.reason).toContain("touches the backups");
    expect(policy.evidence.join("\n")).toContain("BACKUP [backup] S2:L1");
    expect((job.output?.envelope as Record<string, unknown>).gatePassed).toBeUndefined();
    expect(flow.doorkeeperPrompts[0]).toContain("[backup-approval:backup]");
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);

    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${job.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved" } });
    expect(approved.statusCode).toBe(202);
    expect((await flow.settled(job.id)).status).toBe("completed");
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope).toMatchObject({ operatorApproved: true });
    expect(start.payload.envelope.gatePassed).toBeUndefined();
  });

  it("stops without an approval offer when the doorkeeper flags without evidence", async () => {
    const flow = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: flag\nFINDING: looks risky\nCLASS: X5\nWHERE: somewhere\nCODE: rm -rf /\nPATH: could break things" });
    const job = await flow.submit();
    expect(job.status).toBe("blocked_prerequisite");
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
  });

  it("refuses a plan that carries both a capability and a host-run manifest", async () => {
    const capability = {
      version: "cockpit-capability/v1", name: "read", purpose: "read a file", steps: [{ argv: ["/usr/bin/true"], cwd: "/tmp", runAsUser: "nobody" }],
      readablePaths: [], writablePaths: [], network: "none", expectedEffects: ["none"], verification: ["exit 0"], rollback: ["none needed"], risk: ["contained"],
    };
    const flow = await setup({ plan: planWith(hostRun, capability), doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(job.status).toBe("failed_execution");
    expect(JSON.stringify(job.output)).toContain("one door per job");
    expect(flow.doorkeeperPrompts).toHaveLength(0);
    expect(flow.executorCalls).toHaveLength(0);
  });
});

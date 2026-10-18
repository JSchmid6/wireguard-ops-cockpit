import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, verifierInstruction } from "../src/app.js";
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

async function setup(options: { plan: string; doorkeeper: string; intent?: string; ownedByAutomation?: boolean; hostState?: () => Record<string, unknown> | null; instanceRole?: "vps" | "lab0" | null; doorkeeperWait?: Promise<void> }) {
  const dir = mkdtempSync(path.join(tmpdir(), "host-run-flow-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  seed.initialize();
  seed.seedAdmin("admin", "test-password");
  const admin = seed.authenticateUser("admin", "test-password")!;
  // Im Betrieb bestellt James mit seinem Automation-Konto; die Sitzung gehört
  // dann ihm, freigeben tut Jochens Admin-Sitzung.
  const owner = options.ownedByAutomation ? seed.createUser("hermes-automation", "unusable-random-password", "automation") : admin;
  const bearer = options.ownedByAutomation ? seed.rotateApiToken(owner.id, "hermes", ["POST /api/hermes/runbook", "POST /api/hermes/jobs/:jobId/withdraw"]) : null;
  const session = seed.upsertSession({ name: "hermes-flow", ownerId: owner.id, tmuxSessionName: "cockpit-hermes-flow", tmuxBackend: "tmux", terminalUrl: null });
  seed.close();

  const executorCalls = await listen(path.join(dir, "executor.sock"), (request) => {
    const expected = createHmac("sha256", BROKER_SECRET).update(JSON.stringify(request.payload)).digest("hex");
    if (request.signature !== expected) return { ok: false, error: "invalid request signature" };
    if (request.payload.action === "host.run") return { ok: true, output: JSON.stringify({ status: "started", jobId: request.payload.envelope.jobId }) };
    const live = options.hostState?.();
    if (live) return { ok: true, output: JSON.stringify({ ok: true, logTail: "running", state: live }) };
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
    config: config(dir, { executorBrokerSocket: path.join(dir, "executor.sock"), executorBrokerSecret: BROKER_SECRET, agentBrokerSocket: path.join(dir, "agent.sock"), instanceRole: options.instanceRole ?? null }),
    hostRunReviewRunner: async (prompt) => { doorkeeperPrompts.push(prompt); await options.doorkeeperWait; return options.doorkeeper; },
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
  const intent = options.intent ?? "Keep the host's packages current";
  // 200 when the job is already finished at the answer (it stopped before the planner).
  const submit = async (status = 202) => {
    const created = await app.inject({ method: "POST", url: "/api/hermes/runbook", headers: bearer ? { authorization: `Bearer ${bearer}` } : { cookie }, payload: { intent, sessionId: session.id, timeoutMs: 0 } });
    expect(created.statusCode).toBe(status);
    return settled((created.json().jobId ?? created.json().id) as string);
  };
  const submitted = async () => {
    const created = await app.inject({ method: "POST", url: "/api/hermes/runbook", headers: bearer ? { authorization: `Bearer ${bearer}` } : { cookie }, payload: { intent, sessionId: session.id, timeoutMs: 0 } });
    expect(created.statusCode).toBe(202);
    return created.json().jobId as string;
  };
  return { dir, app, cookie, bearer, executorCalls, agentCalls, doorkeeperPrompts, submit, submitted, settled, inspect };
}

describe("verifier instruction", () => {
  it("lets only a handoff the Cockpit built stand in for root-only state; a runner agent's text proves nothing", () => {
    const api = verifierInstruction("i", "", true);
    const agent = verifierInstruction("i");
    expect(api).toContain("that is your sandbox, not evidence against the handoff");
    expect(api).toContain("signed runner handoff");
    expect(agent).not.toContain("your sandbox");
    expect(agent).not.toContain("signed");
    expect(agent).toContain("A condition you cannot read yourself is unproven, not passed.");
    expect(agent).toContain("Do not trust the runner's STATUS claim.");
  });
});

describe("host door through the API", () => {
  it("tells the doorkeeper on which host it stands: Lab0 from the instance role, the production host without one", async () => {
    const lab0 = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: pass", instanceRole: "lab0" });
    await lab0.submit();
    expect(lab0.doorkeeperPrompts[0]).toContain("general host door on Lab0 (10.0.0.5)");
    expect(lab0.doorkeeperPrompts[0]).not.toContain("run as root on the production host");
    const unknown = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: pass" });
    await unknown.submit();
    expect(unknown.doorkeeperPrompts[0]).toContain("run as root on the production host");
    expect(unknown.doorkeeperPrompts[0]).not.toContain("door on Lab0");
  });

  it("runs nothing when James withdraws the job while the doorkeeper still reviews it", async () => {
    let release!: () => void;
    const doorkeeperWait = new Promise<void>((resolve) => { release = resolve; });
    const flow = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: pass", ownedByAutomation: true, doorkeeperWait });
    const jobId = await flow.submitted();
    const deadline = Date.now() + 10_000;
    while (flow.doorkeeperPrompts.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flow.inspect.getJob(jobId)?.output?.explanation).toMatchObject({ phase: "reviewing" });

    const withdrawn = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${jobId}/withdraw`, headers: { authorization: `Bearer ${flow.bearer}` }, payload: { reason: "Karte erledigt, Auftrag neu bestellt" } });
    expect(withdrawn.statusCode).toBe(200);
    release();
    // Nach der Freigabe des Tuersteherlaufs: Policy, Envelope, Startpruefung -- ohne
    // weitere Agentenaufrufe; 500 ms reichen um Groessenordnungen (Red-Check: ohne
    // Waechter steht der Job in dieser Zeit schon auf "completed").
    await new Promise((resolve) => setTimeout(resolve, 500));

    const job = flow.inspect.getJob(jobId)!;
    expect(job.status).toBe("withdrawn");
    expect(job.output?.withdrawal).toMatchObject({ reason: "Karte erledigt, Auftrag neu bestellt", previousStatus: "running", previousPhase: "reviewing" });
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
    expect(flow.agentCalls.map((call) => call.role)).toEqual(["planner"]);
    expect(flow.inspect.hasAudit("hermes.change.failed", jobId)).toBe(false);
  });

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
    // Root-only state is the sandbox's blind spot, not counter-evidence (Lab0 c06456ce, 16.10.2026).
    const verifier = String(flow.agentCalls[1].prompt);
    expect(verifier).toContain("First evaluate the supplied signed runner handoff's raw command output");
    expect(verifier).toContain("You run without root: state that only root may read (for example cockpit-self-update-action status");
  });

  // Lab0 job 4553505c (18.10.2026): the same manifest in a bash fence went to
  // the legacy path (service.manage + shell.exception, blocked_user_approval).
  it("takes a host-run manifest from a bash fence through the door", async () => {
    const flow = await setup({ plan: "```bash\n" + JSON.stringify(hostRun) + "\n```\n## Intent\nKeep the host's packages current.", doorkeeper: "VERDICT: pass\nNOTES: routine" });
    const job = await flow.submit();
    expect(job.status).toBe("completed");
    expect(flow.doorkeeperPrompts).toHaveLength(1);
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope).toMatchObject({ gatePassed: true, capabilities: ["host.run"], jobId: job.id });
    expect(flow.agentCalls.some((call) => call.role === "runner")).toBe(false);
  });

  it("takes it as well when the plan's sections come before the bash fence", async () => {
    const flow = await setup({ plan: "## Intent\nKeep the host's packages current.\n## Plan\n```bash\n" + JSON.stringify(hostRun) + "\n```\n## Risk Zone\nyellow", doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(job.status).toBe("completed");
    expect(flow.executorCalls.find((call) => call.payload.action === "host.run")!.payload.manifest).toEqual(job.output?.hostRun);
  });

  it("leaves shell code in a bash fence on the legacy path, even when it carries the manifest text", async () => {
    const script = `echo '${JSON.stringify(hostRun)}' > /tmp/m.json\nsystemctl stop android-emulator.service`;
    const flow = await setup({ plan: "```bash\n" + script + "\n```\n## Intent\nKeep the host's packages current.", doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(flow.doorkeeperPrompts).toHaveLength(0);
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
    expect(job.output?.hostRun ?? null).toBeNull();
  });

  // B1 of the second review (t_4e06a3e2): the cleaner had its own bash-fence
  // regex and cut a shell fence in front of the JSON fence out of the stored
  // plan, so the job went through the door. The door is decided only by the
  // plan's script, the FIRST bash/sh fence.
  it("keeps a shell fence in front of a JSON bash fence on the legacy path", async () => {
    const flow = await setup({ plan: "```bash\nsystemctl stop android-emulator.service\n```\n```bash\n" + JSON.stringify(hostRun) + "\n```\n## Intent\nKeep the host's packages current.", doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(flow.doorkeeperPrompts).toHaveLength(0);
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
    expect(job.output?.hostRun ?? null).toBeNull();
  });

  it("stores the shell fence in front of a JSON bash fence in the plan", async () => {
    const flow = await setup({ plan: "## Intent\nKeep the host's packages current.\n## Plan\n```bash\nsystemctl stop android-emulator.service\n```\n```bash\n" + JSON.stringify(hostRun) + "\n```\n## Risk Zone\nyellow", doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(flow.doorkeeperPrompts).toHaveLength(0);
    expect(flow.executorCalls.some((call) => call.payload.action === "host.run")).toBe(false);
    expect(job.output?.hostRun ?? null).toBeNull();
    const plan = readFileSync(path.join(flow.dir, "proposals", `${job.id}.md`), "utf-8");
    expect(plan).toContain("```bash\nsystemctl stop android-emulator.service\n```");
    expect(plan.indexOf("systemctl stop")).toBeLessThan(plan.indexOf("cockpit-host-run/v1"));
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

    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${job.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "read the finding, this exact plan is fine" } });
    expect(approved.statusCode).toBe(202);
    const finished = await flow.settled(job.id);
    expect(finished.status).toBe("completed");
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope.gatePassed).toBeUndefined();
    expect(start.payload.envelope).toMatchObject({ operatorApproved: true, manifestHash: (job.output?.envelope as Record<string, unknown>).manifestHash });
    expect(start.payload.manifest).toEqual(job.output?.hostRun);
    // After the approval the same verifier instruction as on the direct path.
    const verifier = flow.agentCalls.filter((call) => call.role === "verifier").map((call) => String(call.prompt));
    expect(verifier).toHaveLength(1);
    expect(verifier[0]).toContain("First evaluate the supplied signed runner handoff's raw command output");
    expect(verifier[0]).toContain("that is your sandbox, not evidence against the handoff");
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

    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${job.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "read the finding, this exact plan is fine" } });
    expect(approved.statusCode).toBe(202);
    expect((await flow.settled(job.id)).status).toBe("completed");
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.envelope).toMatchObject({ operatorApproved: true });
    expect(start.payload.envelope.gatePassed).toBeUndefined();
  });

  it("runs James' job after Jochen's admin approval, in the session James owns", async () => {
    const flow = await setup({ ownedByAutomation: true, plan: planWith(hostRunWithRepair), doorkeeper: "VERDICT: pass\nNOTES: routine" });
    const job = await flow.submit();
    expect(job.status).toBe("blocked_user_approval");

    const withoutReason = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${job.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved" } });
    expect(withoutReason.statusCode).toBe(400);
    expect(withoutReason.json().message).toContain("reason");

    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${job.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "repair is wanted, snapshot exists" } });
    expect(approved.statusCode).toBe(202);
    const finished = await flow.settled(job.id);
    expect(finished.status).toBe("completed");
    expect(flow.executorCalls.find((call) => call.payload.action === "host.run")!.payload.envelope).toMatchObject({ operatorApproved: true });
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

// Vorfall 11.10.2026: ein Zustandsschritt wird nie beendet. Die API gibt einen
// Lauf, den der Helfer noch als aktiv meldet, nicht auf, und meldet die
// Überziehung dem Operator über GET /api/inbox (attention), den James weiterreicht.
describe("host door: uninterruptible steps through the API", () => {
  it("shows the doorkeeper which steps are never ended", async () => {
    const flow = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: pass\nNOTES: routine" });
    await flow.submit();
    const prompt = flow.doorkeeperPrompts[0];
    expect(prompt).toContain('S2 "upgrade" (time limit 1800 s, uninterruptible: never ended at the limit, only reported (detected:package, mutating-run))');
  });

  it("records an overrun on the job, lists it in the inbox and finishes normally afterwards", async () => {
    let phase: "overrun" | "operator" | "done" = "overrun";
    const running = (level: string) => ({
      phase: "running", status: "running", error: null, snapshot: { snapshotId: "snap-1" },
      steps: [{ index: 1, name: "sources", status: "success" }, { index: 2, name: "upgrade", status: "running", uninterruptible: true }], checks: [],
      attention: { level, step: 2, name: "upgrade", since: "2026-10-11T14:00:00Z", message: `step 2 (upgrade) ${level}` },
    });
    const flow = await setup({ plan: planWith(hostRun), doorkeeper: "VERDICT: pass", hostState: () => (phase === "done" ? null : running(phase)) });
    const jobId = await flow.submitted();
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(check()).toBe(true);
    };
    await until(() => (flow.inspect.getJob(jobId)?.output?.hostRunAttention as { level?: string } | undefined)?.level === "overrun");
    let inbox = (await flow.app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: flow.cookie } })).json();
    expect(inbox.attention).toEqual([expect.objectContaining({ jobId, level: "overrun", step: 2, name: "upgrade" })]);
    phase = "operator";
    await until(() => (flow.inspect.getJob(jobId)?.output?.hostRunAttention as { level?: string } | undefined)?.level === "operator");
    inbox = (await flow.app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: flow.cookie } })).json();
    expect(inbox.attention[0]).toMatchObject({ jobId, level: "operator" });
    expect(flow.inspect.getJob(jobId)!.status).toBe("running");
    phase = "done";
    const job = await flow.settled(jobId);
    expect(job.status).toBe("completed");
    const attention = flow.inspect.listAuditsSince("hermes.host_run.attention", "2000-01-01T00:00:00.000Z").filter((audit) => audit.targetId === jobId);
    expect(attention.map((audit) => audit.details.level).sort()).toEqual(["operator", "overrun"]);
    inbox = (await flow.app.inject({ method: "GET", url: "/api/inbox", headers: { cookie: flow.cookie } })).json();
    expect(inbox.attention).toEqual([]);
  });

  it("refuses to hand state steps to the runner role, which its broker can end", async () => {
    const flow = await setup({ plan: "## Plan\n```bash\napt-get update && apt-get -y upgrade\n```\n## Intent\nKeep the host's packages current.", doorkeeper: "VERDICT: pass" });
    const blocked = await flow.submit();
    // Ein Shell-Plan wartet auf Jochen; erst nach seiner Freigabe käme der Runner.
    expect(blocked.status).toBe("blocked_user_approval");
    const approved = await flow.app.inject({ method: "POST", url: `/api/hermes/jobs/${blocked.id}/approval`, headers: { cookie: flow.cookie }, payload: { decision: "approved", reason: "test" } });
    expect(approved.statusCode).toBeLessThan(300);
    const job = await flow.settled(blocked.id);
    expect(flow.agentCalls.some((call) => call.role === "runner")).toBe(false);
    expect(job.status).not.toBe("completed");
    expect(JSON.stringify(job.output)).toContain("state steps (package)");
  });

  it("finds state steps anywhere in the plan the runner would get, not only in the first script block", async () => {
    // Der erste Block ist harmlos (grün, ohne Klick); apt steht erst im zweiten.
    const flow = await setup({ plan: "## Plan\n```bash\nuptime\n```\nDanach:\n```shell\napt-get -y upgrade\n```\n## Intent\nKeep the host's packages current.", doorkeeper: "VERDICT: pass" });
    const submitted = await flow.submit();
    const job = await flow.settled(submitted.id);
    expect(flow.agentCalls.some((call) => call.role === "runner")).toBe(false);
    expect(job.status).not.toBe("completed");
    expect(JSON.stringify(job.output)).toContain("state steps (package)");
  });
});

// Vorfall 10./13.10.2026 (Jobs 611ad26d, 83434c34): the planner copied the
// operator's long manifest into a line that was not valid JSON, and the run
// died before the doorkeeper. A manifest in the trusted intent is now the one
// that is reviewed, signed and run; the planner's copy is only compared.
describe("host door: the operator's manifest comes from the intent", () => {
  const recorded = readFileSync(new URL("./fixtures/host-run-kernel-20261013.json", import.meta.url), "utf8");
  const realIntent = readFileSync(new URL("./fixtures/host-run-kernel-20261013-intent.txt", import.meta.url), "utf8");
  // The real manifest had 17 checks (limit 16); fitted by joining the last two.
  const raw = JSON.parse(recorded) as { checks: Array<{ name: string; run: string; timeoutSeconds: number }> };
  const [last2, last1] = raw.checks.slice(-2);
  const fitted = { ...raw, checks: [...raw.checks.slice(0, -2), { name: `${last2.name}; ${last1.name}`, run: `${last2.run}\n${last1.run}`, timeoutSeconds: last2.timeoutSeconds }] };
  const copied = "```host-run\n" + JSON.stringify(fitted) + "\n```";
  const kernelIntent = realIntent.slice(0, realIntent.indexOf("```host-run")) + copied;
  // What the planner made of it: one escape lost, as on 13.10.
  const brokenCopy = copied.replace('\\"$(dpkg --audit)\\"', '"$(dpkg --audit)"');
  const evidence = (job: { output?: Record<string, unknown> | null }) => ((job.output?.policy as { evidence: string[] }).evidence).join("\n");

  it("runs the real kernel manifest from the intent although the planner's copy is not valid JSON", async () => {
    const flow = await setup({ intent: kernelIntent, plan: brokenCopy, doorkeeper: "VERDICT: pass\nNOTES: planned kernel window" });
    const job = await flow.submit();

    expect(job.status).toBe("completed");
    const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
    expect(start.payload.manifest).toEqual(JSON.parse(JSON.stringify(job.output?.hostRun)));
    expect(job.output?.hostRun).toMatchObject({ name: fitted.name, mutates: true });
    expect(start.payload.envelope).toMatchObject({ gatePassed: true, capabilities: ["host.run"] });
    expect(flow.doorkeeperPrompts[0]).toContain("docker ps --format '{{.Names}}'");
    expect(evidence(job)).toContain("host-run manifest taken from the trusted intent; planner copy: invalid (host-run manifest is not valid JSON)");
    expect(flow.agentCalls.map((call) => call.role)).toEqual(["planner", "verifier"]);
  });

  it("dry run through the planner path: an exact copy is recorded as identical", async () => {
    const flow = await setup({ intent: kernelIntent, plan: copied, doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(job.status).toBe("completed");
    expect(evidence(job)).toContain("planner copy: identical");
  });

  it("keeps the intent's manifest when the planner rewrites a step or leaves it out", async () => {
    for (const [plan, note] of [[copied.replace("{{.Names}}", "{{.ID}}"), "differs"], ["## Plan\nRun the manifest from the intent.", "absent"]]) {
      const flow = await setup({ intent: kernelIntent, plan, doorkeeper: "VERDICT: pass" });
      const job = await flow.submit();
      expect(job.status).toBe("completed");
      expect(evidence(job)).toContain(`planner copy: ${note}`);
      const start = flow.executorCalls.find((call) => call.payload.action === "host.run")!;
      expect(start.payload.manifest.steps[0].run).toContain("{{.Names}}");
    }
  });

  it("stops the real 17-check intent of 13.10. before the planner runs", async () => {
    const flow = await setup({ intent: realIntent, plan: realIntent.slice(realIntent.indexOf("```host-run")), doorkeeper: "VERDICT: pass" });
    const job = await flow.submit(200);
    expect(job.status).toBe("failed_execution");
    expect(JSON.stringify(job.output)).toContain("host-run manifest allows at most 16 checks");
    expect(flow.agentCalls).toHaveLength(0);
    expect(flow.executorCalls).toHaveLength(0);
  });

  it("stops on a broken manifest in the intent before the planner runs", async () => {
    const flow = await setup({ intent: kernelIntent.replace('"mutates":true,', '"mutates":true'), plan: copied, doorkeeper: "VERDICT: pass" });
    const job = await flow.submit(200);
    expect(job.status).toBe("failed_execution");
    expect(JSON.stringify(job.output)).toContain("the intent's host-run manifest is invalid");
    expect(flow.agentCalls).toHaveLength(0);
    expect(flow.executorCalls).toHaveLength(0);
  });

  it("still allows one door per job when the planner adds a capability manifest", async () => {
    const capability = {
      version: "cockpit-capability/v1", name: "read", purpose: "read a file", steps: [{ argv: ["/usr/bin/true"], cwd: "/tmp", runAsUser: "nobody" }],
      readablePaths: [], writablePaths: [], network: "none", expectedEffects: ["none"], verification: ["exit 0"], rollback: ["none needed"], risk: ["contained"],
    };
    const flow = await setup({ intent: kernelIntent, plan: planWith(capability), doorkeeper: "VERDICT: pass" });
    const job = await flow.submit();
    expect(job.status).toBe("failed_execution");
    expect(JSON.stringify(job.output)).toContain("one door per job");
    expect(flow.executorCalls).toHaveLength(0);
  });
});

import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";
import { parseHostRunManifest } from "../src/host-run.js";

// A reboot step takes the API down with the host. The run goes on in its own
// unit; after the restart the API must pick the job up from its record, follow
// the run through host.status and finish the job (verification included).
// Both brokers are fakes on Unix sockets that speak the real wire format.

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

describe("host run across an API restart", () => {
  // hostRunRequestedAt alone: the API died between the helper's answer and
  // recording the start; the run may be going, so it is followed too.
  it.each(["hostRunStartedAt", "hostRunRequestedAt"])("follows the run after the restart and finishes the job with verification (%s)", async (marker) => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-run-resume-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const hostRun = parseHostRunManifest("```host-run\n" + JSON.stringify({
      version: "cockpit-host-run/v1", name: "kernel update", purpose: "install the new kernel and reboot",
      steps: [{ name: "upgrade", run: "apt-get -y install linux-image-generic" }, { name: "reboot", reboot: true }],
      checks: [{ name: "new kernel", run: "uname -r | grep -q 6.8" }], rollback: ["boot the previous kernel from GRUB"],
    }) + "\n```")!;

    // The job as the API left it when the host went down for the reboot.
    const seed = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    seed.initialize();
    seed.seedAdmin("admin", "test-password");
    const admin = seed.authenticateUser("admin", "test-password")!;
    const session = seed.upsertSession({ name: "hermes-rb-x", ownerId: admin.id, tmuxSessionName: "cockpit-hermes-rb-x", tmuxBackend: "tmux", terminalUrl: null });
    const job = seed.createJob({
      sessionId: session.id, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false,
      output: {
        explanation: { phase: "executing", intent: "Update the kernel with a reboot", reason: "running" },
        plan: "## Intent\nkernel", hostRun, policy: { rollbackAvailable: true }, [marker]: new Date().toISOString(),
      },
    });
    // A running job without a started host run is not the watcher's business.
    const other = seed.createJob({ sessionId: session.id, kind: "runbook", subjectId: "hermes-change", status: "running", requiresApproval: false, output: { plan: "x" } });
    seed.close();

    let polls = 0;
    const executorCalls = await listen(path.join(dir, "executor.sock"), (request) => {
      const expected = createHmac("sha256", BROKER_SECRET).update(JSON.stringify(request.payload)).digest("hex");
      if (request.signature !== expected) return { ok: false, error: "invalid request signature" };
      polls += 1;
      // First the host is still coming up (the executor answers, the run is
      // still rebooting), then an unreachable executor, then the result.
      if (polls === 1) return { ok: true, output: JSON.stringify({ ok: true, state: { phase: "rebooting", status: "running" }, logTail: "" }) };
      if (polls === 2) return { ok: false, error: "sudo: unable to resolve host" };
      return { ok: true, output: JSON.stringify({ ok: true, logTail: "linux-image-6.8 installed\nhost back up", state: {
        phase: "finished", status: "success", error: null, snapshot: { snapshotId: "snap-7" },
        steps: [{ index: 1, name: "upgrade", status: "success" }, { index: 2, name: "reboot", status: "rebooting" }],
        checks: [{ index: 1, name: "new kernel", status: "passed" }],
      } }) };
    });
    const agentCalls = await listen(path.join(dir, "agent.sock"), () => ({ ok: true, output: "VERIFICATION_STATUS: passed\nEVIDENCE: uname shows 6.8\nREASON: the new kernel runs" }));

    const app = await createApp({
      config: config(dir, { executorBrokerSocket: path.join(dir, "executor.sock"), executorBrokerSecret: BROKER_SECRET, agentBrokerSocket: path.join(dir, "agent.sock") }),
      hostRunPollMs: 10,
    });
    cleanup.push(() => app.close());

    const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    cleanup.push(() => inspect.close());
    const deadline = Date.now() + 10_000;
    while (inspect.getJob(job.id)?.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    const finished = inspect.getJob(job.id)!;
    expect(finished.status).toBe("completed");
    expect(finished.output?.resumedAfterRestart).toBe(true);
    expect(String(finished.output?.result)).toContain("STATUS: success");
    expect(String(finished.output?.result)).toContain("machine snapshot snap-7");
    expect(String(finished.output?.verification)).toContain("VERIFICATION_STATUS: passed");
    expect(executorCalls.every((call) => call.payload.action === "host.status" && call.payload.target === job.id)).toBe(true);
    expect(agentCalls.map((call) => call.role)).toEqual(["verifier"]);
    expect(inspect.getJob(other.id)?.status).toBe("running");
  });
});

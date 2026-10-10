import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";
import type { SafetyReviewRunner } from "../src/safety-review.js";

// The runner may read the Claude setup token (claude-oauth-token or
// /proc/<pid>/environ). Its handoff goes through filterSensitiveContent into
// the verifier prompt (another model family) and the stored job result; the
// token (sk-ant-oat01-…) has to be redacted on both paths, while the password
// and debug-line filters stay active.

const CLAUDE_TOKEN = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcdefghijklmnopqrstuvwxyzAA";
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

const plan = [
  "## Intent", "Show the host uptime.",
  "## Risk Zone", "green",
  "## Steps", "```bash", "uptime", "```",
  "## Rollback", "Not needed; read-only.",
].join("\n");

const runnerOutput = [
  "timestamp=2026-10-10T10:00:00Z level=INFO msg=\"runner started\"",
  "## EXECUTION RESULT",
  "STATUS: success",
  "EXIT_CODE: 0",
  "WHAT_RAN: uptime",
  `OUTPUT: up 3 days; CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`,
  "NOTES: password=hunter2-secret",
  "  opencode timestamp=2026-10-10T10:00:01Z level=DEBUG msg=noise",
].join("\n");

const safetyReviewRunner: SafetyReviewRunner = async ({ runbookVersionHash }) => ({
  actorId: "safety-agent",
  verdict: "passed",
  summary: "Read-only uptime query.",
  details: {
    schemaVersion: "runbook-safety-review/v1", source: "copilot-cli", parserVersion: "line-schema/v1", parseStatus: "ok",
    runbookId: "proposal", runbookVersionHash, hazards: ["none"], blastRadius: "single host",
    expectedImpact: "none", rollbackHint: "none", operatorChecks: ["none"],
    inputHash: "input-hash", outputHash: "output-hash", exitCode: 0, model: "test",
  },
});

describe("runner handoff redaction", () => {
  it("keeps the Claude setup token out of the verifier prompt and the job result", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runner-redaction-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const seed = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    seed.initialize();
    seed.seedAdmin("admin", "test-password");
    const admin = seed.authenticateUser("admin", "test-password")!;
    const session = seed.upsertSession({ name: "redaction", ownerId: admin.id, tmuxSessionName: "cockpit-redaction", tmuxBackend: "tmux", terminalUrl: null });
    seed.close();

    const agentCalls = await listen(path.join(dir, "agent.sock"), (request) => request.role === "planner"
      ? { ok: true, output: plan }
      : request.role === "runner"
        ? { ok: true, output: runnerOutput }
        : { ok: true, output: "VERIFICATION_STATUS: passed\nEVIDENCE: uptime shown\nREASON: done" });
    const app = await createApp({
      config: config(dir, { agentBrokerSocket: path.join(dir, "agent.sock") }),
      safetyReviewRunner,
    });
    cleanup.push(() => app.close());
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    cleanup.push(() => inspect.close());

    const created = await app.inject({ method: "POST", url: "/api/hermes/runbook", headers: { cookie }, payload: { intent: "Show the host uptime", sessionId: session.id, timeoutMs: 0 } });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().jobId as string;
    const deadline = Date.now() + 10_000;
    while (inspect.getJob(jobId)?.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const job = inspect.getJob(jobId)!;

    expect(agentCalls.map((call) => call.role)).toEqual(["planner", "runner", "verifier"]);
    expect(job.status).toBe("completed");
    const verifierRequest = JSON.stringify(agentCalls[2]);
    expect(verifierRequest).toContain("[REDACTED:API_KEY]");
    expect(verifierRequest).not.toContain("sk-ant-oat01");
    expect(verifierRequest).not.toContain("hunter2-secret");
    const result = String(job.output?.result);
    expect(result).toContain("STATUS: success");
    expect(result).toContain("CLAUDE_CODE_OAUTH_TOKEN=[REDACTED:API_KEY]");
    expect(result).toContain("password=[REDACTED]");
    expect(result).not.toContain("level=DEBUG");
    expect(JSON.stringify(job.output)).not.toContain("sk-ant-oat01");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TmuxAdapter } from "@wireguard-ops-cockpit/tmux-adapter";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// 14.11.2026 (card t_f7cc608e): a research answer without a "## " heading went
// through the runner's line filter, which dropped every short line that did not
// start with a capital or a digit -- "cockpit-agent" after `id -un` vanished on
// Lab0 (job 6b538fe0) and the VPS (c72f80a9). A research answer is the model's
// text word for word; only opencode's log noise and the secret filter apply.

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function config(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
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

function fakeTmux(): TmuxAdapter {
  const live: string[] = [];
  return {
    backend: "tmux",
    ensureSession: (name) => { if (!live.includes(name)) live.push(name); return { name, backend: "tmux" }; },
    listSessions: () => [...live],
    launchCommand: (sessionName) => {
      if (!live.includes(sessionName)) live.push(sessionName);
      return { started: true, backend: "tmux", note: "started" };
    },
  };
}

async function research(answer: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "research-answer-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  db.initialize();
  db.seedAdmin("admin", "test-password");
  db.close();
  const socket = path.join(dir, "agent.sock");
  const server = net.createServer((connection) => {
    let input = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) connection.end(JSON.stringify({ ok: true, output: answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const app = await createApp({ config: config(dir, { agentBrokerSocket: socket }), tmuxAdapter: fakeTmux() });
  cleanup.push(() => app.close());
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
  const response = await app.inject({
    method: "POST", url: "/api/hermes/research", headers: { cookie: login.headers["set-cookie"] as string },
    payload: { intent: "Which user runs the research shell?", timeoutMs: 5_000 },
  });
  const body = response.json();
  const job = body.job ?? body;
  expect(job.status).toBe("completed");
  return job.output.answer as string;
}

describe("research answer", () => {
  it("keeps short lower-case lines of an answer without a heading word for word", async () => {
    const lines = [
      "Block 1:",
      "```",
      "6.8.0-147-generic",
      "```",
      "Block 2 (id -un):",
      "```",
      "cockpit-agent",
      "```",
      "user=[cockpit-agent] rc=0",
      "rc=0",
      "apparmor\t4.1.0~beta5-0ubuntu14",
      'VERSION_ID="25.04"',
      "nproc: 8",
    ];
    const answer = await research(lines.join("\n"));
    expect(answer).toBe(lines.join("\n"));
  });

  it("drops only opencode's log noise and secrets", async () => {
    const answer = await research([
      "> build · deepseek-v4-pro",
      "\x1b[0mtimestamp=2026-11-14T04:00:00Z level=INFO service=session",
      "cockpit-agent",
      "rc=0",
      "token: password=hunter22",
    ].join("\n"));
    expect(answer).toBe(["cockpit-agent", "rc=0", "token: password=[REDACTED]"].join("\n"));
  });
});

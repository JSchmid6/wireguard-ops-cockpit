import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TmuxAdapter } from "@wireguard-ops-cockpit/tmux-adapter";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { CockpitDatabase } from "../src/db.js";

// 17.10.2026 (rollout t_d465b58e): the tmux server runs in the API's cgroup
// (KillMode=control-group), so restarting the API ended every tmux session --
// on purpose, the restarted API starts the interrupted work again from the
// record. But the session records kept saying "active" for ever (also after a
// finished job had killed its own tmux session), and /api/pipeline/health
// counted them. Now the status follows tmux: set at start-up from what tmux
// shows, "ended" when a job stops its session, "active" again on a launch.

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

// A tmux runtime holding exactly the sessions named in `live`.
function fakeTmux(live: string[]): TmuxAdapter {
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

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "session-status-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
  db.initialize();
  db.seedAdmin("admin", "test-password");
  const admin = db.authenticateUser("admin", "test-password")!;
  return { dir, db, admin };
}

describe("session status across an API restart", () => {
  it("sets every tmux-backed session to what tmux shows at start-up, and health counts only live ones", async () => {
    const { dir, db, admin } = tempDb();
    const live = db.upsertSession({ name: "ops", ownerId: admin.id, tmuxSessionName: "cockpit-ops", tmuxBackend: "tmux", terminalUrl: null });
    const gone = db.upsertSession({ name: "hermes-rb-gone", ownerId: admin.id, tmuxSessionName: "cockpit-hermes-rb-gone", tmuxBackend: "tmux", terminalUrl: null });
    const disabled = db.upsertSession({ name: "plain", ownerId: admin.id, tmuxSessionName: "cockpit-plain", tmuxBackend: "disabled", terminalUrl: null });
    db.close();

    const app = await createApp({ config: config(dir), tmuxAdapter: fakeTmux(["cockpit-ops", "other-tmux-session"]) });
    cleanup.push(() => app.close());
    const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    cleanup.push(() => inspect.close());

    expect(inspect.getSessionById(live.id)?.status).toBe("active");
    expect(inspect.getSessionById(gone.id)?.status).toBe("ended");
    // Without tmux there is nothing to compare with; the record is left alone.
    expect(inspect.getSessionById(disabled.id)?.status).toBe("active");
    const audit = inspect.listAudits().find((entry) => entry.action === "session.ended");
    expect(audit?.details).toEqual(expect.objectContaining({ count: 1, sessionIds: [gone.id] }));

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
    const health = await app.inject({ method: "GET", url: "/api/pipeline/health", headers: { cookie: login.headers["set-cookie"] as string } });
    expect(health.json().activeSessions).toBe(2);
  });

  it("writes no audit when every session is still there", async () => {
    const { dir, db, admin } = tempDb();
    db.upsertSession({ name: "ops", ownerId: admin.id, tmuxSessionName: "cockpit-ops", tmuxBackend: "tmux", terminalUrl: null });
    db.close();

    const app = await createApp({ config: config(dir), tmuxAdapter: fakeTmux(["cockpit-ops"]) });
    cleanup.push(() => app.close());
    const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    cleanup.push(() => inspect.close());
    expect(inspect.listAudits().some((entry) => entry.action === "session.ended")).toBe(false);
  });

  it("revives an ended session when it is ensured again or tmux shows it again", () => {
    const { db, admin } = tempDb();
    cleanup.push(() => db.close());
    const session = db.upsertSession({ name: "ops", ownerId: admin.id, tmuxSessionName: "cockpit-ops", tmuxBackend: "tmux", terminalUrl: null });

    expect(db.syncTmuxSessionStatus([])).toEqual([session.id]);
    expect(db.getSessionById(session.id)?.status).toBe("ended");
    expect(db.syncTmuxSessionStatus([])).toEqual([]);

    db.upsertSession({ name: "ops", ownerId: admin.id, tmuxSessionName: "cockpit-ops", tmuxBackend: "tmux", terminalUrl: null });
    expect(db.getSessionById(session.id)?.status).toBe("active");

    db.setSessionStatus(session.id, "ended");
    expect(db.syncTmuxSessionStatus(["cockpit-ops"])).toEqual([]);
    expect(db.getSessionById(session.id)?.status).toBe("active");
  });

  it("ends the session a research job created once the job is done", async () => {
    const { dir, db } = tempDb();
    db.close();
    const socket = path.join(dir, "agent.sock");
    const server = net.createServer((connection) => {
      let input = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        input += chunk;
        if (input.includes("\n")) connection.end(JSON.stringify({ ok: true, output: "The hermes container runs image 0240fa4a and is healthy." }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const live: string[] = [];
    const app = await createApp({ config: config(dir, { agentBrokerSocket: socket }), tmuxAdapter: fakeTmux(live) });
    cleanup.push(() => app.close());
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "test-password" } });
    const response = await app.inject({
      method: "POST", url: "/api/hermes/research", headers: { cookie: login.headers["set-cookie"] as string },
      payload: { intent: "Which image does James run?", timeoutMs: 5_000 },
    });
    const body = response.json();
    expect(body.job?.status ?? body.status).toBe("completed");

    const inspect = new CockpitDatabase(path.join(dir, "cockpit.sqlite"));
    cleanup.push(() => inspect.close());
    const sessions = inspect.listSessions().filter((entry) => entry.name.startsWith("hermes-"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("ended");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { __tmuxTestHarness, createTmuxAdapter } from "../dist/index.js";

test("disabled adapter validates session names and never launches tmux work", () => {
  const adapter = createTmuxAdapter("disabled");

  assert.equal(adapter.backend, "disabled");
  assert.deepEqual(adapter.ensureSession("incident-debug"), {
    name: "incident-debug",
    backend: "disabled"
  });
  assert.deepEqual(adapter.listSessions(), []);
  assert.throws(() => adapter.ensureSession("bad name"), /session name must match/);
  assert.deepEqual(
    adapter.launchCommand("incident-debug", "agent-demo", {
      executable: "node",
      args: ["demo.js"]
    }),
    {
      started: false,
      backend: "disabled",
      note: "tmux integration is disabled in this runtime"
    }
  );
});

test("auto mode falls back to disabled when tmux is unavailable", (t) => {
  t.mock.method(__tmuxTestHarness, "spawnSync", () => ({ status: 1, stdout: "", stderr: "missing" }));

  const adapter = createTmuxAdapter();

  assert.equal(adapter.backend, "disabled");
  assert.deepEqual(adapter.listSessions(), []);
});

test("tmux adapter creates sessions, lists them and launches commands", (t) => {
  const calls = [];

  t.mock.method(__tmuxTestHarness, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });

    switch (args[0]) {
      case "-V":
        return { status: 0, stdout: "tmux 3.4", stderr: "" };
      case "has-session":
        return { status: 1, stdout: "", stderr: "missing session" };
      case "new-session":
        return { status: 0, stdout: "", stderr: "" };
      case "list-sessions":
        return { status: 0, stdout: "alpha\nbeta\n", stderr: "" };
      case "new-window":
        return { status: 0, stdout: "", stderr: "" };
      default:
        throw new Error(`Unexpected tmux args: ${args.join(" ")}`);
    }
  });

  const adapter = createTmuxAdapter();

  assert.equal(adapter.backend, "tmux");
  assert.deepEqual(adapter.ensureSession("incident-debug"), {
    name: "incident-debug",
    backend: "tmux"
  });
  assert.deepEqual(adapter.listSessions(), ["alpha", "beta"]);
  assert.deepEqual(
    adapter.launchCommand("incident-debug", "agent-demo", {
      executable: "node",
      args: ["demo.js", "--watch"],
      cwd: "/workspace/repo"
    }),
    {
      started: true,
      backend: "tmux",
      note: "started node in tmux window agent-demo"
    }
  );

  assert.deepEqual(calls.at(-1), {
    command: "tmux",
    args: [
      "new-window",
      "-d",
      "-t",
      "incident-debug",
      "-n",
      "agent-demo",
      "-c",
      "/workspace/repo",
      "node",
      "demo.js",
      "--watch"
    ],
    options: { encoding: "utf8" }
  });
});

test("tmux adapter surfaces tmux errors and invalid launch inputs", (t) => {
  t.mock.method(__tmuxTestHarness, "spawnSync", (command, args) => {
    switch (args[0]) {
      case "-V":
        return { status: 0, stdout: "tmux 3.4", stderr: "" };
      case "has-session":
        return { status: 0, stdout: "", stderr: "" };
      case "list-sessions":
        return { status: 1, stdout: "", stderr: "failed to list" };
      case "new-window":
        return { status: 1, stdout: "", stderr: "window failed" };
      default:
        throw new Error(`Unexpected tmux args: ${args.join(" ")}`);
    }
  });

  const adapter = createTmuxAdapter();

  assert.deepEqual(adapter.listSessions(), []);
  assert.throws(() => adapter.launchCommand("incident-debug", "bad name", { executable: "node", args: [] }), /window name must match/);
  assert.throws(
    () =>
      adapter.launchCommand("incident-debug", "agent-demo", {
        executable: "node\u0000",
        args: []
      }),
    /invalid characters/
  );
  assert.throws(
    () =>
      adapter.launchCommand("incident-debug", "agent-demo", {
        executable: "node",
        args: ["demo.js"]
      }),
    /window failed/
  );
});
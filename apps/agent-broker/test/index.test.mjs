import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.NODE_ENV = "test";
// A stand-in for opencode: reports its arguments, then echoes stdin.
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-fake-"));
const fakeOpencode = path.join(fakeRoot, "opencode");
// A session whose requestId starts with dead0000 exits without reading stdin;
// one with 5a7e0000 reports its opencode state environment and writes a catalog
// into its cache the way opencode does.
fs.writeFileSync(fakeOpencode, "#!/bin/sh\ncase \"$PWD\" in */agent-dead0000*) exit 3;; */agent-5a7e0000*) env | grep -E '^(XDG_[A-Z]+_HOME|TMPDIR|OPENCODE_DISABLE_MODELS_FETCH)=' | sort; mkdir -p \"$XDG_CACHE_HOME/opencode\"; echo '{}' > \"$XDG_CACHE_HOME/opencode/models.json\"; exit 0;; esac\nprintf 'argc=%s last=%s\\n' \"$#\" \"$(eval echo \\\"\\$$#\\\")\"\ncat\n", { mode: 0o755 });
process.env.COCKPIT_OPENCODE_EXECUTABLE = fakeOpencode;
process.env.COCKPIT_AGENT_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-run-"));
// The broker also checks opencode's global config directory: never the one of whoever runs the tests.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-xdg-"));
const { assertNoPlantedConfig, cleanupStaleWorkspaces, createSessionWorkspace, parseServedRoles, removeSessionWorkspace, runAgent, sessionStateDirs, validateRequest } = await import("../src/index.mjs");
const { PROMPT_LIMITS, promptLimit, promptLimitProblem } = await import("../src/prompt-limits.mjs");
test.after(() => {
  fs.rmSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT, { recursive: true, force: true });
  fs.rmSync(fakeRoot, { recursive: true, force: true });
  fs.rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
});
test("agent broker accepts only bounded roles and prompts", () => {
  assert.deepEqual(validateRequest({ requestId: "12345678", role: "planner", prompt: "inspect" }), { requestId: "12345678", role: "planner", prompt: "inspect" });
  assert.deepEqual(validateRequest({ requestId: "12345678", role: "research", prompt: "inspect" }), { requestId: "12345678", role: "research", prompt: "inspect" });
  assert.throws(() => validateRequest({ requestId: "12345678", role: "root", prompt: "inspect" }), /invalid agent role/);
});

// Two instances under two identities: the agent unit serves the plan roles, the
// runner unit only the runner (t_cb81637b). Unset serves every role.
test("a broker instance serves only the roles it is configured for", () => {
  assert.deepEqual([...parseServedRoles(undefined)].sort(), ["planner", "research", "runner", "safety", "verifier"]);
  assert.deepEqual([...parseServedRoles(" ")].sort(), ["planner", "research", "runner", "safety", "verifier"]);
  const plan = parseServedRoles("planner,research,safety,verifier");
  const runner = parseServedRoles("runner");
  for (const role of ["planner", "research", "safety", "verifier"]) {
    assert.equal(validateRequest({ requestId: "12345678", role, prompt: "x" }, plan).role, role);
    assert.throws(() => validateRequest({ requestId: "12345678", role, prompt: "x" }, runner), new RegExp(`^Error: this broker does not serve the ${role} role$`));
  }
  assert.equal(validateRequest({ requestId: "12345678", role: "runner", prompt: "x" }, runner).role, "runner");
  assert.throws(() => validateRequest({ requestId: "12345678", role: "runner", prompt: "x" }, plan), /^Error: this broker does not serve the runner role$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "root", prompt: "x" }, plan), /invalid agent role/);
  assert.throws(() => parseServedRoles("runner,root"), /unknown role: root/);
  assert.throws(() => parseServedRoles("constructor"), /unknown role: constructor/);
  assert.throws(() => parseServedRoles(","), /names no role/);
});

test("only the safety and verifier roles get the larger budget", () => {
  const review = "d".repeat(90000);
  assert.equal(validateRequest({ requestId: "12345678", role: "safety", prompt: review }).prompt.length, 90000);
  assert.equal(validateRequest({ requestId: "12345678", role: "verifier", prompt: review }).prompt.length, 90000);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: "d".repeat(100001) }), /^Error: prompt length 100001 exceeds verifier limit 100000$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "planner", prompt: review }), /^Error: prompt length 90000 exceeds planner limit 30000$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "runner", prompt: review }), /^Error: prompt length 90000 exceeds runner limit 30000$/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: "" }), /prompt is empty/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "verifier", prompt: 7 }), /prompt is empty or not a string/);
  assert.throws(() => validateRequest({ requestId: "12345678", role: "safety", prompt: "d".repeat(100001) }), /exceeds safety limit 100000/);
  // The prompt goes on stdin: no argv byte bound any more, multi-byte text
  // counts by characters like any other.
  assert.equal(validateRequest({ requestId: "12345678", role: "safety", prompt: "\u20ac".repeat(100000) }).prompt.length, 100000);
});

test("the bounds have one definition: every role, one number, one wording", () => {
  assert.deepEqual(Object.keys(PROMPT_LIMITS).sort(), ["planner", "research", "runner", "safety", "verifier"]);
  assert.equal(Object.isFrozen(PROMPT_LIMITS), true);
  for (const [role, limit] of Object.entries(PROMPT_LIMITS)) {
    assert.equal(promptLimit(role), limit);
    assert.equal(promptLimitProblem(role, "x".repeat(limit)), null);
    assert.equal(promptLimitProblem(role, "x".repeat(limit + 1)), `prompt length ${limit + 1} exceeds ${role} limit ${limit}`);
    assert.doesNotThrow(() => validateRequest({ requestId: "12345678", role, prompt: "x".repeat(limit) }));
  }
  assert.throws(() => promptLimit("root"), /invalid agent role/);
  assert.throws(() => promptLimit("constructor"), /invalid agent role/);
});

test("agent broker creates a private role-scoped workspace and removes only that workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-test-"));
  const workspace = createSessionWorkspace({ requestId: "12345678", role: "planner", prompt: "inspect" }, root);
  const instructions = fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8");
  assert.match(instructions, /disposable session workspace/);
  assert.match(instructions, /Planner role/);
  assert.match(instructions, /configured HaRP/);
  assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
  removeSessionWorkspace(workspace, root);
  assert.equal(fs.existsSync(workspace), false);
  assert.throws(() => removeSessionWorkspace(root, root), /refusing/);
  fs.rmSync(root, { recursive: true });
});

test("startup cleanup removes stale bounded workspaces but preserves unrelated directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-stale-"));
  const stale = path.join(root, "agent-stale-planner-test");
  const unrelated = path.join(root, "operator-data");
  fs.mkdirSync(stale); fs.mkdirSync(unrelated);
  fs.utimesSync(stale, new Date(0), new Date(0));
  cleanupStaleWorkspaces(root, Date.now());
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(unrelated), true);
  fs.rmSync(root, { recursive: true });
});

// opencode's state belongs to the run (t_cb81637b): session database, auth.json,
// models catalog, downloaded tools and temp files live in the workspace and go
// with it; no catalog fetch per run.
test("opencode state lives in the run's workspace and goes with it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-state-"));
  const workspace = createSessionWorkspace({ requestId: "12345678", role: "safety", prompt: "x" }, root);
  const dirs = sessionStateDirs(workspace);
  assert.deepEqual(Object.keys(dirs).sort(), ["TMPDIR", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);
  for (const dir of Object.values(dirs)) {
    assert.ok(dir.startsWith(`${workspace}${path.sep}`), dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  // Not a name opencode loads as project config: a left-over one never stops a start.
  const level = fs.mkdtempSync(path.join(root, "level-"));
  fs.mkdirSync(path.join(level, ".run-state"));
  assert.doesNotThrow(() => assertNoPlantedConfig(level, fs.mkdtempSync(path.join(root, "cfg-"))));
  fs.rmSync(root, { recursive: true });
  const result = await runAgent({ requestId: "5a7e0000-1", role: "safety", prompt: "x" });
  assert.equal(result.ok, true, result.error);
  const env = Object.fromEntries(result.output.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, "1");
  for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
    assert.ok(env[key].startsWith(`${process.env.COCKPIT_AGENT_WORKSPACE_ROOT}/agent-5a7e0000-1-safety-`), key);
    assert.ok(env[key].includes("/.run-state/"), key);
  }
  // The config directory stays the identity's (read-only in the unit): not passed on.
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  // The catalog the run wrote is gone with its workspace.
  assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
});

test("agent process exit removes its complete session workspace", async () => {
  const result = await runAgent({ requestId: "87654321", role: "verifier", prompt: "verify" });
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
});

// Linux caps one argv element at 128 KiB (MAX_ARG_STRLEN); 100,000 three-byte
// characters are 300,000 bytes. On stdin the prompt arrives whole and unchanged
// (quotes and backslashes too), and argv ends with the options.
test("the prompt reaches opencode on stdin, whole, beyond the old argv bound", async () => {
  const prompt = `say "hi" \\ ${"\u20ac".repeat(100000 - 11)}`;
  assert.equal(prompt.length, 100000);
  const result = await runAgent({ requestId: "87654322", role: "verifier", prompt });
  assert.equal(result.ok, true, result.error);
  const [head, ...rest] = result.output.split("\n");
  assert.match(head, /^argc=\d+ last=--print-logs$/);
  assert.equal(rest.join("\n"), prompt);
});

// A child that exits without reading its input: the write fails with EPIPE,
// and the broker reports the exit instead of crashing.
test("a child that ignores stdin does not crash the broker", async () => {
  const result = await runAgent({ requestId: "dead0000-1", role: "verifier", prompt: "\u20ac".repeat(100000) });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
});

// opencode searches project config, instructions and skills from the workspace up
// to "/" and loads agents, commands, skills and tools from its global config
// directory (t_62992d58).
test("planted opencode config above the workspace or in the global config directory stops every role", async () => {
  const names = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".claude", ".agents", ".git", ".gitconfig"];
  for (const level of ["session root", "home"]) {
    for (const name of names) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-planted-"));
      const root = path.join(home, "sessions");
      fs.mkdirSync(root);
      const planted = path.join(level === "home" ? home : root, name);
      if (name.startsWith(".") && name !== ".gitconfig") fs.mkdirSync(planted); else fs.writeFileSync(planted, "{}");
      assert.throws(() => createSessionWorkspace({ requestId: "12345678", role: "safety", prompt: "review" }, root), (error) => error.message.includes(planted), `${level}: ${name}`);
      assert.deepEqual(fs.readdirSync(root), level === "home" ? [] : [name]);
      fs.rmSync(home, { recursive: true });
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-clean-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-config-"));
  // What the deploy places there, and what opencode itself writes, stays allowed.
  for (const name of ["opencode.jsonc", ".gitignore", "package.json", "node_modules"]) fs.writeFileSync(path.join(configDir, name), "");
  assert.doesNotThrow(() => assertNoPlantedConfig(root, configDir));
  for (const name of ["opencode.json", "config.json", "AGENTS.md", "agent", "agents", "command", "commands", "mode", "modes", "plugin", "plugins", "tool", "tools", "skill", "skills"]) {
    fs.mkdirSync(path.join(configDir, name));
    assert.throws(() => assertNoPlantedConfig(root, configDir), (error) => error.message.includes(path.join(configDir, name)), name);
    fs.rmSync(path.join(configDir, name), { recursive: true });
  }
  fs.symlinkSync("/nonexistent", path.join(root, "AGENTS.md"));
  assert.throws(() => assertNoPlantedConfig(root, configDir), /AGENTS\.md/);
  fs.rmSync(root, { recursive: true }); fs.rmSync(configDir, { recursive: true });
  const tool = path.join(process.env.XDG_CONFIG_HOME, "opencode", "tools");
  fs.mkdirSync(tool, { recursive: true });
  const result = await runAgent({ requestId: "87654323", role: "verifier", prompt: "verify" });
  fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /agent workspace setup failed: opencode would load .*opencode\/tools/);
  assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
});

// The units are the boundary (t_62992d58, t_cb81637b): the plan roles run as
// cockpit-agent in the agent unit, the runner (build tools) as cockpit-runner in
// its own unit. Whatever an identity can write, its next role loads: the config,
// agent definitions and AGENTS.md below the home, .opencode or opencode.json in
// the home itself. And whatever the runner can reach of the agent unit (home,
// workspaces, socket), safety and verifier would load or trust.
const repo = new URL("../../../", import.meta.url);
function unitFile(name) {
  const unit = fs.readFileSync(new URL(`deploy/systemd/${name}`, repo), "utf8");
  const values = (key) => unit.split("\n").filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  const env = Object.fromEntries(values("Environment").map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  const writable = [
    ...values("ReadWritePaths").flatMap((line) => line.split(/\s+/)),
    ...values("StateDirectory").flatMap((line) => line.split(/\s+/)).map((dir) => `/var/lib/${dir}`),
  ].map((entry) => entry.replace(/^-/, ""));
  const inaccessible = values("InaccessiblePaths").flatMap((line) => line.split(/\s+/)).map((entry) => entry.replace(/^-/, ""));
  return { unit, values, env, writable, inaccessible };
}
const covers = (dir, target) => target === dir || target.startsWith(`${dir}/`);

for (const [name, home, socketDir, roles] of [
  ["wireguard-ops-cockpit-agent.service", "/var/lib/wireguard-ops-agent", "/run/cockpit-agent", "planner,research,safety,verifier"],
  ["wireguard-ops-cockpit-runner.service", "/var/lib/wireguard-ops-runner", "/run/cockpit-runner", "runner"],
]) {
  test(`${name} keeps the home and the opencode config read-only and serves only its roles`, () => {
    const { values, env, writable } = unitFile(name);
    assert.equal(env.HOME, home);
    assert.equal(env.COCKPIT_AGENT_BROKER_ROLES, roles);
    assert.deepEqual([...parseServedRoles(env.COCKPIT_AGENT_BROKER_ROLES)].join(","), roles);
    assert.equal(env.COCKPIT_AGENT_BROKER_SOCKET, `${socketDir}/${path.basename(socketDir).replace("cockpit-", "")}.sock`);
    assert.equal(env.COCKPIT_AGENT_WORKSPACE_ROOT, `${home}/sessions`);
    assert.equal(env.COCKPIT_OPENCODE_CONFIG, `${home}/.config/opencode/opencode.jsonc`);
    assert.deepEqual([values("ProtectSystem"), values("ProtectHome"), values("ProtectProc"), values("NoNewPrivileges"), values("PrivateTmp")], [["strict"], ["true"], ["invisible"], ["true"], ["true"]]);
    assert.deepEqual(values("RuntimeDirectory"), [path.basename(socketDir)]);
    // Other ways to make a path writable that the check below would not see.
    for (const key of ["ReadWriteDirectories", "BindPaths", "LogsDirectory", "CacheDirectory", "ConfigurationDirectory", "SupplementaryGroups"]) assert.deepEqual(values(key), [], key);
    for (const target of [home, env.COCKPIT_OPENCODE_CONFIG, `${home}/.config/opencode/agent/plan.md`, `${home}/.config/opencode/AGENTS.md`, `${home}/.opencode`, `${home}/opencode.json`, `${home}/.claude/CLAUDE.md`,
      // opencode's shared state of earlier releases: now per run in the workspace.
      `${home}/.local/share/opencode/auth.json`, `${home}/.cache/opencode/models.json`, `${home}/.cache/opencode/bin/rg`]) {
      assert.deepEqual(writable.filter((dir) => covers(dir, target)), [], `${target} must not be writable for ${name}`);
    }
    // What must stay writable, or no role starts: the workspaces (with opencode's state) and the socket.
    assert.deepEqual(writable.sort(), [env.COCKPIT_AGENT_WORKSPACE_ROOT, socketDir].sort());
  });
}

test("the runner unit and the agent unit share no identity, home, workspace or socket", () => {
  const agent = unitFile("wireguard-ops-cockpit-agent.service");
  const runner = unitFile("wireguard-ops-cockpit-runner.service");
  assert.deepEqual([agent.values("User"), agent.values("Group")], [["cockpit-agent"], ["cockpit-agent-client"]]);
  assert.deepEqual([runner.values("User"), runner.values("Group")], [["cockpit-runner"], ["cockpit-runner-client"]]);
  // Neither can write anything of the other, and the other's home and socket are not even mounted.
  for (const [self, other] of [[agent, runner], [runner, agent]]) {
    for (const target of [other.env.HOME, other.env.COCKPIT_AGENT_WORKSPACE_ROOT, path.dirname(other.env.COCKPIT_AGENT_BROKER_SOCKET)]) {
      assert.deepEqual(self.writable.filter((dir) => covers(dir, target) || covers(target, dir)), [], target);
      assert.ok(self.inaccessible.some((dir) => covers(dir, target)), `${target} must be inaccessible`);
    }
  }
  // The API reaches both sockets, and routes the runner to its own.
  const dropIn = fs.readFileSync(new URL("deploy/systemd/wireguard-ops-cockpit-api-brokers.conf", repo), "utf8");
  assert.match(dropIn, /^Requires=.*\bwireguard-ops-cockpit-runner\.service\b/m);
  assert.match(dropIn, /^After=.*\bwireguard-ops-cockpit-runner\.service\b/m);
  assert.match(dropIn, /^SupplementaryGroups=.*\bcockpit-runner-client\b/m);
  assert.match(dropIn, new RegExp(`^Environment=COCKPIT_RUNNER_BROKER_SOCKET=${runner.env.COCKPIT_AGENT_BROKER_SOCKET}$`, "m"));
});

test("the deploys create the runner identity and install its unit and root-owned config", () => {
  const lab0 = fs.readFileSync(new URL("deploy/lab0/homeserver-cockpit-deploy.sh", repo), "utf8");
  assert.match(lab0, /install -m 640 -o root -g cockpit-agent-client \\\n\s+"\$COCKPIT_DIR\/deploy\/config\/opencode-agent\.jsonc" "\$AGENT_DIR\/\.config\/opencode\/opencode\.jsonc"/);
  assert.match(lab0, /"\$COCKPIT_DIR\/deploy\/config\/opencode-config-dir\.gitignore" "\$AGENT_DIR\/\.config\/opencode\/\.gitignore"/);
  assert.match(lab0, /install -m 640 -o root -g cockpit-runner-client \\\n\s+"\$COCKPIT_DIR\/deploy\/config\/opencode-agent\.jsonc" "\$RUNNER_DIR\/\.config\/opencode\/opencode\.jsonc"/);
  assert.match(lab0, /"\$COCKPIT_DIR\/deploy\/config\/opencode-config-dir\.gitignore" "\$RUNNER_DIR\/\.config\/opencode\/\.gitignore"/);
  assert.doesNotMatch(lab0, /-o cockpit-(agent|runner)[^\n]*\.config/);
  assert.match(lab0, /^RUNNER_DIR="\/var\/lib\/wireguard-ops-runner"$/m);
  assert.match(lab0, /^id -u cockpit-runner >\/dev\/null 2>&1 \|\| useradd --system -m -d "\$RUNNER_DIR" -s \/usr\/sbin\/nologin -g cockpit-runner-client cockpit-runner$/m);
  // The runner joins no other group (never cockpit-agent-client or the executor's).
  assert.doesNotMatch(lab0, /usermod[^\n]*cockpit-runner\b(?!-client)/);
  assert.doesNotMatch(lab0, /-G[^\n]*cockpit-runner\b(?!-client)/);
  assert.match(lab0, /install -m 644 "\$COCKPIT_DIR\/deploy\/systemd\/wireguard-ops-cockpit-runner\.service"/);
  assert.match(lab0, /\[ -S \/run\/cockpit-runner\/runner\.sock \]/);
  assert.match(lab0, /^APT_PACKAGES=\(.*\bripgrep\b.*\)$/m);
  const vps = fs.readFileSync(new URL("deploy/vps/vps-cockpit-deploy.sh", repo), "utf8");
  assert.match(vps, /"deploy\/config\/opencode-config-dir\.gitignore\|\$ROOT\/var\/lib\/wireguard-ops-agent\/\.config\/opencode\/\.gitignore\|644"/);
  assert.match(vps, /"deploy\/systemd\/wireguard-ops-cockpit-runner\.service\|\$UNITS\/wireguard-ops-cockpit-runner\.service\|644"/);
  assert.match(vps, /"deploy\/config\/opencode-agent\.jsonc\|\$ROOT\/var\/lib\/wireguard-ops-runner\/\.config\/opencode\/opencode\.jsonc\|644"/);
  assert.match(vps, /^readonly SERVICES=\(.*\bwireguard-ops-cockpit-runner\b.*\)$/m);
  assert.match(vps, /useradd --system --no-create-home -d \/var\/lib\/wireguard-ops-runner -s \/usr\/sbin\/nologin -g cockpit-runner-client cockpit-runner/);
  // The self-update runner restarts and checks it like the other brokers.
  const run = fs.readFileSync(new URL("deploy/helpers/cockpit-self-update-run", repo), "utf8");
  assert.match(run, /^SERVICES = env\("COCKPIT_SELF_UPDATE_SERVICES", "[^"]*\bwireguard-ops-cockpit-runner\b[^"]*"\)/m);
  assert.match(run, /^SOCKETS = env\("COCKPIT_SELF_UPDATE_SOCKETS", "[^"]*\/run\/cockpit-runner\/runner\.sock[^"]*"\)/m);
  // No sudo for either identity.
  for (const file of fs.readdirSync(new URL("deploy/sudoers/", repo))) {
    assert.doesNotMatch(fs.readFileSync(new URL(`deploy/sudoers/${file}`, repo), "utf8"), /cockpit-(agent|runner)/, file);
  }
  // The exact bytes opencode 1.18 writes (config.ts ensureGitignore).
  assert.equal(fs.readFileSync(new URL("deploy/config/opencode-config-dir.gitignore", repo), "utf8"), ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"));
});

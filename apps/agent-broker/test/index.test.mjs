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
// one with 5a7e0000 reports its opencode state environment (npm's cache too) and writes a catalog
// into its cache the way opencode does.
fs.writeFileSync(fakeOpencode, "#!/bin/sh\ncase \"$PWD\" in */agent-dead0000*|*-dead0000-*) exit 3;; */agent-5a7e0000*) env | grep -E '^(XDG_[A-Z]+_HOME|TMPDIR|OPENCODE_DISABLE_MODELS_FETCH|npm_config_cache)=' | sort; mkdir -p \"$XDG_CACHE_HOME/opencode\"; echo '{}' > \"$XDG_CACHE_HOME/opencode/models.json\"; exit 0;; esac\nprintf 'argc=%s last=%s\\n' \"$#\" \"$(eval echo \\\"\\$$#\\\")\"\ncat\n", { mode: 0o755 });
process.env.COCKPIT_OPENCODE_EXECUTABLE = fakeOpencode;
process.env.COCKPIT_AGENT_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-run-"));
// The broker also checks opencode's global config directory below HOME: never the one of whoever runs the tests.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-home-"));
// The check derives it from HOME alone, like opencode, which gets no XDG_CONFIG_HOME.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-xdg-"));
const { assertNoPlantedConfig, claudeSocketPathLength, claudeTmpRoot, cleanReason, cleanupStaleWorkspaces, createClaudeTmpdir, parseClaudeResult, createSessionWorkspace, globalConfigNames, parseServedRoles, projectConfigNames, removeSessionWorkspace, runAgent, sessionStateDirs, validateRequest } = await import("../src/index.mjs");
const { PROMPT_LIMITS, promptLimit, promptLimitProblem } = await import("../src/prompt-limits.mjs");
test.after(() => {
  fs.rmSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT, { recursive: true, force: true });
  fs.rmSync(fakeRoot, { recursive: true, force: true });
  fs.rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
  fs.rmSync(process.env.HOME, { recursive: true, force: true });
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
  // npm's cache belongs to the run as well (card t_2a2d8e5b): the home is read-only.
  assert.equal(env.npm_config_cache, path.join(env.XDG_CACHE_HOME, "npm"));
  // The config directory stays the identity's (read-only in the unit): not passed on.
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  // The catalog the run wrote is gone with its workspace.
  assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
  // The runner (build) gets the same per-run state and npm cache in its own workspace.
  const runner = await runAgent({ requestId: "5a7e0000-2", role: "runner", prompt: "x" });
  assert.equal(runner.ok, true, runner.error);
  const runnerEnv = Object.fromEntries(runner.output.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  assert.ok(runnerEnv.XDG_CACHE_HOME.startsWith(`${process.env.COCKPIT_AGENT_WORKSPACE_ROOT}/agent-5a7e0000-2-runner-`));
  assert.equal(runnerEnv.npm_config_cache, path.join(runnerEnv.XDG_CACHE_HOME, "npm"));
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
  const names = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".claude", ".agents", ".git", ".gitconfig", ".npmrc"];
  assert.deepEqual(projectConfigNames, names);
  for (const level of ["session root", "home"]) {
    for (const name of names) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-planted-"));
      const root = path.join(home, "sessions");
      fs.mkdirSync(root);
      const planted = path.join(level === "home" ? home : root, name);
      if (name.startsWith(".") && name !== ".gitconfig" && name !== ".npmrc") fs.mkdirSync(planted); else fs.writeFileSync(planted, "{}");
      assert.throws(() => createSessionWorkspace({ requestId: "12345678", role: "safety", prompt: "review" }, root), (error) => error.message.includes(planted), `${level}: ${name}`);
      assert.deepEqual(fs.readdirSync(root), level === "home" ? [] : [name]);
      fs.rmSync(home, { recursive: true });
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-clean-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agent-config-"));
  const configDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  // What the deploy places there, and what opencode itself writes, stays allowed.
  for (const name of ["opencode.jsonc", ".gitignore", "package.json", "node_modules"]) fs.writeFileSync(path.join(configDir, name), "");
  assert.doesNotThrow(() => assertNoPlantedConfig(root, home));
  const globalNames = ["opencode.json", "config.json", "config", "AGENTS.md", "agent", "agents", "command", "commands", "mode", "modes", "plugin", "plugins", "tool", "tools", "skill", "skills"];
  assert.deepEqual(globalConfigNames, globalNames);
  for (const name of globalNames) {
    fs.mkdirSync(path.join(configDir, name));
    assert.throws(() => assertNoPlantedConfig(root, home), (error) => error.message.includes(path.join(configDir, name)), name);
    fs.rmSync(path.join(configDir, name), { recursive: true });
  }
  // git (opencode's snapshots) reads ~/.config/git/config, e.g. core.fsmonitor: code.
  fs.mkdirSync(path.join(home, ".config", "git"));
  assert.throws(() => assertNoPlantedConfig(root, home), (error) => error.message.includes(path.join(home, ".config", "git")));
  fs.rmSync(path.join(home, ".config", "git"), { recursive: true });
  fs.symlinkSync("/nonexistent", path.join(root, "AGENTS.md"));
  assert.throws(() => assertNoPlantedConfig(root, home), /AGENTS\.md/);
  fs.rmSync(root, { recursive: true }); fs.rmSync(home, { recursive: true });
  // The default is HOME's config directory; XDG_CONFIG_HOME in the broker's own
  // environment neither hides it nor counts, because opencode never gets it.
  fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, "opencode", "tools"), { recursive: true });
  assert.doesNotThrow(() => assertNoPlantedConfig(fs.mkdtempSync(path.join(process.env.HOME, "clean-"))));
  fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  const tool = path.join(process.env.HOME, ".config", "opencode", "tools");
  fs.mkdirSync(tool, { recursive: true });
  const result = await runAgent({ requestId: "87654323", role: "verifier", prompt: "verify" });
  fs.rmSync(path.join(process.env.HOME, ".config"), { recursive: true });
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
      // npm's cache of PR #101 too: it moved into the run's cache (card t_2a2d8e5b).
      `${home}/.local/share/opencode/auth.json`, `${home}/.cache/opencode/models.json`, `${home}/.cache/opencode/bin/rg`, `${home}/.cache/opencode/npm`]) {
      assert.deepEqual(writable.filter((dir) => covers(dir, target)), [], `${target} must not be writable for ${name}`);
    }
    // What must stay writable, or no role starts: the workspaces (with opencode's state) and the socket.
    assert.deepEqual(writable.sort(), [env.COCKPIT_AGENT_WORKSPACE_ROOT, socketDir].sort());
    // The Cockpit's own secrets are out of every role's reach, the runner's too (card t_abe2651b).
    assert.ok(values("InaccessiblePaths").includes("-/etc/wireguard-ops-cockpit"), name);
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
  assert.match(vps, /"deploy\/config\/opencode-agent\.jsonc\|\$ROOT\/var\/lib\/wireguard-ops-agent\/\.config\/opencode\/opencode\.jsonc\|644"/);
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

// Leftovers stop every role, planner and doorkeeper too, so the Cockpit could no
// longer repair or roll itself back: both deploys refuse them before they install
// a stand, with the broker's names (t_b4ec0027).
test("the deploys refuse the same leftover config as the broker before they install", async () => {
  const { spawnSync } = await import("node:child_process");
  const repo = new URL("../../../", import.meta.url);
  const block = (file) => {
    const text = fs.readFileSync(new URL(file, repo), "utf8");
    const start = text.indexOf("# >>> planted-config-preflight");
    const end = text.indexOf("# <<< planted-config-preflight");
    assert.ok(start >= 0 && end > start, file);
    return text.slice(start, end);
  };
  const vps = block("deploy/vps/vps-cockpit-deploy.sh");
  assert.equal(block("deploy/lab0/homeserver-cockpit-deploy.sh"), vps);
  const list = (name) => vps.match(new RegExp(`${name}=\\(([^)]*)\\)`))[1].trim().split(/\s+/);
  assert.deepEqual(list("PLANTED_PROJECT_NAMES"), projectConfigNames);
  assert.deepEqual(list("PLANTED_GLOBAL_NAMES"), globalConfigNames);
  const vpsScript = fs.readFileSync(new URL("deploy/vps/vps-cockpit-deploy.sh", repo), "utf8");
  // VPS: before the ERR trap and the checkout, so a refusal needs no rollback (N1 of t_dc170a06).
  assert.match(vpsScript, /\ncheck_planted_config \|\| \{ code=\$\?; rm -rf -- "\$BACKUP"; exit "\$code"; \}\ntrap rollback ERR\n(?:.*\n){0,2}git checkout -q -B main "\$REPO_COMMIT"\ninstall_runtime\nbuild\nsave_targets\n/);
  // Both broker homes: the plan roles' and the runner's (card t_2a2d8e5b).
  assert.match(vpsScript, /for home in \/var\/lib\/wireguard-ops-agent \/var\/lib\/wireguard-ops-runner; do\n\s+part="\$\(planted_config_preflight "\$ROOT" "\$home"\)"/);
  const lab0Script = fs.readFileSync(new URL("deploy/lab0/homeserver-cockpit-deploy.sh", repo), "utf8");
  assert.match(lab0Script, /for planted_home in "\$AGENT_DIR" "\$RUNNER_DIR"; do\n\s+planted_part="\$\(planted_config_preflight "" "\$planted_home"\)"/);
  assert.ok(lab0Script.indexOf("planted_config_preflight \"\" \"$planted_home\"") < lab0Script.indexOf('log "1) Pakete installieren"'));
  // The block itself, against a host root: clean, then each kind of leftover.
  const run = (root, home = "/var/lib/wireguard-ops-agent") => spawnSync("bash", ["-c", `set -euo pipefail\n${vps}\nplanted_config_preflight "$1" "$2"`, "check", root, home], { encoding: "utf8" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-deploy-root-"));
  const home = path.join(root, "var/lib/wireguard-ops-agent");
  fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  for (const name of ["opencode.jsonc", ".gitignore", "package.json"]) fs.writeFileSync(path.join(home, ".config/opencode", name), "");
  assert.equal(run(root).status, 0, run(root).stdout);
  for (const planted of ["AGENTS.md", "var/.claude", "var/lib/wireguard-ops-agent/.npmrc", "var/lib/wireguard-ops-agent/sessions/.opencode", "var/lib/wireguard-ops-agent/.config/opencode/config", "var/lib/wireguard-ops-agent/.config/git"]) {
    fs.mkdirSync(path.dirname(path.join(root, planted)), { recursive: true });
    fs.symlinkSync("/nonexistent", path.join(root, planted));
    const result = run(root);
    assert.equal(result.status, 1, planted);
    assert.equal(result.stdout, `opencode would load /${planted} into every role\n`, planted);
    fs.rmSync(path.join(root, planted));
  }
  // The runner's home, the same way (card t_2a2d8e5b).
  const runnerHome = "/var/lib/wireguard-ops-runner";
  assert.equal(run(root, runnerHome).status, 0);
  for (const planted of ["var/lib/wireguard-ops-runner/.npmrc", "var/lib/wireguard-ops-runner/sessions/AGENTS.md", "var/lib/wireguard-ops-runner/.config/opencode/tools", "var/lib/wireguard-ops-runner/.config/git"]) {
    fs.mkdirSync(path.dirname(path.join(root, planted)), { recursive: true });
    fs.symlinkSync("/nonexistent", path.join(root, planted));
    const result = run(root, runnerHome);
    assert.equal(result.status, 1, planted);
    assert.equal(result.stdout, `opencode would load /${planted} into every role\n`, planted);
    fs.rmSync(path.join(root, planted));
  }
  fs.rmSync(root, { recursive: true });
});

// Planner and research on Claude through the subscription, DeepSeek (opencode)
// only as NOTBETRIEB (card t_936d9b0f). A stand-in for `claude -p`: a session
// whose requestId starts with c1a0de00 answers like Claude's JSON result and
// reports what it got; one with c1a0fa11 is logged out.
test("planner and research run on Claude; a Claude failure falls back to opencode labelled NOTBETRIEB", async () => {
  const fakeClaude = path.join(fakeRoot, "claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh
case "$PWD" in
  */agent-c1a0fa11*) echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1;;
  */agent-c1a0b1a7*) echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}'; touch "$PWD/../opencode.json"; exit 1;;
  */agent-c1a0bad0*) echo "error: unknown option '--safe-mode'" >&2; exit 2;;
esac
prompt=$(cat)
test -d "$HOME" || exit 4
test -d "$TMPDIR" || exit 5
info="args=$* home=$HOME config=$CLAUDE_CONFIG_DIR tmp=$TMPDIR scrub=$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB token=\${CLAUDE_CODE_OAUTH_TOKEN:+set} deepseek=\${DEEPSEEK_API_KEY:+set} prompt=$prompt"
node -e 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:process.argv[1],modelUsage:{"claude-sonnet-5-5":{}}}))' "$info"
`, { mode: 0o755 });
  const saved = { ...process.env };
  Object.assign(process.env, { COCKPIT_PLAN_ENGINE: "claude", COCKPIT_CLAUDE_EXECUTABLE: fakeClaude, CLAUDE_CODE_OAUTH_TOKEN: "test-token", DEEPSEEK_API_KEY: "test-key" });
  try {
    for (const role of ["planner", "research"]) {
      const result = await runAgent({ requestId: "c1a0de00-1", role, prompt: "plan it" });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.engine, { name: "claude", model: "claude-sonnet-5-5" });
      assert.match(result.output, /^args=-p --safe-mode --strict-mcp-config --no-session-persistence --model sonnet --tools Bash,Read,Grep,Glob,WebFetch,WebSearch --allowedTools Bash,Read,Grep,Glob,WebFetch,WebSearch --append-system-prompt-file \S+\/AGENTS\.md --output-format json /);
      // Claude's state belongs to the run; the token reaches it, the DeepSeek key does not.
      const state = `${process.env.COCKPIT_AGENT_WORKSPACE_ROOT}/agent-c1a0de00-1-${role}-[^/]+/\\.run-state`;
      assert.match(result.output, new RegExp(` home=${state}/home config=${state}/claude tmp=/tmp/cockpit-claude-[^/ ]+ `));
      // The short TMPDIR goes with the run.
      const tmpdir = result.output.match(/ tmp=(\S+) /)[1];
      assert.equal(fs.existsSync(tmpdir), false);
      assert.match(result.output, / scrub=1 token=set deepseek= prompt=plan it$/);
      assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
    }
    // Logged out (expired token, subscription window, outage): opencode answers, labelled.
    const fallback = await runAgent({ requestId: "c1a0fa11-1", role: "planner", prompt: "plan it" });
    assert.equal(fallback.ok, true, fallback.error);
    assert.deepEqual(fallback.engine, { name: "opencode", model: "default", notbetrieb: true, reason: "Not logged in · Please run /login" });
    assert.match(fallback.output, /^argc=\d+ last=--print-logs\nplan it$/);
    // No JSON result: the reason comes from stderr.
    const badFlag = await runAgent({ requestId: "c1a0bad0-1", role: "research", prompt: "look" });
    assert.equal(badFlag.engine.notbetrieb, true);
    assert.equal(badFlag.engine.reason, "error: unknown option '--safe-mode'");
    // Claude and the stand-in both fail: the result still carries NOTBETRIEB.
    const both = await runAgent({ requestId: "c1a0fa11-dead0000", role: "planner", prompt: "plan it" });
    assert.equal(both.ok, false);
    assert.equal(both.engine.notbetrieb, true);
    // What the Claude run's shell planted never reaches the stand-in: it starts
    // in a fresh workspace, checked again (and refused here).
    const planted = await runAgent({ requestId: "c1a0b1a7-1", role: "planner", prompt: "plan it" });
    assert.equal(planted.ok, false);
    assert.match(planted.error, /opencode would load .*opencode\.json/);
    assert.equal(planted.engine.notbetrieb, true);
    fs.rmSync(path.join(process.env.COCKPIT_AGENT_WORKSPACE_ROOT, "opencode.json"));
    assert.deepEqual(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT), []);
    // Safety and verifier never go to Claude, and are no NOTBETRIEB.
    for (const role of ["safety", "verifier"]) {
      const review = await runAgent({ requestId: "c1a0de00-2", role, prompt: "review" });
      assert.equal(review.ok, true, review.error);
      assert.deepEqual(review.engine, { name: "opencode", model: "default" });
    }
    // Without the switch the planner stays on opencode.
    delete process.env.COCKPIT_PLAN_ENGINE;
    const plain = await runAgent({ requestId: "c1a0de00-3", role: "planner", prompt: "plan it" });
    assert.deepEqual(plain.engine, { name: "opencode", model: "default" });
  } finally {
    for (const key of ["COCKPIT_PLAN_ENGINE", "COCKPIT_CLAUDE_EXECUTABLE", "CLAUDE_CODE_OAUTH_TOKEN", "DEEPSEEK_API_KEY"]) {
      if (key in saved) process.env[key] = saved[key]; else delete process.env[key];
    }
  }
});

test("Claude's result is parsed for the answer and the model that answered; reasons carry no token", () => {
  assert.deepEqual(parseClaudeResult('{"subtype":"success","is_error":false,"result":"ok","modelUsage":{"claude-sonnet-5-5":{}}}'), { ok: true, output: "ok", model: "claude-sonnet-5-5" });
  assert.deepEqual(parseClaudeResult('{"subtype":"error_max_turns","is_error":true,"result":""}'), { ok: false, json: true, reason: "claude ended with error_max_turns" });
  assert.equal(parseClaudeResult("").ok, false);
  assert.equal(parseClaudeResult('{"subtype":"success","is_error":false,"result":"  "}').ok, false);
  assert.equal(cleanReason(`bad token sk-ant-oat01-${"a".repeat(40)}\n next`), "bad token […] next");
});

test("Claude's sandbox sockets fit sun_path: TMPDIR + /claude-socks-<16 hex>.sock stays within 107 characters", () => {
  // The socket path for a given TMPDIR, measured on the longer of the two names.
  assert.equal(claudeSocketPathLength("/tmp/x"), "/tmp/x/claude-socks-0123456789abcdef.sock".length);
  // The cause (card t_8b92ed2f): below the production workspace it does not fit.
  const workspaceTmp = `/var/lib/wireguard-ops-agent/sessions/agent-${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}-research-XXXXXX/.run-state/tmp`;
  assert.ok(claudeSocketPathLength(workspaceTmp) > 107);
  // The run's own directory does, with room to spare, and is private.
  assert.equal(claudeTmpRoot, "/tmp");
  const tmpdir = createClaudeTmpdir();
  try {
    assert.match(tmpdir, /^\/tmp\/cockpit-claude-[A-Za-z0-9]{6}$/);
    assert.ok(claudeSocketPathLength(tmpdir) <= 107 - 32, `${claudeSocketPathLength(tmpdir)} characters`);
    assert.equal(fs.statSync(tmpdir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
  // A root too deep is refused before Claude starts (the run falls back, labelled).
  const deep = fs.mkdtempSync(path.join(os.tmpdir(), "x".repeat(60)));
  try {
    assert.throws(() => createClaudeTmpdir(deep), /would exceed 107 characters/);
    assert.deepEqual(fs.readdirSync(deep), []);
  } finally {
    fs.rmSync(deep, { recursive: true, force: true });
  }
});

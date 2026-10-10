import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
process.env.NODE_ENV = "test";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-claude-engine-"));
process.env.COCKPIT_AGENT_WORKSPACE_ROOT = path.join(scratch, "sessions");
const { runAgent } = await import("../src/index.mjs");
const { claudeArgs, codexArgs, opencodeArgs, readEngineConfig, ROLE_TOOLS, ROLES } = await import("../src/engines.mjs");
const { isOwnEngineProcess, killGroup, reapOrphanedRuns, RUN_MARKER_ENV } = await import("../src/supervisor.mjs");
const fake = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fileURLToPath(url) { return decodeURIComponent(url.pathname); }

let counter = 0;
function setup(mode, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, "case-"));
  const configDir = path.join(dir, "claude-config");
  fs.mkdirSync(configDir, { mode: 0o700 });
  if (mode) fs.writeFileSync(path.join(configDir, "fake-mode"), mode);
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "test-token-value\n", { mode: 0o600 });
  const config = readEngineConfig({
    PATH: process.env.PATH, HOME: dir,
    COCKPIT_AGENT_RUNS_ROOT: path.join(dir, "runs"),
    COCKPIT_CLAUDE_EXECUTABLE: fake,
    COCKPIT_CLAUDE_CONFIG_DIR: configDir,
    COCKPIT_CLAUDE_TOKEN_FILE: tokenFile,
    ...overrides,
  });
  counter += 1;
  const requestId = `abcdef${String(counter).padStart(4, "0")}`;
  return { dir, configDir, tokenFile, config, requestId, runDir: (role) => path.join(dir, "runs", `${requestId}-${role}`) };
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); } return check(); };
const verdictOf = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, "lauf.json"), "utf8"));
const after = (args, flag) => args[args.indexOf(flag) + 1];
function variadic(args, flag) {
  const out = [];
  for (let i = args.indexOf(flag) + 1; i < args.length && !args[i].startsWith("--"); i += 1) out.push(args[i]);
  return out;
}

test("each role gets its hard tool set on the command line, never a bypass", () => {
  const deniedPaths = ["/run/credentials/x", "/var/lib/wireguard-ops-agent/claude-config"];
  for (const role of ROLES) {
    const model = role === "safety" || role === "verifier" ? "opus" : "sonnet";
    const args = claudeArgs(role, { model, context: "ctx", deniedPaths });
    assert.equal(args[0], "-p");
    assert.equal(after(args, "--output-format"), "stream-json");
    assert.ok(args.includes("--verbose"));
    assert.equal(after(args, "--model"), model);
    assert.equal(after(args, "--tools"), ROLE_TOOLS[role].join(","), role);
    assert.equal(after(args, "--setting-sources"), "", "no user/project/local settings");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(!args.includes("--mcp-config"), "no MCP servers at all");
    assert.ok(args.includes("--safe-mode"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.equal(after(args, "--permission-mode"), "dontAsk");
    assert.equal(after(args, "--append-system-prompt"), "ctx");
    for (const forbidden of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--add-dir", "--mcp-config", "--settings"]) {
      assert.ok(!args.includes(forbidden), `${role}: ${forbidden}`);
    }
    const denied = variadic(args, "--disallowedTools");
    for (const never of ["Agent", "Task", "WebFetch", "WebSearch", "NotebookEdit"]) assert.ok(denied.includes(never), `${role} denies ${never}`);
    if (!ROLE_TOOLS[role].includes("Bash")) for (const mutating of ["Bash", "Edit", "Write"]) assert.ok(denied.includes(mutating), `${role} denies ${mutating}`);
    if (ROLE_TOOLS[role].length) {
      assert.ok(denied.includes("Read(//run/credentials/x/**)"), `${role} cannot read the token directory`);
      assert.ok(denied.includes("Grep(//var/lib/wireguard-ops-agent/claude-config/**)"));
      assert.equal(after(args, "--allowedTools"), ROLE_TOOLS[role].join(","));
    } else {
      assert.ok(!args.includes("--allowedTools"));
    }
  }
  assert.deepEqual(ROLE_TOOLS.safety, []);
  assert.deepEqual(ROLE_TOOLS.verifier, []);
  assert.deepEqual(ROLE_TOOLS.planner, ["Read", "Grep", "Glob"]);
  assert.deepEqual(ROLE_TOOLS.research, ["Read", "Grep", "Glob"]);
  assert.deepEqual(ROLE_TOOLS.runner, ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]);
  assert.throws(() => claudeArgs("safety", { model: "claude-opus-5-5", context: "x" }), /alias/);
  assert.throws(() => claudeArgs("root", { model: "opus", context: "x" }), /invalid agent role/);
});

test("models come from configuration as aliases: review roles opus, work roles sonnet", async () => {
  const defaults = readEngineConfig({});
  assert.deepEqual(defaults.engines, { work: "claude", review: "opencode" }, "reviewers are another model family by default");
  assert.equal(defaults.claude.reviewModel, "opus");
  assert.equal(defaults.claude.workModel, "sonnet");
  assert.equal(readEngineConfig({ CREDENTIALS_DIRECTORY: "/run/credentials/u" }).claude.tokenFile, "/run/credentials/u/claude-oauth-token");
  assert.equal(defaults.claude.tokenFile, "/etc/wireguard-ops-agent/claude-oauth-token");
  // /proc stays denied for the file tools: the CLI's own environ holds the token.
  assert.deepEqual(defaults.claude.deniedPaths, ["/etc/wireguard-ops-cockpit", "/proc"]);
  const s = setup("ok", { COCKPIT_CLAUDE_WORK_MODEL: "claude-sonnet-5" });
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config });
  assert.equal(result.ok, false);
  assert.match(result.error, /Alias/);
  assert.equal(verdictOf(s.runDir("planner")).status, "nicht_verfuegbar");
});

test("a supervised Claude run writes events line by line and a verdict, and passes prompt and token only where intended", async () => {
  const s = setup("ok");
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review this diff" }, { config: s.config });
  assert.equal(result.ok, true);
  assert.equal(result.output, "VERDICT: approve\nNOTES: 16 chars");
  assert.deepEqual(result.engine, { antrieb: "claude", modell: "claude-sonnet-test", cliVersion: "9.9.9", etikett: null, lauf: `${s.requestId}-planner` });
  const verdict = verdictOf(s.runDir("planner"));
  assert.equal(verdict.status, "erfolg");
  assert.equal(verdict.cliVersion, "9.9.9");
  assert.equal(verdict.cliVersionNeu, true);
  assert.deepEqual(verdict.werkzeuge, ["Read", "Grep", "Glob"]);
  assert.equal(typeof verdict.dauerMs, "number");
  assert.equal(fs.readFileSync(path.join(s.runDir("planner"), "events.jsonl"), "utf8").trim().split("\n").length, 3);
  assert.equal(fs.existsSync(path.join(s.runDir("planner"), "engine.pid")), false);
  assert.equal(fs.statSync(s.runDir("planner")).mode & 0o777, 0o700);
  const call = JSON.parse(fs.readFileSync(path.join(s.configDir, "last-call.json"), "utf8"));
  assert.equal(call.stdin, "review this diff", "prompt goes through stdin");
  assert.ok(!call.args.includes("review this diff"), "prompt never in argv");
  assert.match(after(call.args, "--append-system-prompt"), /Planner role/);
  assert.equal(call.tokenPresent, true);
  assert.equal(call.runMarker, `${s.requestId}-planner`);
  assert.deepEqual(call.envKeys.filter((key) => !["PWD", "SHLVL", "_"].includes(key)),
    ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "COCKPIT_AGENT_RUN_ID", "DISABLE_AUTOUPDATER", "HOME", "PATH"]);
  for (const file of ["events.jsonl", "lauf.json"]) assert.ok(!fs.readFileSync(path.join(s.runDir("planner"), file), "utf8").includes("test-token-value"), `${file} never holds the token`);
  // A second run on the same version is not a version change.
  const again = await runAgent({ requestId: `${s.requestId}ff`, role: "planner", prompt: "plan" }, { config: s.config });
  assert.equal(again.ok, true);
  assert.equal(verdictOf(path.join(s.dir, "runs", `${s.requestId}ff-planner`)).cliVersionNeu, false);
  assert.equal(fs.readFileSync(path.join(s.dir, "runs", "cli-versionen.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("preflight: missing binary, token, login or version ends as nicht_verfuegbar without starting a run", async () => {
  const cases = [
    ["binary", setup("ok", { COCKPIT_CLAUDE_EXECUTABLE: "/nonexistent/claude" }), /nicht gefunden/],
    ["loggedout", setup("loggedout"), /Anmeldung fehlt/],
    ["version", setup("noversion"), /Version nicht lesbar/],
  ];
  const missing = setup("ok"); fs.rmSync(missing.tokenFile); cases.push(["token", missing, /Token-Datei fehlt/]);
  const open = setup("ok"); fs.chmodSync(open.tokenFile, 0o644); cases.push(["open token", open, /Gruppe\/andere lesbar/]);
  const empty = setup("ok"); fs.writeFileSync(empty.tokenFile, ""); cases.push(["empty token", empty, /leer/]);
  for (const [name, s, reason] of cases) {
    const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config });
    assert.equal(result.ok, false, name);
    assert.match(result.error, /not available/, name);
    assert.match(result.error, /nothing is approved/, name);
    const verdict = verdictOf(s.runDir("planner"));
    assert.equal(verdict.status, "nicht_verfuegbar", name);
    assert.match(verdict.grund, reason, name);
    assert.equal(fs.existsSync(path.join(s.configDir, "last-call.json")), false, `${name}: no model call`);
    const aborts = fs.readFileSync(path.join(s.dir, "runs", "abbrueche.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(aborts.at(-1).status, "nicht_verfuegbar", name);
  }
});

test("an authentication error inside the run is nicht_verfuegbar, never a review", async () => {
  const s = setup("autherr");
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config });
  assert.equal(result.ok, false);
  assert.equal(result.output, undefined);
  assert.equal(result.verdict.status, "nicht_verfuegbar");
  const aborts = fs.readFileSync(path.join(s.dir, "runs", "abbrueche.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(aborts[0].letzteEreignisse.length, 2);
});

test("a run whose loaded tools differ from its role is stopped as fehler", async () => {
  const s = setup("wrongtools");
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "plan" }, { config: s.config, graceMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.verdict.status, "fehler");
  assert.match(result.verdict.grund, /Werkzeugliste weicht von der Rolle ab/);
});

test("a run that never shows its loaded tools is fehler, even with a result", async () => {
  const s = setup("noinit");
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config });
  assert.equal(result.ok, false);
  assert.match(result.verdict.grund, /kein init-Ereignis/);
});

test("a grandchild left behind by a successful run is ended with its group", async () => {
  const s = setup("leftover");
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config, graceMs: 300 });
  assert.equal(result.ok, true);
  const pids = JSON.parse(fs.readFileSync(path.join(s.configDir, "pids.json"), "utf8"));
  assert.ok(await waitFor(() => !isAlive(pids.grandchild)), "no process of the run keeps computing");
});

test("a failed login keeps the CLI version already read in the verdict", async () => {
  const s = setup("loggedout");
  await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config });
  assert.equal(verdictOf(s.runDir("planner")).cliVersion, "9.9.9");
});

test("exit without a result event is fehler", async () => {
  const s = setup("exit2");
  const result = await runAgent({ requestId: s.requestId, role: "runner", prompt: "run" }, { config: s.config });
  assert.equal(result.ok, false);
  assert.equal(result.verdict.status, "fehler");
  assert.match(result.verdict.grund, /kein Ergebnis-Ereignis \(Exit 2\)/);
});


test("the time limit kills the whole process group: SIGTERM, then SIGKILL after the grace period", async () => {
  const s = setup("hang");
  const timeouts = { planner: 1500 };
  const result = await runAgent({ requestId: s.requestId, role: "planner", prompt: "review" }, { config: s.config, timeouts, graceMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.verdict.status, "zeit");
  const pids = JSON.parse(fs.readFileSync(path.join(s.configDir, "pids.json"), "utf8"));
  assert.ok(await waitFor(() => !isAlive(pids.self) && !isAlive(pids.grandchild)), "engine and grandchild are gone");
  const verdict = verdictOf(s.runDir("planner"));
  assert.equal(verdict.signal, "SIGKILL", "the engine ignored SIGTERM, so the escalation had to kill it");
  assert.equal(fs.readdirSync(process.env.COCKPIT_AGENT_WORKSPACE_ROOT).length, 0);
});

test("killGroup escalates only when the group survives SIGTERM", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  assert.equal(await killGroup(child.pid, 2000), "term");
  assert.equal(await killGroup(999999999, 10), "gone");
});

test("orphaned runs are reaped only when the PID is still our own engine process", async () => {
  const runsRoot = fs.mkdtempSync(path.join(scratch, "reap-"));
  const orphanId = "orphan0001-safety";
  const orphan = spawn(fake, ["-p"], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: "/nonexistent", [RUN_MARKER_ENV]: orphanId } });
  const foreign = spawn("sleep", ["30"], { detached: true, stdio: "ignore", env: { [RUN_MARKER_ENV]: "foreign0001-safety" } });
  const reused = spawn(fake, ["-p"], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: "/nonexistent", [RUN_MARKER_ENV]: "somebody-else" } });
  await new Promise((r) => setTimeout(r, 300));
  const plant = (id, pid) => {
    fs.mkdirSync(path.join(runsRoot, id), { mode: 0o700 });
    fs.writeFileSync(path.join(runsRoot, id, "engine.pid"), JSON.stringify({ pid, antrieb: "claude", rolle: "safety", start: new Date(Date.now() - 1000).toISOString() }));
  };
  plant(orphanId, orphan.pid);
  plant("foreign0001-safety", foreign.pid);
  plant("reused00001-safety", reused.pid);
  plant("dead0000001-safety", 999999999);
  assert.equal(isOwnEngineProcess(orphan.pid, orphanId, ["claude", "fake-claude.mjs"]), true);
  assert.equal(isOwnEngineProcess(foreign.pid, "foreign0001-safety", ["claude"]), false, "sleep is not a claude process");
  const reaped = await reapOrphanedRuns(runsRoot, { engineNames: ["claude", "fake-claude.mjs"], graceMs: 300 });
  const byRun = Object.fromEntries(reaped.map((item) => [item.lauf, item.action]));
  assert.equal(byRun[orphanId], "gruppe_beendet");
  assert.equal(byRun["foreign0001-safety"], "pid_fremd_nicht_angefasst");
  assert.equal(byRun["reused00001-safety"], "pid_fremd_nicht_angefasst", "a claude process of another run is not ours");
  assert.equal(byRun["dead0000001-safety"], "nicht_mehr_aktiv");
  assert.ok(await waitFor(() => !isAlive(orphan.pid)));
  assert.equal(isAlive(foreign.pid), true);
  assert.equal(isAlive(reused.pid), true);
  for (const id of Object.keys(byRun)) {
    const verdict = verdictOf(path.join(runsRoot, id));
    assert.equal(verdict.status, "fehler");
    assert.match(verdict.grund, /verwaist/);
    assert.equal(fs.existsSync(path.join(runsRoot, id, "engine.pid")), false);
  }
  foreign.kill("SIGKILL"); reused.kill("SIGKILL");
  // Finished runs older than 14 days are removed, younger ones kept.
  const old = path.join(runsRoot, orphanId, "lauf.json");
  fs.utimesSync(old, new Date(0), new Date(0));
  await reapOrphanedRuns(runsRoot);
  assert.equal(fs.existsSync(path.join(runsRoot, orphanId)), false);
  assert.equal(fs.existsSync(path.join(runsRoot, "foreign0001-safety")), true);
});

test("reviewers are never Claude; no silent fallback: Codex stays off until switched on, unknown engines are refused", async () => {
  // Claude never reviews Claude's work, not even when switched on.
  const self = setup("ok", { COCKPIT_AGENT_ENGINE_REVIEW: "claude" });
  for (const role of ["safety", "verifier"]) {
    const result = await runAgent({ requestId: `${self.requestId}${role === "safety" ? "a" : "b"}`, role, prompt: "review" }, { config: self.config });
    assert.equal(result.ok, false, role);
    assert.equal(result.verdict.status, "nicht_verfuegbar");
    assert.match(result.error, /Claude prüft keine Claude-Arbeit/);
  }
  assert.equal(fs.existsSync(path.join(self.configDir, "last-call.json")), false, "Claude was never started as a reviewer");
  const off = setup("ok", { COCKPIT_AGENT_ENGINE_REVIEW: "codex" });
  const codex = await runAgent({ requestId: off.requestId, role: "safety", prompt: "review" }, { config: off.config });
  assert.equal(codex.ok, false);
  assert.match(codex.error, /Codex ist nicht zugeschaltet/);
  assert.equal(fs.existsSync(path.join(off.configDir, "last-call.json")), false, "no Claude call as a fallback");
  const unknown = setup("ok", { COCKPIT_AGENT_ENGINE_WORK: "deepseek" });
  const refused = await runAgent({ requestId: unknown.requestId, role: "planner", prompt: "plan" }, { config: unknown.config });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /unbekannter Antrieb/);
  // A Claude outage is never answered by another engine.
  const down = setup("ok", { COCKPIT_CLAUDE_EXECUTABLE: "/nonexistent/claude", COCKPIT_CODEX_ENABLED: "1", COCKPIT_OPENCODE_EXECUTABLE: "/bin/true" });
  const outage = await runAgent({ requestId: down.requestId, role: "planner", prompt: "plan" }, { config: down.config });
  assert.equal(outage.ok, false);
  assert.equal(outage.engine.antrieb, "claude");
  assert.equal(outage.verdict.status, "nicht_verfuegbar");
  // Codex adapter (prepared): never danger-full-access, read-only except the runner.
  for (const role of ROLES) {
    const args = codexArgs(role, { workspace: "/w", finalFile: "/w/f" });
    assert.equal(after(args, "--sandbox"), role === "runner" ? "workspace-write" : "read-only");
    assert.ok(!args.some((arg) => /danger|bypass/.test(arg)));
    assert.equal(args.at(-1), "-", "prompt via stdin");
  }
  assert.deepEqual(opencodeArgs("runner", "p", { plannerModel: "m1", safetyModel: "m2" }).args.slice(0, 5), ["run", "--auto", "--pure", "--agent", "build"]);
  assert.equal(opencodeArgs("safety", "p", { plannerModel: "m1", safetyModel: "m2" }).model, "m2");
  assert.equal(opencodeArgs("verifier", "p", { plannerModel: "m1", safetyModel: "m2" }).model, "m2");
});

// Stand-in for opencode: prints its version, or answers per $FAKE_OPENCODE_MODE (HOME/mode).
function fakeOpencode(dir, script) {
  const file = path.join(dir, "opencode");
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\n${script}\n`, { mode: 0o755 });
  return file;
}

test("the DeepSeek reviewer runs supervised: preflight, label, and an empty balance is not available, never an approval", async () => {
  const s = setup(null);
  const base = { COCKPIT_AGENT_RUNS_ROOT: path.join(s.dir, "runs"), COCKPIT_SAFETY_OPENCODE_MODEL: "deepseek/deepseek-v4-pro", DEEPSEEK_API_KEY: "sk-test" };
  const config = (script, extra = {}) => readEngineConfig({ PATH: process.env.PATH, HOME: s.dir, ...base, COCKPIT_OPENCODE_EXECUTABLE: fakeOpencode(s.dir, script), ...extra });
  const ok = await runAgent({ requestId: "deadbe0001", role: "safety", prompt: "review" }, { config: config('echo "VERDICT: approve"') });
  assert.equal(ok.ok, true);
  assert.equal(ok.output.trim(), "VERDICT: approve");
  assert.equal(ok.engine.antrieb, "opencode");
  assert.equal(ok.engine.cliVersion, "1.2.3");
  assert.equal(ok.engine.etikett, "DeepSeek/opencode deepseek/deepseek-v4-pro (Prüfer, andere Modellfamilie als Claude)");
  assert.equal(verdictOf(path.join(s.dir, "runs", "deadbe0001-safety")).status, "erfolg");
  const broke = await runAgent({ requestId: "deadbe0002", role: "verifier", prompt: "verify" }, { config: config('echo "Error: 402 Insufficient Balance" >&2; exit 1') });
  assert.equal(broke.ok, false);
  assert.equal(broke.verdict.status, "nicht_verfuegbar");
  assert.match(broke.engine.etikett, /DeepSeek\/opencode/);
  const silent = await runAgent({ requestId: "deadbe0003", role: "safety", prompt: "review" }, { config: config('echo "Insufficient Balance" >&2; exit 0') });
  assert.equal(silent.ok, false, "exit 0 without an answer is no review");
  assert.equal(silent.verdict.status, "nicht_verfuegbar");
  const empty = await runAgent({ requestId: "deadbe0004", role: "safety", prompt: "review" }, { config: config("exit 0") });
  assert.equal(empty.ok, false);
  assert.equal(empty.verdict.status, "fehler");
  const nokey = await runAgent({ requestId: "deadbe0005", role: "safety", prompt: "review" }, { config: config('echo "VERDICT: approve"', { DEEPSEEK_API_KEY: "" }) });
  assert.equal(nokey.ok, false);
  assert.equal(nokey.verdict.status, "nicht_verfuegbar");
  assert.match(nokey.error, /DEEPSEEK_API_KEY/);
  const missing = await runAgent({ requestId: "deadbe0006", role: "safety", prompt: "review" }, { config: readEngineConfig({ PATH: process.env.PATH, HOME: s.dir, ...base, COCKPIT_OPENCODE_EXECUTABLE: "/nonexistent/opencode" }) });
  assert.equal(missing.verdict.status, "nicht_verfuegbar");
  assert.match(missing.error, /opencode nicht gefunden/);
});

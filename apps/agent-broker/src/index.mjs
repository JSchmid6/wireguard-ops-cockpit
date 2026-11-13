import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PROMPT_LIMITS, promptLimitProblem } from "./prompt-limits.mjs";

const socketPath = process.env.COCKPIT_AGENT_BROKER_SOCKET || "/run/wireguard-ops-cockpit/agent.sock";
const executable = process.env.COCKPIT_OPENCODE_EXECUTABLE || "opencode";
const plannerModel = process.env.COCKPIT_OPENCODE_MODEL || "";
const safetyModel = process.env.COCKPIT_SAFETY_OPENCODE_MODEL || plannerModel;
const workspaceRoot = process.env.COCKPIT_AGENT_WORKSPACE_ROOT || "/var/lib/wireguard-ops-agent/sessions";
const opencodeConfig = process.env.COCKPIT_OPENCODE_CONFIG || "/var/lib/wireguard-ops-agent/.config/opencode/opencode.jsonc";
const contextRoot = new URL("../context/", import.meta.url);
const staleWorkspaceAgeMs = 24 * 60 * 60 * 1000;
const allowedRoles = new Set(Object.keys(PROMPT_LIMITS));
const requestLineLimit = 1048576;

// Which roles this broker instance serves (comma-separated). Production runs two
// instances under two identities: the agent unit serves planner, research,
// safety and verifier, the runner unit only the runner (build), so a runner run
// reaches neither the plan roles' workspaces nor their socket or processes
// (card t_cb81637b). Unset means every role (tests, a single-broker setup).
export function parseServedRoles(value) {
  if (value === undefined || value.trim() === "") return new Set(allowedRoles);
  const roles = value.split(",").map((role) => role.trim()).filter(Boolean);
  for (const role of roles) if (!allowedRoles.has(role)) throw new Error(`COCKPIT_AGENT_BROKER_ROLES names an unknown role: ${role}`);
  if (!roles.length) throw new Error("COCKPIT_AGENT_BROKER_ROLES names no role");
  return new Set(roles);
}
const servedRoles = parseServedRoles(process.env.COCKPIT_AGENT_BROKER_ROLES);

export function validateRequest(value, roles = servedRoles) {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  if (!allowedRoles.has(value.role)) throw new Error("invalid agent role");
  if (!roles.has(value.role)) throw new Error(`this broker does not serve the ${value.role} role`);
  // Bounds and wording in prompt-limits.mjs: the API reads the same file.
  const problem = promptLimitProblem(value.role, value.prompt);
  if (problem) throw new Error(problem);
  if (typeof value.requestId !== "string" || !/^[a-f0-9-]{8,64}$/i.test(value.requestId)) throw new Error("requestId is invalid");
  return { requestId: value.requestId, role: value.role, prompt: value.prompt };
}

export function removeSessionWorkspace(workspace, root = workspaceRoot) {
  const resolvedRoot = path.resolve(root);
  const resolvedWorkspace = path.resolve(workspace);
  if (path.dirname(resolvedWorkspace) !== resolvedRoot || !path.basename(resolvedWorkspace).startsWith("agent-")) {
    throw new Error("refusing to remove workspace outside the agent session root");
  }
  fs.rmSync(resolvedWorkspace, { recursive: true, force: true });
}

export function cleanupStaleWorkspaces(root = workspaceRoot, now = Date.now()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("agent-")) continue;
    const workspace = path.join(root, entry.name);
    const stat = fs.lstatSync(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < staleWorkspaceAgeMs) continue;
    removeSessionWorkspace(workspace, root);
  }
}

// opencode 1.18 looks for project config, instructions and skills from the
// workspace up to "/" (no git repository there; a .git would make it one), and
// loads config, agents, commands, skills and tools (code, also with --pure) from
// its global config directory. Whatever lies there reaches every role, also
// safety and verifier. The unit keeps the home read-only, so the session root is
// the one such level the agent identity can still write; the other checks catch
// what a run left behind before the home was read-only (t_62992d58). Fail closed.
// `config` is opencode's legacy global config (TOML, merged like opencode.json);
// git (opencode's snapshots) also reads ~/.config/git, npm (opencode's package
// installs) ~/.npmrc. The deploys check the same names before they activate a
// stand (planted_config_preflight), so both lists are exported for that test.
export const projectConfigNames = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".claude", ".agents", ".git", ".gitconfig", ".npmrc"];
export const globalConfigNames = ["opencode.json", "config.json", "config", "AGENTS.md", "agent", "agents", "command", "commands", "mode", "modes", "plugin", "plugins", "tool", "tools", "skill", "skills"];

function present(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// The config directories come from HOME alone: opencode gets HOME and no
// XDG_CONFIG_HOME (runAgent), so an XDG_CONFIG_HOME in the broker's own
// environment would point the check at a directory opencode never reads.
export function assertNoPlantedConfig(root = workspaceRoot, home = process.env.HOME || "/nonexistent") {
  const found = [];
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    found.push(...projectConfigNames.map((name) => path.join(dir, name)).filter(present));
    if (path.dirname(dir) === dir) break;
  }
  const configHome = path.join(home, ".config");
  found.push(...globalConfigNames.map((name) => path.join(configHome, "opencode", name)).filter(present));
  if (present(path.join(configHome, "git"))) found.push(path.join(configHome, "git"));
  if (found.length) throw new Error(`opencode would load ${found.join(", ")} into every role; refusing to start an agent until root removes it`);
}

export function createSessionWorkspace(request, root = workspaceRoot) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoPlantedConfig(root);
  const workspace = fs.mkdtempSync(path.join(root, `agent-${request.requestId}-${request.role}-`));
  fs.chmodSync(workspace, 0o700);
  const common = fs.readFileSync(new URL("AGENTS.md", contextRoot), "utf8");
  const architecture = fs.readFileSync(new URL("system-architecture.md", contextRoot), "utf8");
  const role = fs.readFileSync(new URL(`${request.role}.md`, contextRoot), "utf8");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), `${common.trim()}\n\n${architecture.trim()}\n\n${role.trim()}\n`, { mode: 0o600 });
  for (const dir of Object.values(sessionStateDirs(workspace))) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return workspace;
}

// opencode's state belongs to the run, not to the identity (card t_cb81637b):
// session database, auth.json, logs, locks, the models catalog, downloaded tools
// and its temp directory live below the workspace and go with it. What one run
// writes there (a models.json with other endpoints, an auth.json, a tool in
// cache/bin) never reaches a later role. The name is none opencode loads as
// project config (assertNoPlantedConfig); without git opencode takes no
// snapshots of the workspace.
export function sessionStateDirs(workspace) {
  const base = path.join(workspace, ".run-state");
  return { XDG_DATA_HOME: path.join(base, "data"), XDG_STATE_HOME: path.join(base, "state"), XDG_CACHE_HOME: path.join(base, "cache"), TMPDIR: path.join(base, "tmp") };
}

// The role's whole budget; with Claude in front of a fallback both share it.
// Measured 2026-08-18: a 10-step read-only exploration with deepseek-v4-pro
// takes almost exactly five minutes, so the old 300s default killed every
// planning phase at the moment it finished exploring — the WordPress update
// died mid-handoff with "completed: []". The runner budget rises with it: a
// core+plugins update plus its backup can exceed ten minutes without anything
// being wrong.
export function roleBudgetMs(role) {
  return role === "runner" ? 1800000 : role === "research" ? 120000 : 900000;
}

// Planner and research may run on Claude through the subscription (Jochen,
// 13.11.2026, card t_936d9b0f); safety, verifier and the runner stay on
// opencode. COCKPIT_PLAN_ENGINE=claude in agent.env switches it on; read per
// run, so the unit's environment is the one truth.
export const claudeRoles = new Set(["planner", "research"]);
export function claudeSettings(env = process.env) {
  return {
    enabled: env.COCKPIT_PLAN_ENGINE === "claude",
    executable: env.COCKPIT_CLAUDE_EXECUTABLE || "claude",
    model: env.COCKPIT_CLAUDE_MODEL || "sonnet",
  };
}

// The tools of opencode's plan agent that the two roles use: read, search,
// shell (the unit is the boundary, AGENTS.md "plan denies only the edit tool"),
// web for research. No edit or write tool.
export const claudeTools = "Bash,Read,Grep,Glob,WebFetch,WebSearch";

export function claudeArgs(workspace, model) {
  // --safe-mode: no CLAUDE.md, skills, plugins, hooks, MCP servers, custom
  // agents or commands — whatever lies on the host reaches no role (like
  // opencode's --pure plus assertNoPlantedConfig). The role instructions come
  // from the workspace's root-controlled AGENTS.md, as the system prompt's tail.
  // Listing the tools in --allowedTools lets -p use them without a prompt;
  // every other tool is refused.
  return ["-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--model", model,
    "--tools", claudeTools, "--allowedTools", claudeTools,
    "--append-system-prompt-file", path.join(workspace, "AGENTS.md"), "--output-format", "json"];
}

// Claude's state belongs to the run like opencode's: CLAUDE_CONFIG_DIR below
// the workspace, so no settings, credentials file or session one run leaves
// reaches a later role. The login is the long-lived token from
// `claude setup-token` in agent.env (CLAUDE_CODE_OAUTH_TOKEN); the subprocess
// scrub keeps it out of the shell the model drives (needs bubblewrap; without
// it Claude refuses to start and the run falls back, labelled NOTBETRIEB).
// HOME too: Claude writes caches and its .claude.json there, and the
// identity's home is read-only in the unit (and must not grow a .claude).
export function claudeEnv(workspace, env = process.env) {
  const state = sessionStateDirs(workspace);
  const base = path.dirname(state.XDG_DATA_HOME);
  return {
    HOME: path.join(base, "home"),
    PATH: env.PATH,
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: path.join(base, "claude"),
    ...state,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: env.COCKPIT_CLAUDE_ENV_SCRUB === "0" ? "0" : "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NODE_ENV: "production",
  };
}

// Claude's JSON result: the answer and the model that really answered
// (modelUsage), or why it did not. The reason is shown on the job: clipped,
// one line, never a token-like string.
export function parseClaudeResult(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return { ok: false, json: false, reason: `claude returned no JSON result (${stdout.trim().slice(0, 120) || "empty"})` }; }
  const text = typeof value?.result === "string" ? value.result : "";
  const models = Object.keys(value?.modelUsage || {});
  if (value?.is_error || value?.subtype !== "success" || !text.trim()) {
    return { ok: false, json: true, reason: text.trim() || `claude ended with ${value?.subtype || "an error"}` };
  }
  return { ok: true, output: text, model: models.join(",") || "unknown" };
}

export function cleanReason(text) {
  return String(text).replace(/\s+/g, " ").replace(/[A-Za-z0-9_\-]{32,}/g, "[…]").trim().slice(0, 300);
}

// One process in its workspace with a deadline: stdout, stderr, exit code.
function runProcess(executable, args, env, workspace, prompt, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    // A child that dies before reading its input must not crash the broker (EPIPE).
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, Math.max(1000, timeoutMs));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    child.on("error", (error) => finish({ code: null, spawnError: error.message }));
    child.on("close", (code) => finish({ code }));
  });
}

// One engine run in its own fresh workspace, removed afterwards whatever happens.
async function inWorkspace(request, run) {
  let workspace;
  try {
    workspace = createSessionWorkspace(request);
  } catch (error) {
    return { ok: false, error: `agent workspace setup failed: ${error.message}` };
  }
  let result;
  try {
    result = await run(workspace);
  } finally {
    try { removeSessionWorkspace(workspace); }
    catch (error) { result = { ok: false, error: `agent workspace cleanup failed: ${error.message}` }; }
  }
  return result;
}

export async function runAgent(request) {
  const deadline = Date.now() + roleBudgetMs(request.role);
  const claude = claudeSettings();
  let notbetrieb = null;
  if (claude.enabled && claudeRoles.has(request.role)) {
    const result = await inWorkspace(request, (workspace) => runClaude(request, workspace, claude, deadline));
    if (!result.fallback) return result;
    notbetrieb = result.fallback;
    console.error(`agent ${request.requestId} ${request.role}: claude failed, NOTBETRIEB with opencode: ${notbetrieb}`);
  }
  // The stand-in gets a fresh workspace, checked again for planted config: what
  // the Claude run's shell left in its workspace never reaches opencode.
  const engine = { name: "opencode", model: opencodeModelFor(request.role) || "default", ...(notbetrieb ? { notbetrieb: true, reason: notbetrieb } : {}) };
  const result = await inWorkspace(request, async (workspace) => {
    const run = await runOpencode(request, workspace, deadline - Date.now());
    if (run.spawnError) return { ok: false, error: run.spawnError };
    return { ok: run.code === 0, exitCode: run.code, output: run.stdout, error: run.code === 0 ? null : run.stderr.slice(-4000) };
  });
  return { ...result, engine };
}

// Claude's answer, a failure that ends the role, or { fallback: reason }.
async function runClaude(request, workspace, claude, deadline) {
  const env = claudeEnv(workspace);
  fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  const run = await runProcess(claude.executable, claudeArgs(workspace, claude.model), env, workspace, request.prompt, deadline - Date.now());
  const parsed = parseClaudeResult(run.stdout);
  if (parsed.ok && run.code === 0) return { ok: true, exitCode: 0, output: parsed.output, engine: { name: "claude", model: parsed.model } };
  // A run that used its whole budget has no time left for a second engine,
  // and its failure is no outage: it fails like any role over budget.
  if (run.timedOut) return { ok: false, exitCode: run.code, error: "claude did not finish within the role budget", engine: { name: "claude", model: claude.model } };
  // Without a JSON result (unknown option, sandbox start) the reason is on stderr.
  const reason = run.spawnError || (parsed.ok ? `claude exited with ${run.code}` : parsed.json ? parsed.reason : run.stderr.trim().slice(-300) || parsed.reason);
  return { fallback: cleanReason(reason || "claude failed") };
}

function opencodeModelFor(role) {
  return role === "planner" || role === "research" || role === "runner" ? plannerModel : safetyModel;
}

function runOpencode(request, workspace, timeoutMs) {
  const model = opencodeModelFor(request.role);
  const opencodeAgent = request.role === "runner" ? "build" : "plan";
  // The prompt goes on stdin: `opencode run` without a message reads the
  // piped text as the message (opencode 1.18 run.ts, resolveRunInput). An
  // argv element is capped at 128 KiB by Linux, and run joins argv with
  // quotes and backslash-escaped double quotes, which altered the prompt.
  const args = ["run", "--auto", "--pure", "--agent", opencodeAgent, ...(model ? ["--model", model] : []), "--print-logs"];
  return runProcess(executable, args, {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENCODE_CONFIG: opencodeConfig,
    ...sessionStateDirs(workspace),
    // With an empty cache opencode would fetch the 6 MB models catalog on every
    // run (measured 13.11.2026); the catalog built into the pinned release
    // knows the production models. Providers whose key comes from the
    // environment (agent.env) need no auth.json.
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    // opencode installs packages with npm's config (core npm-config.ts reads
    // the environment); npm's default cache ~/.npm lies in the read-only
    // home, so an install would fail. The cache belongs to the run like
    // opencode's own (card t_2a2d8e5b): what one run puts there never
    // reaches a later role.
    npm_config_cache: path.join(sessionStateDirs(workspace).XDG_CACHE_HOME, "npm"),
    NODE_ENV: "production",
  }, workspace, request.prompt, timeoutMs);
}

if (process.env.NODE_ENV !== "test") {
  cleanupStaleWorkspaces();
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = net.createServer((connection) => {
    let input = ""; let handled = false;
    connection.setEncoding("utf8");
    connection.on("data", async (chunk) => {
      input += chunk; if (input.length > requestLineLimit) { connection.destroy(); return; }
      if (handled || !input.includes("\n")) return;
      handled = true;
      try {
        const result = await runAgent(validateRequest(JSON.parse(input.slice(0, input.indexOf("\n")))));
        connection.end(JSON.stringify(result));
      } catch (error) {
        connection.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" }));
      }
    });
  });
  server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o660); });
}

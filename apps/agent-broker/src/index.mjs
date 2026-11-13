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
const projectConfigNames = ["opencode.json", "opencode.jsonc", ".opencode", "AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".claude", ".agents", ".git", ".gitconfig"];
const globalConfigNames = ["opencode.json", "config.json", "AGENTS.md", "agent", "agents", "command", "commands", "mode", "modes", "plugin", "plugins", "tool", "tools", "skill", "skills"];

function present(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function assertNoPlantedConfig(root = workspaceRoot, configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "/nonexistent", ".config"), "opencode")) {
  const found = [];
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    found.push(...projectConfigNames.map((name) => path.join(dir, name)).filter(present));
    if (path.dirname(dir) === dir) break;
  }
  found.push(...globalConfigNames.map((name) => path.join(configDir, name)).filter(present));
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

export function runAgent(request) {
  return new Promise((resolve) => {
    const model = request.role === "planner" || request.role === "research" || request.role === "runner" ? plannerModel : safetyModel;
    const opencodeAgent = request.role === "runner" ? "build" : "plan";
    // The prompt goes on stdin: `opencode run` without a message reads the
    // piped text as the message (opencode 1.18 run.ts, resolveRunInput). An
    // argv element is capped at 128 KiB by Linux, and run joins argv with
    // quotes and backslash-escaped double quotes, which altered the prompt.
    const args = ["run", "--auto", "--pure", "--agent", opencodeAgent, ...(model ? ["--model", model] : []), "--print-logs"];
    let workspace;
    try {
      workspace = createSessionWorkspace(request);
    } catch (error) {
      resolve({ ok: false, error: `agent workspace setup failed: ${error.message}` });
      return;
    }
    const child = spawn(executable, args, {
      cwd: workspace,
      env: {
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
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A child that dies before reading its input must not crash the broker (EPIPE).
    child.stdin.on("error", () => {});
    child.stdin.end(request.prompt, "utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      try { removeSessionWorkspace(workspace); }
      catch (error) { result = { ok: false, error: `agent workspace cleanup failed: ${error.message}` }; }
      resolve(result);
    };
    let forceKillTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    // Measured 2026-08-18: a 10-step read-only exploration with deepseek-v4-pro
      // takes almost exactly five minutes, so the old 300s default killed every
      // planning phase at the moment it finished exploring — the WordPress
      // update died mid-handoff with "completed: []". The runner budget rises
      // with it: a core+plugins update plus its backup can exceed ten minutes
      // without anything being wrong.
      }, request.role === "runner" ? 1800000 : request.role === "research" ? 120000 : 900000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, output: stdout, error: code === 0 ? null : stderr.slice(-4000) }));
  });
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

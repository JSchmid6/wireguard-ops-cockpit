import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRunDir, reapOrphanedRuns, superviseRun, writeVerdict } from "./supervisor.mjs";
import { prepareEngine, readEngineConfig } from "./engines.mjs";

const socketPath = process.env.COCKPIT_AGENT_BROKER_SOCKET || "/run/wireguard-ops-cockpit/agent.sock";
const workspaceRoot = process.env.COCKPIT_AGENT_WORKSPACE_ROOT || "/var/lib/wireguard-ops-agent/sessions";
const contextRoot = new URL("../context/", import.meta.url);
const staleWorkspaceAgeMs = 24 * 60 * 60 * 1000;
const allowedRoles = new Set(["planner", "research", "runner", "safety", "verifier"]);
// The safety role also reviews the diff of a Cockpit self-update (a bounded
// excerpt, see apps/api/src/update-review.ts), so it gets a larger budget.
// opencode receives the prompt as one argv element: Linux caps a single
// argument at 128 KiB (MAX_ARG_STRLEN), hence the byte bound. Claude and
// Codex read the prompt from stdin; the bound stays the same for every engine.
const promptLimits = { safety: 100000 };
const defaultPromptLimit = 30000;
const promptByteLimit = 120000;
const requestLineLimit = 1048576;
// Wall-clock budget per role, preflight included; the API socket waits 15 s
// longer (apps/api/src/agent-broker.ts): two 5 s kill graces plus margin.
// Measured 2026-08-18 (deepseek-v4-pro): a 10-step read-only exploration took
// almost five minutes, and a core+plugins update plus its backup can exceed ten
// minutes without anything being wrong. The Claude measurements of 2026-10-10
// (doc/setup/agent-claude-cli.md) stay well inside these budgets.
export const ROLE_TIMEOUT_MS = { runner: 1800000, research: 120000, planner: 900000, safety: 900000, verifier: 900000 };

export function validateRequest(value) {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  if (!allowedRoles.has(value.role)) throw new Error("invalid agent role");
  const promptLimit = promptLimits[value.role] || defaultPromptLimit;
  if (typeof value.prompt !== "string" || value.prompt.length < 1 || value.prompt.length > promptLimit) throw new Error("prompt length is invalid");
  if (Buffer.byteLength(value.prompt, "utf8") > promptByteLimit) throw new Error("prompt length is invalid");
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

// Common contract + architecture + role contract. opencode reads it as the
// workspace AGENTS.md; the Claude CLI does not read AGENTS.md on its own and
// gets the same text through --append-system-prompt.
export function roleContext(role) {
  const common = fs.readFileSync(new URL("AGENTS.md", contextRoot), "utf8");
  const architecture = fs.readFileSync(new URL("system-architecture.md", contextRoot), "utf8");
  const instructions = fs.readFileSync(new URL(`${role}.md`, contextRoot), "utf8");
  return `${common.trim()}\n\n${architecture.trim()}\n\n${instructions.trim()}\n`;
}

export function createSessionWorkspace(request, root = workspaceRoot) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = fs.mkdtempSync(path.join(root, `agent-${request.requestId}-${request.role}-`));
  fs.chmodSync(workspace, 0o700);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), roleContext(request.role), { mode: 0o600 });
  return workspace;
}

function publicEngine(verdict) {
  return { antrieb: verdict.antrieb, modell: verdict.modell, cliVersion: verdict.cliVersion, etikett: verdict.etikett, lauf: verdict.lauf };
}

// One supervised run: preflight → own process group → events.jsonl → verdict
// (lauf.json). Anything but "erfolg" is ok:false; the API treats that as no
// review, so nothing is approved (fail closed). There is no silent fallback to
// another engine.
export async function runAgent(request, { config = readEngineConfig(), timeouts = ROLE_TIMEOUT_MS, graceMs } = {}) {
  const started = Date.now();
  const deadline = started + timeouts[request.role];
  const runId = `${request.requestId}-${request.role}`.slice(0, 96);
  let runDir;
  let workspace;
  try {
    runDir = createRunDir(config.runsRoot, runId);
    workspace = createSessionWorkspace(request);
  } catch (error) {
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    return { ok: false, error: `agent workspace setup failed: ${error.message}` };
  }
  let result;
  try {
    const prepared = await prepareEngine(request.role, request.prompt, roleContext(request.role), config, { workspace, runDir });
    if (!prepared.ok) {
      const ende = Date.now();
      const verdict = {
        lauf: runId, rolle: request.role, antrieb: config.engine, modell: null, etikett: null, status: "nicht_verfuegbar", grund: prepared.grund,
        exitCode: null, signal: null, start: new Date(started).toISOString(), ende: new Date(ende).toISOString(), dauerMs: ende - started, cliVersion: prepared.cliVersion || null,
      };
      writeVerdict(config.runsRoot, runDir, verdict);
      result = {
        ok: false, error: `agent engine ${config.engine} not available: ${prepared.grund}; no review, nothing is approved`,
        verdict: { status: verdict.status, grund: verdict.grund, dauerMs: verdict.dauerMs }, engine: publicEngine(verdict),
      };
    } else {
      const run = await superviseRun({
        runsRoot: config.runsRoot, runDir, runId, role: request.role, engine: prepared.engine, cwd: workspace, deadline, started,
        ...(graceMs !== undefined ? { graceMs } : {}),
      });
      const { verdict } = run;
      const summary = { status: verdict.status, grund: verdict.grund, dauerMs: verdict.dauerMs };
      result = verdict.status === "erfolg"
        ? { ok: true, exitCode: verdict.exitCode, output: run.output, error: null, verdict: summary, engine: publicEngine(verdict) }
        : {
          ok: false, exitCode: verdict.exitCode, verdict: summary, engine: publicEngine(verdict),
          error: `agent engine ${verdict.antrieb} ${verdict.status}: ${verdict.grund}${verdict.antrieb === "opencode" && run.stderr ? `\n${run.stderr}` : ""}`,
        };
    }
  } catch (error) {
    result = { ok: false, error: `agent run failed: ${error.message}` };
    try {
      if (!fs.existsSync(path.join(runDir, "lauf.json"))) {
        writeVerdict(config.runsRoot, runDir, { lauf: runId, rolle: request.role, antrieb: config.engine, status: "fehler", grund: `Broker-Fehler: ${error.message}`, start: new Date(started).toISOString(), ende: new Date().toISOString(), dauerMs: Date.now() - started, cliVersion: null });
      }
    } catch { /* the answer to the API already says fehler */ }
  }
  try { removeSessionWorkspace(workspace); }
  catch (error) { result = { ok: false, error: `agent workspace cleanup failed: ${error.message}` }; }
  return result;
}

if (process.env.NODE_ENV !== "test") {
  cleanupStaleWorkspaces();
  await reapOrphanedRuns(readEngineConfig().runsRoot);
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

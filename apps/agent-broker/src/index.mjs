import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const socketPath = process.env.COCKPIT_AGENT_BROKER_SOCKET || "/run/wireguard-ops-cockpit/agent.sock";
const executable = process.env.COCKPIT_OPENCODE_EXECUTABLE || "opencode";
const plannerModel = process.env.COCKPIT_OPENCODE_MODEL || "";
const safetyModel = process.env.COCKPIT_SAFETY_OPENCODE_MODEL || plannerModel;
const workspaceRoot = process.env.COCKPIT_AGENT_WORKSPACE_ROOT || "/var/lib/wireguard-ops-agent/sessions";
const contextRoot = new URL("../context/", import.meta.url);
const staleWorkspaceAgeMs = 24 * 60 * 60 * 1000;
const allowedRoles = new Set(["planner", "runner", "safety", "verifier"]);

export function validateRequest(value) {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  if (!allowedRoles.has(value.role)) throw new Error("invalid agent role");
  if (typeof value.prompt !== "string" || value.prompt.length < 1 || value.prompt.length > 30000) throw new Error("prompt length is invalid");
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

export function createSessionWorkspace(request, root = workspaceRoot) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = fs.mkdtempSync(path.join(root, `agent-${request.requestId}-${request.role}-`));
  fs.chmodSync(workspace, 0o700);
  const common = fs.readFileSync(new URL("AGENTS.md", contextRoot), "utf8");
  const role = fs.readFileSync(new URL(`${request.role}.md`, contextRoot), "utf8");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), `${common.trim()}\n\n${role.trim()}\n`, { mode: 0o600 });
  return workspace;
}

export function runAgent(request) {
  return new Promise((resolve) => {
    const model = request.role === "planner" || request.role === "runner" ? plannerModel : safetyModel;
    const opencodeAgent = request.role === "runner" ? "build" : "plan";
    const args = ["run", "--auto", "--pure", "--agent", opencodeAgent, ...(model ? ["--model", model] : []), "--print-logs", request.prompt];
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
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    }, request.role === "runner" ? 600000 : 300000);
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
      input += chunk; if (input.length > 65536) { connection.destroy(); return; }
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

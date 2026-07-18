import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";

const socketPath = process.env.COCKPIT_AGENT_BROKER_SOCKET || "/run/wireguard-ops-cockpit/agent.sock";
const executable = process.env.COCKPIT_OPENCODE_EXECUTABLE || "opencode";
const plannerModel = process.env.COCKPIT_OPENCODE_MODEL || "";
const safetyModel = process.env.COCKPIT_SAFETY_OPENCODE_MODEL || plannerModel;
const allowedRoles = new Set(["planner", "runner", "safety", "verifier"]);

export function validateRequest(value) {
  if (!value || typeof value !== "object") throw new Error("request must be an object");
  if (!allowedRoles.has(value.role)) throw new Error("invalid agent role");
  if (typeof value.prompt !== "string" || value.prompt.length < 1 || value.prompt.length > 30000) throw new Error("prompt length is invalid");
  if (typeof value.requestId !== "string" || !/^[a-f0-9-]{8,64}$/i.test(value.requestId)) throw new Error("requestId is invalid");
  return { requestId: value.requestId, role: value.role, prompt: value.prompt };
}

export function runAgent(request) {
  return new Promise((resolve) => {
    const model = request.role === "planner" || request.role === "runner" ? plannerModel : safetyModel;
    const args = ["run", "--auto", ...(model ? ["--model", model] : []), "--print-logs", request.prompt];
    const child = spawn(executable, args, {
      cwd: "/opt/wireguard-ops-cockpit",
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
    const timer = setTimeout(() => child.kill("SIGTERM"), request.role === "runner" ? 600000 : 300000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 2_000_000) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, exitCode: code, output: stdout, error: code === 0 ? null : stderr.slice(-4000) }); });
  });
}

if (process.env.NODE_ENV !== "test") {
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

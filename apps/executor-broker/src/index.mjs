import net from "node:net";
import fs from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const socketPath = process.env.COCKPIT_EXECUTOR_BROKER_SOCKET || "/run/wireguard-ops-cockpit/executor.sock";
const secret = process.env.COCKPIT_EXECUTOR_BROKER_SECRET || "";
const helper = "/usr/local/sbin/cockpit-service-action";
const capabilityHelper = "/usr/local/lib/wireguard-ops-cockpit/cockpit-capability-action.mjs";
const capabilityNode = "/opt/node-v20.19.1-linux-x64/bin/node";
const services = new Set(["apache2", "wireguard-ops-cockpit-ttyd"]);

function signature(payload) { return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex"); }
export function validateRequest(value, now = Date.now()) {
  if (!secret) throw new Error("executor broker secret is not configured");
  if (!value || typeof value !== "object" || !value.payload || typeof value.signature !== "string") throw new Error("invalid signed request");
  const expected = signature(value.payload);
  if (!/^[a-f0-9]{64}$/.test(value.signature) || !timingSafeEqual(Buffer.from(value.signature, "hex"), Buffer.from(expected, "hex"))) throw new Error("invalid request signature");
  const { action, target, expiresAt, envelopeDigest } = value.payload;
  if (action !== "service.restart" && action !== "service.status" && action !== "capability.execute") throw new Error("unsupported capability action");
  if (action.startsWith("service.") && !services.has(target)) throw new Error("service target is not allowlisted");
  if (action === "capability.execute" && (!value.payload.manifest || !value.payload.envelope)) throw new Error("dynamic capability payload is incomplete");
  if (typeof envelopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(envelopeDigest)) throw new Error("invalid envelope digest");
  if (typeof expiresAt !== "string" || now > Date.parse(expiresAt)) throw new Error("execution request expired");
  return value.payload;
}

export function execute(payload) {
  return new Promise((resolve) => {
    if (payload.action === "capability.execute") {
      const child = spawn("sudo", ["-n", capabilityNode, capabilityHelper], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; let error = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
      child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: output.slice(-50000), error: code === 0 ? null : error.slice(-10000) }));
      child.stdin.end(JSON.stringify({ manifest: payload.manifest, envelope: payload.envelope }));
      return;
    }
    const verb = payload.action === "service.restart" ? "restart" : "status";
    const child = spawn("sudo", ["-n", helper, verb, payload.target], { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", (reason) => resolve({ ok: false, error: reason.message }));
    child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: output.slice(-20000), error: code === 0 ? null : error.slice(-4000) }));
  });
}

if (process.env.NODE_ENV !== "test") {
  try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = net.createServer((connection) => {
    let input = ""; let handled = false; connection.setEncoding("utf8");
    connection.on("data", async (chunk) => {
      input += chunk; if (input.length > 524288) { connection.destroy(); return; }
      if (handled || !input.includes("\n")) return;
      handled = true;
      try { connection.end(JSON.stringify(await execute(validateRequest(JSON.parse(input.slice(0, input.indexOf("\n"))))))); }
      catch (error) { connection.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" })); }
    });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
}

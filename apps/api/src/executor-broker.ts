import net from "node:net";
import { createHmac } from "node:crypto";

import type { CapabilityManifest } from "./capability-manifest.js";
import type { ExecutionEnvelope } from "./hermes-security.js";

export interface ExecutorAction { action: "service.restart" | "service.status"; target: string; expiresAt: string; envelopeDigest: string }
export interface DynamicExecutorAction { action: "capability.execute"; manifest: CapabilityManifest; envelope: ExecutionEnvelope; expiresAt: string; envelopeDigest: string }
export async function runExecutorAction(socketPath: string, secret: string, payload: ExecutorAction): Promise<string> {
  const signature = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath); let response = "";
    connection.setEncoding("utf8"); connection.setTimeout(60000);
    connection.on("connect", () => connection.write(`${JSON.stringify({ payload, signature })}\n`));
    connection.on("data", (chunk) => { response += chunk; }); connection.on("timeout", () => connection.destroy(new Error("executor broker timed out")));
    connection.on("error", reject); connection.on("close", () => {
      try { const parsed = JSON.parse(response) as { ok?: boolean; output?: string; error?: string }; parsed.ok ? resolve(parsed.output || "") : reject(new Error(parsed.error || "executor broker failed")); }
      catch (error) { reject(error); }
    });
  });
}

export async function runDynamicCapability(socketPath: string, secret: string, payload: DynamicExecutorAction): Promise<string> {
  const signature = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath); let response = "";
    connection.setEncoding("utf8"); connection.setTimeout(16 * 60_000);
    connection.on("connect", () => connection.write(`${JSON.stringify({ payload, signature })}\n`));
    connection.on("data", (chunk) => { response += chunk; }); connection.on("timeout", () => connection.destroy(new Error("dynamic capability timed out")));
    connection.on("error", reject); connection.on("close", () => {
      try { const parsed = JSON.parse(response) as { ok?: boolean; output?: string; error?: string }; parsed.ok ? resolve(parsed.output || "") : reject(new Error(parsed.error || "dynamic capability failed")); }
      catch (error) { reject(error); }
    });
  });
}

import net from "node:net";
import { randomUUID } from "node:crypto";

export type AgentBrokerRole = "planner" | "research" | "runner" | "safety" | "verifier";

export async function runBrokerAgent(socketPath: string, role: AgentBrokerRole, prompt: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    let response = "";
    connection.setEncoding("utf8");
    connection.setTimeout(role === "runner" ? 610000 : 310000);
    connection.on("connect", () => connection.write(`${JSON.stringify({ requestId: randomUUID(), role, prompt })}\n`));
    connection.on("data", (chunk) => { response += chunk; if (response.length > 2_200_000) connection.destroy(new Error("agent broker response too large")); });
    connection.on("timeout", () => connection.destroy(new Error("agent broker timed out")));
    connection.on("error", reject);
    connection.on("close", () => {
      try {
        const parsed = JSON.parse(response) as { ok?: boolean; output?: string; error?: string };
        if (!parsed.ok || typeof parsed.output !== "string") reject(new Error(parsed.error || "agent broker failed"));
        else resolve(parsed.output);
      } catch (error) { reject(error); }
    });
  });
}

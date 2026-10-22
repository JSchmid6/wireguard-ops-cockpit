import net from "node:net";
import { randomUUID } from "node:crypto";
import { promptLimit, promptLimitProblem, type AgentRole } from "../../agent-broker/src/prompt-limits.mjs";

export type AgentBrokerRole = AgentRole;

// The broker's prompt bound for a role, from the one file the broker itself
// enforces (prompt-limits.mjs): a requester builds its prompt within it.
export function agentPromptLimit(role: AgentBrokerRole): number {
  return promptLimit(role);
}

export async function runBrokerAgent(socketPath: string, role: AgentBrokerRole, prompt: string): Promise<string> {
  // The same check as the broker's, before the socket: the error names bound and length.
  const problem = promptLimitProblem(role, prompt);
  if (problem) throw new Error(problem);
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    let response = "";
    connection.setEncoding("utf8");
    // Must stay above the broker's own kill budget (runner 30 min, default 15),
        // or the socket gives up on a run the broker still considers alive.
        connection.setTimeout(role === "runner" ? 1810000 : 910000);
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

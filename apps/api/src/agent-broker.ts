import net from "node:net";
import { randomUUID } from "node:crypto";
import { promptLimit, promptLimitProblem, type AgentRole } from "../../agent-broker/src/prompt-limits.mjs";

export type AgentBrokerRole = AgentRole;

// The broker's prompt bound for a role, from the one file the broker itself
// enforces (prompt-limits.mjs): a requester builds its prompt within it.
export function agentPromptLimit(role: AgentBrokerRole): number {
  return promptLimit(role);
}

// The runner (opencode build) runs under its own identity behind its own socket;
// the plan roles' broker does not serve it (card t_cb81637b). Fail closed: with
// isolation on and no runner socket configured, no runner starts — sending it to
// the plan roles' broker would give it their identity back.
export function brokerSocketForRole(
  config: { agentBrokerSocket: string | null; runnerBrokerSocket?: string | null },
  role: AgentBrokerRole,
): string {
  if (!config.agentBrokerSocket) throw new Error("the isolated agent broker is not configured");
  if (role !== "runner") return config.agentBrokerSocket;
  if (!config.runnerBrokerSocket) {
    throw new Error("the runner needs its own broker identity (COCKPIT_RUNNER_BROKER_SOCKET); it never runs in the plan roles' broker");
  }
  return config.runnerBrokerSocket;
}

// Which engine answered (broker index.mjs runInWorkspace): Claude through the
// subscription for planner/research when switched on, otherwise opencode.
// notbetrieb: Claude failed and opencode (DeepSeek) stood in (card t_936d9b0f).
export interface AgentEngine {
  name: string;
  model: string;
  notbetrieb?: true;
  reason?: string;
}

function brokerEngine(value: unknown): AgentEngine | null {
  if (!value || typeof value !== "object") return null;
  const engine = value as Record<string, unknown>;
  if (typeof engine.name !== "string" || typeof engine.model !== "string") return null;
  return {
    name: engine.name.slice(0, 40), model: engine.model.slice(0, 120),
    ...(engine.notbetrieb === true ? { notbetrieb: true as const, reason: typeof engine.reason === "string" ? engine.reason.slice(0, 300) : "unknown" } : {}),
  };
}

export class BrokerAgentError extends Error {
  constructor(message: string, readonly engine: AgentEngine | null) {
    super(message);
  }
}

export async function runBrokerAgent(socketPath: string, role: AgentBrokerRole, prompt: string): Promise<string> {
  return (await runBrokerAgentWithEngine(socketPath, role, prompt)).output;
}

export async function runBrokerAgentWithEngine(socketPath: string, role: AgentBrokerRole, prompt: string): Promise<{ output: string; engine: AgentEngine | null }> {
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
        const parsed = JSON.parse(response) as { ok?: boolean; output?: string; error?: string; engine?: unknown };
        // A failed run still names its engine: Claude failed and the stand-in too
        // is a NOTBETRIEB the job must show (BrokerAgentError.engine).
        if (!parsed.ok || typeof parsed.output !== "string") reject(new BrokerAgentError(parsed.error || "agent broker failed", brokerEngine(parsed.engine)));
        else resolve({ output: parsed.output, engine: brokerEngine(parsed.engine) });
      } catch (error) { reject(error); }
    });
  });
}

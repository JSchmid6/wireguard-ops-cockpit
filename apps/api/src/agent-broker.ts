import net from "node:net";
import { randomUUID } from "node:crypto";

export type AgentBrokerRole = "planner" | "research" | "runner" | "safety" | "verifier";

// The engine the broker ran (apps/agent-broker/src/engines.mjs). `etikett` is
// set only for an engine other than the Claude CLI (Codex, or DeepSeek through
// opencode behind its explicit switch) and must stay visible in every verdict.
export interface BrokerEngine {
  antrieb: string;
  modell: string | null;
  cliVersion: string | null;
  etikett: string | null;
  lauf?: string;
}

export interface BrokerAgentReport {
  output: string;
  engine: BrokerEngine | null;
}

// A reviewer answer: the plain text, or the text with the engine that wrote it.
export type ReviewerAnswer = string | BrokerAgentReport;

export function describeEngine(engine: BrokerEngine | null | undefined): string | null {
  if (!engine || typeof engine.antrieb !== "string") return null;
  if (engine.etikett) return engine.etikett;
  return `${engine.antrieb}${engine.modell ? ` ${engine.modell}` : ""}${engine.cliVersion ? ` (CLI ${engine.cliVersion})` : ""}`;
}

export function reviewerText(answer: ReviewerAnswer): string {
  return typeof answer === "string" ? answer : answer.output;
}

export function reviewerLabel(answer: ReviewerAnswer): string | null {
  return typeof answer === "string" ? null : describeEngine(answer.engine);
}

function parseEngine(value: unknown): BrokerEngine | null {
  if (!value || typeof value !== "object") return null;
  const engine = value as Record<string, unknown>;
  if (typeof engine.antrieb !== "string") return null;
  const text = (item: unknown) => (typeof item === "string" ? item.slice(0, 300) : null);
  return { antrieb: engine.antrieb.slice(0, 40), modell: text(engine.modell), cliVersion: text(engine.cliVersion), etikett: text(engine.etikett), ...(typeof engine.lauf === "string" ? { lauf: engine.lauf.slice(0, 120) } : {}) };
}

// Any broker answer other than ok with text rejects: an engine that is not
// available ("nicht_verfuegbar"), timed out or failed never yields a review,
// so every caller fails closed.
export async function runBrokerAgentReport(socketPath: string, role: AgentBrokerRole, prompt: string): Promise<BrokerAgentReport> {
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    let response = "";
    connection.setEncoding("utf8");
    // Must stay above the broker's own kill budget (runner 30 min, default 15,
    // preflight included) plus up to two 5 s kill graces, or the socket gives
    // up on a run the broker still considers alive.
    connection.setTimeout(role === "runner" ? 1815000 : 915000);
    connection.on("connect", () => connection.write(`${JSON.stringify({ requestId: randomUUID(), role, prompt })}\n`));
    connection.on("data", (chunk) => { response += chunk; if (response.length > 2_200_000) connection.destroy(new Error("agent broker response too large")); });
    connection.on("timeout", () => connection.destroy(new Error("agent broker timed out")));
    connection.on("error", reject);
    connection.on("close", () => {
      try {
        const parsed = JSON.parse(response) as { ok?: boolean; output?: string; error?: string; engine?: unknown };
        if (!parsed.ok || typeof parsed.output !== "string") reject(new Error(parsed.error || "agent broker failed"));
        else resolve({ output: parsed.output, engine: parseEngine(parsed.engine) });
      } catch (error) { reject(error); }
    });
  });
}

export async function runBrokerAgent(socketPath: string, role: AgentBrokerRole, prompt: string): Promise<string> {
  return (await runBrokerAgentReport(socketPath, role, prompt)).output;
}

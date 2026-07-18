import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  apiHost: string;
  apiPort: number;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  tmuxMode: "auto" | "disabled";
  ttydBaseUrl: string | null;
  terminalSigningSecret: string;
  executionEnvelopeSecret: string;
  repoRoot: string;
  plannerRuntime: "copilot-cli" | "demo-local" | "opencode";
  copilotExecutable: string;
  copilotModel: string | null;
  opencodeExecutable: string;
  opencodeModel: string | null;
  safetyOpencodeModel: string | null;
  requireModelDiversity: boolean;
  approvalTtlMinutes: number;
  maxFailedChangesPerHour: number;
  agentBrokerSocket: string | null;
  executorBrokerSocket: string | null;
  executorBrokerSecret: string | null;
  nodeEnv: string;
}

function currentDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = path.resolve(currentDirectory(), "../../..");
  const nodeEnv = env.NODE_ENV || "development";
  const cookieSecure =
    env.COCKPIT_COOKIE_SECURE === undefined ? nodeEnv === "production" : env.COCKPIT_COOKIE_SECURE === "true";

  const terminalSigningSecret = env.COCKPIT_TERMINAL_SIGNING_SECRET || "development-terminal-secret";
  return {
    apiHost: env.COCKPIT_API_HOST || "127.0.0.1",
    apiPort: Number(env.COCKPIT_API_PORT || "3001"),
    dbPath: env.COCKPIT_DB_PATH || path.join(repoRoot, "data", "cockpit.sqlite"),
    adminUsername: env.COCKPIT_ADMIN_USERNAME || "admin",
    adminPassword: env.COCKPIT_ADMIN_PASSWORD || "change-me-now",
    sessionTtlHours: Number(env.COCKPIT_SESSION_TTL_HOURS || "12"),
    cookieSecure,
    tmuxMode: env.COCKPIT_TMUX_MODE === "disabled" ? "disabled" : "auto",
    ttydBaseUrl: env.COCKPIT_TTYD_BASE_URL?.trim() || null,
    terminalSigningSecret,
    executionEnvelopeSecret: env.COCKPIT_EXECUTION_ENVELOPE_SECRET || terminalSigningSecret,
    repoRoot,
    plannerRuntime:
      env.COCKPIT_PLANNER_RUNTIME === "demo-local"
        ? "demo-local"
        : env.COCKPIT_PLANNER_RUNTIME === "opencode"
          ? "opencode"
          : "copilot-cli",
    copilotExecutable: env.COCKPIT_COPILOT_EXECUTABLE?.trim() || "copilot",
    copilotModel: env.COCKPIT_COPILOT_MODEL?.trim() || null,
    opencodeExecutable: env.COCKPIT_OPENCODE_EXECUTABLE?.trim() || "opencode",
    opencodeModel: env.COCKPIT_OPENCODE_MODEL?.trim() || null,
    safetyOpencodeModel: env.COCKPIT_SAFETY_OPENCODE_MODEL?.trim() || env.COCKPIT_OPENCODE_MODEL?.trim() || null,
    requireModelDiversity: env.COCKPIT_REQUIRE_MODEL_DIVERSITY === "true",
    approvalTtlMinutes: Math.max(1, Number(env.COCKPIT_APPROVAL_TTL_MINUTES || "30")),
    maxFailedChangesPerHour: Math.max(1, Number(env.COCKPIT_MAX_FAILED_CHANGES_PER_HOUR || "3")),
    agentBrokerSocket: env.COCKPIT_AGENT_BROKER_SOCKET?.trim() || null,
    executorBrokerSocket: env.COCKPIT_EXECUTOR_BROKER_SOCKET?.trim() || null,
    executorBrokerSecret: env.COCKPIT_EXECUTOR_BROKER_SECRET?.trim() || null,
    nodeEnv
  };
}

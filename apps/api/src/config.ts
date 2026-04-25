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
  repoRoot: string;
  plannerRuntime: "copilot-cli" | "demo-local";
  copilotExecutable: string;
  copilotModel: string | null;
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
    terminalSigningSecret: env.COCKPIT_TERMINAL_SIGNING_SECRET || "development-terminal-secret",
    repoRoot,
    plannerRuntime: env.COCKPIT_PLANNER_RUNTIME === "demo-local" ? "demo-local" : "copilot-cli",
    copilotExecutable: env.COCKPIT_COPILOT_EXECUTABLE?.trim() || "copilot",
    copilotModel: env.COCKPIT_COPILOT_MODEL?.trim() || null,
    nodeEnv
  };
}

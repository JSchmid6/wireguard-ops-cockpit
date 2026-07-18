import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("provides safe local defaults", () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe("development");
    expect(config.apiHost).toBe("127.0.0.1");
    expect(config.apiPort).toBe(3001);
    expect(config.adminUsername).toBe("admin");
    expect(config.adminPassword).toBe("change-me-now");
    expect(config.cookieSecure).toBe(false);
    expect(config.tmuxMode).toBe("auto");
    expect(config.ttydBaseUrl).toBeNull();
    expect(config.terminalSigningSecret).toBe("development-terminal-secret");
    expect(config.executionEnvelopeSecret).toBe("development-terminal-secret");
    expect(config.plannerRuntime).toBe("copilot-cli");
    expect(config.copilotExecutable).toBe("copilot");
    expect(config.copilotModel).toBeNull();
    expect(config.opencodeExecutable).toBe("opencode");
    expect(config.opencodeModel).toBeNull();
    expect(config.safetyOpencodeModel).toBeNull();
    expect(config.requireModelDiversity).toBe(false);
    expect(config.approvalTtlMinutes).toBe(30);
    expect(config.dbPath.endsWith(path.join("data", "cockpit.sqlite"))).toBe(true);
    expect(path.isAbsolute(config.repoRoot)).toBe(true);
  });

  it("respects explicit environment overrides", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      COCKPIT_API_HOST: "0.0.0.0",
      COCKPIT_API_PORT: "4001",
      COCKPIT_DB_PATH: "/tmp/cockpit.sqlite",
      COCKPIT_ADMIN_USERNAME: "ops",
      COCKPIT_ADMIN_PASSWORD: "top-secret",
      COCKPIT_SESSION_TTL_HOURS: "48",
      COCKPIT_COOKIE_SECURE: "false",
      COCKPIT_TMUX_MODE: "disabled",
      COCKPIT_TTYD_BASE_URL: "https://ttyd.example/bridge  ",
      COCKPIT_TERMINAL_SIGNING_SECRET: "terminal-secret",
      COCKPIT_EXECUTION_ENVELOPE_SECRET: "envelope-secret",
      COCKPIT_PLANNER_RUNTIME: "demo-local",
      COCKPIT_COPILOT_EXECUTABLE: "/usr/local/bin/copilot",
      COCKPIT_COPILOT_MODEL: "gpt-5.4"
    });

    expect(config.nodeEnv).toBe("production");
    expect(config.apiHost).toBe("0.0.0.0");
    expect(config.apiPort).toBe(4001);
    expect(config.dbPath).toBe("/tmp/cockpit.sqlite");
    expect(config.adminUsername).toBe("ops");
    expect(config.adminPassword).toBe("top-secret");
    expect(config.sessionTtlHours).toBe(48);
    expect(config.cookieSecure).toBe(false);
    expect(config.tmuxMode).toBe("disabled");
    expect(config.ttydBaseUrl).toBe("https://ttyd.example/bridge");
    expect(config.terminalSigningSecret).toBe("terminal-secret");
    expect(config.executionEnvelopeSecret).toBe("envelope-secret");
    expect(config.plannerRuntime).toBe("demo-local");
    expect(config.copilotExecutable).toBe("/usr/local/bin/copilot");
    expect(config.copilotModel).toBe("gpt-5.4");
  });

  it("resolves the opencode planner runtime", () => {
    const config = loadConfig({
      COCKPIT_PLANNER_RUNTIME: "opencode",
      COCKPIT_OPENCODE_EXECUTABLE: "/usr/local/bin/opencode",
      COCKPIT_OPENCODE_MODEL: "openai/gpt-4o",
      COCKPIT_SAFETY_OPENCODE_MODEL: "anthropic/claude-sonnet-4",
      COCKPIT_REQUIRE_MODEL_DIVERSITY: "true",
      COCKPIT_APPROVAL_TTL_MINUTES: "15"
    });

    expect(config.plannerRuntime).toBe("opencode");
    expect(config.opencodeExecutable).toBe("/usr/local/bin/opencode");
    expect(config.opencodeModel).toBe("openai/gpt-4o");
    expect(config.safetyOpencodeModel).toBe("anthropic/claude-sonnet-4");
    expect(config.requireModelDiversity).toBe(true);
    expect(config.approvalTtlMinutes).toBe(15);
  });
});

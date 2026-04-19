import { spawnSync } from "node:child_process";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd?: string;
}

export interface SessionHandle {
  name: string;
  backend: "tmux" | "disabled";
}

export interface LaunchResult {
  started: boolean;
  backend: "tmux" | "disabled";
  note: string;
}

export interface TmuxAdapter {
  readonly backend: "tmux" | "disabled";
  ensureSession(name: string): SessionHandle;
  listSessions(): string[];
  launchCommand(sessionName: string, windowName: string, command: CommandSpec): LaunchResult;
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-_]{1,31}$/i;

function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`${label} must match ${SAFE_NAME.source}`);
  }
}

function tmuxAvailable(): boolean {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  return result.status === 0;
}

function runTmux(args: string[]): void {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "tmux command failed";
    throw new Error(detail);
  }
}

class DisabledTmuxAdapter implements TmuxAdapter {
  readonly backend = "disabled" as const;

  ensureSession(name: string): SessionHandle {
    assertSafeName(name, "session name");
    return { name, backend: this.backend };
  }

  listSessions(): string[] {
    return [];
  }

  launchCommand(): LaunchResult {
    return {
      started: false,
      backend: this.backend,
      note: "tmux integration is disabled in this runtime"
    };
  }
}

class LocalTmuxAdapter implements TmuxAdapter {
  readonly backend = "tmux" as const;

  ensureSession(name: string): SessionHandle {
    assertSafeName(name, "session name");

    const existing = spawnSync("tmux", ["has-session", "-t", name], { encoding: "utf8" });
    if (existing.status !== 0) {
      runTmux(["new-session", "-d", "-s", name, "-n", "main"]);
    }

    return { name, backend: this.backend };
  }

  listSessions(): string[] {
    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8"
    });

    if (result.status !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  launchCommand(sessionName: string, windowName: string, command: CommandSpec): LaunchResult {
    assertSafeName(sessionName, "session name");
    assertSafeName(windowName, "window name");

    if (command.executable.includes("\u0000")) {
      throw new Error("command executable contains invalid characters");
    }

    const args = ["new-window", "-d", "-t", sessionName, "-n", windowName];
    if (command.cwd) {
      args.push("-c", command.cwd);
    }
    args.push(command.executable, ...command.args);

    runTmux(args);

    return {
      started: true,
      backend: this.backend,
      note: `started ${command.executable} in tmux window ${windowName}`
    };
  }
}

export function createTmuxAdapter(mode: "auto" | "disabled" = "auto"): TmuxAdapter {
  if (mode === "disabled") {
    return new DisabledTmuxAdapter();
  }

  if (!tmuxAvailable()) {
    return new DisabledTmuxAdapter();
  }

  return new LocalTmuxAdapter();
}

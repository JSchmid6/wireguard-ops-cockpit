import path from "node:path";
import type { AgentManifest, RunbookDefinition } from "@wireguard-ops-cockpit/domain";
import type { CommandSpec } from "@wireguard-ops-cockpit/tmux-adapter";

export const INTERNAL_EXECUTION_AGENTS = {
  planner: {
    id: "planner-agent",
    name: "Planner agent"
  },
  safety: {
    id: "safety-agent",
    name: "Safety agent"
  }
} as const;

export const RUNBOOKS: RunbookDefinition[] = [
  {
    id: "disk-health-check",
    name: "Disk and backup health check",
    summary: "Runs a real host-side disk and filesystem check inside the selected tmux session.",
    requiresSession: true,
    requiresApproval: false,
    integration: "host-tmux",
    privilegedHelperRequested: false
  },
  {
    id: "nextcloud-update-plan",
    name: "Nextcloud update plan",
    summary: "Runs a bounded host-side Nextcloud inspection and leaves the operator in the tmux session with the resulting update context.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true
  },
  {
    id: "service-restart-request",
    name: "Nextcloud web stack restart",
    summary: "Restarts php8.3-fpm and apache2 through a bounded approved helper in the selected tmux session.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true
  }
];

export const AGENTS: AgentManifest[] = [
  {
    id: "planner-agent",
    name: "Planner agent",
    description:
      "Produces a structured repair or maintenance plan in the task session before safety review, policy checks, approvals, and bounded execution continue.",
    requiresApproval: false,
    privilegedHelperRequested: false,
    integration: "control-plane"
  }
];

export function listAgents(): AgentManifest[] {
  return AGENTS;
}

export function findRunbook(runbookId: string): RunbookDefinition | undefined {
  return RUNBOOKS.find((runbook) => runbook.id === runbookId);
}

export function findAgent(agentId: string): AgentManifest | undefined {
  return AGENTS.find((agent) => agent.id === agentId);
}

export function buildAgentCommand(
  repoRoot: string,
  agent: AgentManifest,
  prompt: string
): { executable: string; args: string[]; cwd: string } {
  return {
    executable: "node",
    args: [
      path.resolve(repoRoot, "apps/api/runtime/demo-agent.mjs"),
      "--agent-id",
      agent.id,
      "--agent-name",
      agent.name,
      "--integration",
      agent.integration,
      "--prompt",
      prompt
    ],
    cwd: repoRoot
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildRunbookDispatch(
  repoRoot: string,
  runbook: RunbookDefinition
): {
  windowName: string;
  command: CommandSpec;
} {
  const commandByRunbook: Record<string, { windowName: string; commandLine: string }> = {
    "disk-health-check": {
      windowName: "disk-health",
      commandLine: `${shellQuote(path.resolve(repoRoot, "bin/disk-health-check.sh"))}`
    },
    "nextcloud-update-plan": {
      windowName: "nextcloud-plan",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-update-plan.sh"))}`
    },
    "service-restart-request": {
      windowName: "web-restart",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/restart-nextcloud-web-stack.sh"))}`
    }
  };

  const dispatch = commandByRunbook[runbook.id];
  if (!dispatch) {
    throw new Error(`no dispatch command registered for runbook ${runbook.id}`);
  }

  return {
    windowName: dispatch.windowName,
    command: {
      executable: "bash",
      args: [
        "-lc",
        `set -euo pipefail; ${dispatch.commandLine}; status=$?; printf '\\nRunbook finished with exit code %s. Staying attached for operator follow-up.\\n' "$status"; exec bash`
      ],
      cwd: repoRoot
    }
  };
}

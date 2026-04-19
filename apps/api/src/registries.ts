import path from "node:path";
import type { AgentManifest, RunbookDefinition } from "@wireguard-ops-cockpit/domain";

export const RUNBOOKS: RunbookDefinition[] = [
  {
    id: "disk-health-check",
    name: "Disk and backup health check",
    summary: "Produces a bounded placeholder health report without touching the host.",
    requiresApproval: false,
    integration: "placeholder",
    privilegedHelperRequested: false
  },
  {
    id: "nextcloud-update-plan",
    name: "Nextcloud update plan",
    summary: "Captures an approval-gated update checklist while leaving privileged execution for later integration.",
    requiresApproval: true,
    integration: "placeholder",
    privilegedHelperRequested: true
  },
  {
    id: "service-restart-request",
    name: "Service restart request",
    summary: "Queues a reviewed restart placeholder instead of calling system service managers directly.",
    requiresApproval: true,
    integration: "placeholder",
    privilegedHelperRequested: true
  }
];

export const AGENTS: AgentManifest[] = [
  {
    id: "demo-context-agent",
    name: "Demo context agent",
    description:
      "Launches a harmless repo-local demo process in a dedicated tmux window when tmux is available.",
    requiresApproval: false,
    privilegedHelperRequested: false,
    integration: "demo-local"
  }
];

export function findRunbook(runbookId: string): RunbookDefinition | undefined {
  return RUNBOOKS.find((runbook) => runbook.id === runbookId);
}

export function findAgent(agentId: string): AgentManifest | undefined {
  return AGENTS.find((agent) => agent.id === agentId);
}

export function buildAgentCommand(repoRoot: string, prompt: string): { executable: string; args: string[]; cwd: string } {
  return {
    executable: "node",
    args: [path.resolve(repoRoot, "apps/api/runtime/demo-agent.mjs"), "--prompt", prompt],
    cwd: repoRoot
  };
}


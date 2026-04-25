import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentManifest,
  ExecutionCheckpointDefinition,
  RunbookDefinition,
  ScriptDefinition
} from "@wireguard-ops-cockpit/domain";
import type { CommandSpec } from "@wireguard-ops-cockpit/tmux-adapter";

export interface AgentRuntimeOptions {
  plannerRuntime: "copilot-cli" | "demo-local";
  copilotExecutable: string;
  copilotModel: string | null;
}

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

export const SCRIPTS: ScriptDefinition[] = [
  {
    id: "script-disk-health-check",
    name: "Disk health helper",
    summary: "Collects disk, filesystem, and backup visibility inside the task tmux session.",
    integration: "host-tmux",
    privilegedHelperRequested: false,
    reviewStatus: "allowlisted",
    sourcePath: "bin/disk-health-check.sh"
  },
  {
    id: "script-nextcloud-update-plan",
    name: "Nextcloud preflight helper",
    summary: "Builds a bounded Nextcloud maintenance context and opens a reviewed maintenance operation before any mutation can continue.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-update-plan.sh"
  },
  {
    id: "script-nextcloud-enable-maintenance",
    name: "Nextcloud maintenance-mode enable helper",
    summary: "Enables Nextcloud maintenance mode through a bounded occ helper.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-enable-maintenance.sh"
  },
  {
    id: "script-nextcloud-occ-upgrade",
    name: "Nextcloud occ upgrade helper",
    summary: "Runs the bounded occ upgrade step for the active Nextcloud maintenance flow.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-occ-upgrade.sh"
  },
  {
    id: "script-nextcloud-disable-maintenance",
    name: "Nextcloud maintenance-mode disable helper",
    summary: "Disables Nextcloud maintenance mode after a reviewed upgrade phase completes.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-disable-maintenance.sh"
  },
  {
    id: "script-nextcloud-post-update-verify",
    name: "Nextcloud post-update verification helper",
    summary: "Verifies Nextcloud and service status after maintenance mode has been cleared.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-post-update-verify.sh"
  },
  {
    id: "script-nextcloud-rollback-restore",
    name: "Nextcloud rollback restore helper",
    summary: "Restores the reviewed Nextcloud rollback backup set through a fixed manifest under the bounded backup root.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-rollback-restore.sh"
  },
  {
    id: "script-nextcloud-rollback-verify",
    name: "Nextcloud rollback verification helper",
    summary: "Verifies the restored Nextcloud rollback state while the service remains in a controlled maintenance window.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/nextcloud-rollback-verify.sh"
  },
  {
    id: "script-service-restart",
    name: "Web stack restart helper",
    summary: "Restarts the approved Nextcloud web services through a bounded helper path that shares the maintenance lock.",
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    sourcePath: "bin/restart-nextcloud-web-stack.sh"
  }
];

export const RUNBOOKS: RunbookDefinition[] = [
  {
    id: "disk-health-check",
    name: "Disk and backup health check",
    summary: "Runs a real host-side disk and filesystem check inside the selected tmux session.",
    requiresSession: true,
    requiresApproval: false,
    integration: "host-tmux",
    privilegedHelperRequested: false,
    reviewStatus: "allowlisted",
    scriptIds: ["script-disk-health-check"],
    workflowSteps: [
      {
        id: "collect-bounded-diagnostics",
        label: "Collect bounded diagnostics",
        description: "Run the allowlisted disk and backup visibility helper inside the selected task session.",
        kind: "runbook",
        runbookId: "disk-health-check"
      },
      {
        id: "review-diagnostic-output",
        label: "Review diagnostic output",
        description: "Operator reviews filesystem pressure, backup visibility, and whether a broader repair path is needed.",
        kind: "operator-checkpoint"
      },
      {
        id: "choose-follow-up",
        label: "Choose the next bounded follow-up",
        description: "Escalate only to another reviewed runbook or a supervised session checkpoint if the diagnostics show broader impact.",
        kind: "verify"
      }
    ]
  },
  {
    id: "nextcloud-update-plan",
    name: "Nextcloud update preflight",
    summary: "Runs a bounded host-side Nextcloud inspection and stages the reviewed multi-runbook maintenance flow in the tmux session.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-update-plan"],
    workflowSteps: [
      {
        id: "collect-maintenance-context",
        label: "Collect maintenance context",
        description: "Run the bounded Nextcloud inspection helper to capture app compatibility, maintenance mode, and likely upgrade blockers.",
        kind: "runbook",
        runbookId: "nextcloud-update-plan"
      },
      {
        id: "review-upgrade-findings",
        label: "Review upgrade findings",
        description: "Operator reviews the inspection output, rollback readiness, and whether the update still fits the reviewed path.",
        kind: "operator-checkpoint"
      },
      {
        id: "supervised-repair-checkpoint",
        label: "Run supervised repair checkpoint",
        description: "Launch the supervised repair agent in the same task session if the findings need staged remediation guidance before the next bounded action.",
        kind: "agent",
        agentId: "supervised-repair-agent",
        approvalHint: "The supervised repair agent needs explicit operator approval before it starts."
      },
      {
        id: "enable-maintenance-mode",
        label: "Enable maintenance mode",
        description: "Move into a bounded maintenance window only after the operator accepts the reviewed preflight state.",
        kind: "runbook",
        runbookId: "nextcloud-enable-maintenance"
      },
      {
        id: "run-occ-upgrade",
        label: "Run occ upgrade",
        description: "Dispatch the bounded upgrade helper instead of combining maintenance mode and migration steps into one larger shell path.",
        kind: "runbook",
        runbookId: "nextcloud-occ-upgrade"
      },
      {
        id: "disable-maintenance-mode",
        label: "Disable maintenance mode",
        description: "Clear maintenance mode only after the bounded upgrade helper completed successfully.",
        kind: "runbook",
        runbookId: "nextcloud-disable-maintenance"
      },
      {
        id: "verify-post-update-state",
        label: "Verify post-update state",
        description: "Run the bounded verification helper to confirm Nextcloud and the web stack recovered cleanly.",
        kind: "runbook",
        runbookId: "nextcloud-post-update-verify"
      },
      {
        id: "optional-reviewed-restart",
        label: "Optional reviewed restart",
        description: "If the verification helper still shows a service mismatch, use the reviewed restart helper instead of free-form shell repair.",
        kind: "runbook",
        runbookId: "service-restart-request"
      },
      {
        id: "optional-reviewed-rollback",
        label: "Optional reviewed rollback",
        description: "If the reviewed maintenance path still fails, dispatch the bounded rollback restore helper instead of improvised recovery.",
        kind: "runbook",
        runbookId: "nextcloud-rollback-restore"
      }
    ]
  },
  {
    id: "nextcloud-enable-maintenance",
    name: "Nextcloud maintenance mode on",
    summary: "Enables Nextcloud maintenance mode through a bounded occ helper in the selected tmux session.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-enable-maintenance"],
    workflowSteps: [
      {
        id: "confirm-maintenance-window",
        label: "Confirm maintenance window",
        description: "Operator confirms the preflight findings still justify entering maintenance mode.",
        kind: "approval",
        approvalHint: "Maintenance mode changes stay behind explicit approval."
      },
      {
        id: "run-maintenance-on-helper",
        label: "Enable maintenance mode",
        description: "Dispatch the bounded helper that flips the Nextcloud maintenance flag for the active flow.",
        kind: "runbook",
        runbookId: "nextcloud-enable-maintenance"
      },
      {
        id: "verify-maintenance-flag",
        label: "Verify maintenance flag",
        description: "Check that maintenance mode is active before continuing to the upgrade step.",
        kind: "verify"
      }
    ]
  },
  {
    id: "nextcloud-occ-upgrade",
    name: "Nextcloud occ upgrade",
    summary: "Runs the bounded occ upgrade step for the active Nextcloud maintenance flow.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-occ-upgrade"],
    workflowSteps: [
      {
        id: "confirm-upgrade-scope",
        label: "Confirm upgrade scope",
        description: "Operator confirms the active maintenance flow is in the expected phase before the upgrade runs.",
        kind: "approval",
        approvalHint: "The occ upgrade step stays behind explicit approval."
      },
      {
        id: "run-occ-upgrade-helper",
        label: "Run occ upgrade helper",
        description: "Dispatch the bounded helper that performs the occ upgrade for the current Nextcloud flow.",
        kind: "runbook",
        runbookId: "nextcloud-occ-upgrade"
      },
      {
        id: "review-upgrade-status",
        label: "Review upgrade status",
        description: "Check the reported Nextcloud status before leaving maintenance mode.",
        kind: "verify"
      }
    ]
  },
  {
    id: "nextcloud-disable-maintenance",
    name: "Nextcloud maintenance mode off",
    summary: "Disables Nextcloud maintenance mode after the reviewed upgrade phase completed successfully.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-disable-maintenance"],
    workflowSteps: [
      {
        id: "confirm-maintenance-exit",
        label: "Confirm maintenance exit",
        description: "Operator confirms the bounded upgrade step completed and rollback notes are captured.",
        kind: "approval",
        approvalHint: "Leaving maintenance mode stays behind explicit approval."
      },
      {
        id: "run-maintenance-off-helper",
        label: "Disable maintenance mode",
        description: "Dispatch the bounded helper that clears the Nextcloud maintenance flag for the active flow.",
        kind: "runbook",
        runbookId: "nextcloud-disable-maintenance"
      },
      {
        id: "verify-maintenance-cleared",
        label: "Verify maintenance mode is cleared",
        description: "Check that Nextcloud is ready for post-update verification before the session continues.",
        kind: "verify"
      }
    ]
  },
  {
    id: "nextcloud-post-update-verify",
    name: "Nextcloud post-update verification",
    summary: "Runs a bounded post-update verification helper for the active Nextcloud maintenance flow.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-post-update-verify"],
    workflowSteps: [
      {
        id: "collect-post-update-status",
        label: "Collect post-update status",
        description: "Dispatch the bounded helper that checks Nextcloud status and the web services after maintenance mode is cleared.",
        kind: "runbook",
        runbookId: "nextcloud-post-update-verify"
      },
      {
        id: "restart-if-verification-fails",
        label: "Restart reviewed web stack if needed",
        description: "Only if verification still shows divergence, dispatch the reviewed restart helper instead of improvising in the shell.",
        kind: "runbook",
        runbookId: "service-restart-request"
      },
      {
        id: "rollback-if-verification-fails",
        label: "Rollback with reviewed backup set if needed",
        description: "If post-update verification still fails, dispatch the bounded rollback restore helper tied to the approved rollback manifest.",
        kind: "runbook",
        runbookId: "nextcloud-rollback-restore"
      },
      {
        id: "close-maintenance-flow",
        label: "Close maintenance flow",
        description: "Review the verification output and close the bounded maintenance flow only if the service state matches expectations.",
        kind: "verify"
      }
    ]
  },
  {
    id: "nextcloud-rollback-restore",
    name: "Nextcloud rollback restore",
    summary: "Restores the approved Nextcloud rollback backup set through a fixed manifest under the bounded backup root.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-rollback-restore"],
    workflowSteps: [
      {
        id: "confirm-reviewed-rollback-scope",
        label: "Confirm reviewed rollback scope",
        description: "Operator confirms the rollback still matches the approved backup set and declared restore scope before any restore begins.",
        kind: "approval",
        approvalHint: "Rollback restore stays behind explicit approval and a reviewed manifest."
      },
      {
        id: "run-rollback-restore-helper",
        label: "Run rollback restore helper",
        description: "Dispatch the bounded restore helper that reads only the approved rollback manifest under the fixed backup root.",
        kind: "runbook",
        runbookId: "nextcloud-rollback-restore"
      },
      {
        id: "verify-rollback-state",
        label: "Verify rollback state",
        description: "Run the dedicated rollback verification helper before leaving the maintenance window.",
        kind: "runbook",
        runbookId: "nextcloud-rollback-verify"
      }
    ]
  },
  {
    id: "nextcloud-rollback-verify",
    name: "Nextcloud rollback verification",
    summary: "Verifies the restored Nextcloud rollback state while the service remains in a controlled maintenance window.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-nextcloud-rollback-verify"],
    workflowSteps: [
      {
        id: "collect-rollback-verification-state",
        label: "Collect rollback verification state",
        description: "Dispatch the bounded helper that checks manifest markers, maintenance mode, and service health after restore.",
        kind: "runbook",
        runbookId: "nextcloud-rollback-verify"
      },
      {
        id: "close-rollback-window",
        label: "Close rollback window",
        description: "Review the restore result and only continue with maintenance-mode exit once the rollback verification succeeds.",
        kind: "verify"
      }
    ]
  },
  {
    id: "service-restart-request",
    name: "Nextcloud web stack restart",
    summary: "Restarts php8.3-fpm and apache2 through a bounded approved helper in the selected tmux session.",
    requiresSession: true,
    requiresApproval: true,
    integration: "host-tmux",
    privilegedHelperRequested: true,
    reviewStatus: "allowlisted",
    scriptIds: ["script-service-restart"],
    workflowSteps: [
      {
        id: "confirm-reviewed-scope",
        label: "Confirm reviewed scope",
        description: "Verify the restart still matches the reviewed target and only affects the approved Nextcloud web services.",
        kind: "approval",
        approvalHint: "Service restarts stay behind explicit approval."
      },
      {
        id: "run-bounded-restart",
        label: "Run bounded restart helper",
        description: "Dispatch the allowlisted restart helper for php8.3-fpm and apache2 in the selected session.",
        kind: "runbook",
        runbookId: "service-restart-request"
      },
      {
        id: "verify-service-health",
        label: "Verify service health",
        description: "Check that the restart restored the intended web service state before the session is closed.",
        kind: "verify"
      }
    ]
  }
];

function buildPlannerAgent(plannerRuntime: AgentRuntimeOptions["plannerRuntime"]): AgentManifest {
  return {
    id: "planner-agent",
    name: "Planner agent",
    description:
      plannerRuntime === "copilot-cli"
        ? "Runs GitHub Copilot CLI inside the task tmux session to propose a structured repair or maintenance plan before safety review, policy checks, approvals, and bounded execution continue."
        : "Produces a structured repair or maintenance plan in the task session before safety review, policy checks, approvals, and bounded execution continue.",
    requiresApproval: false,
    privilegedHelperRequested: false,
    integration: plannerRuntime === "copilot-cli" ? "copilot-cli" : "demo-local",
    supervisionMode: "none",
    executionAuthority: "advisory-only",
    promptContractId: "planner-v1",
    checkpointContractId: null,
    checkpointTemplate: []
  };
}

function buildSupervisedRepairCheckpointTemplate(): ExecutionCheckpointDefinition[] {
  return [
    {
      id: "checkpoint-review-scope",
      label: "Review current bounded scope",
      description: "Summarize the currently observed issue boundaries before any follow-up runbook is selected.",
      kind: "operator-checkpoint"
    },
    {
      id: "checkpoint-choose-follow-up",
      label: "Choose the next bounded follow-up",
      description: "Map the next action to an already reviewed runbook instead of free-form shell recovery.",
      kind: "runbook"
    },
    {
      id: "checkpoint-verify-outcome",
      label: "Verify outcome and rollback notes",
      description: "Confirm expected impact, rollback notes, and operator review state before the session moves on.",
      kind: "verify"
    }
  ];
}

function buildSupervisedRepairAgent(plannerRuntime: AgentRuntimeOptions["plannerRuntime"]): AgentManifest {
  return {
    id: "supervised-repair-agent",
    name: "Supervised repair agent",
    description:
      plannerRuntime === "copilot-cli"
        ? "Runs GitHub Copilot CLI in the task tmux session as an observed checkpoint actor that proposes staged remediation steps and pauses for operator review."
        : "Produces staged remediation checkpoints in the task session and pauses for operator review before any bounded follow-up continues.",
    requiresApproval: true,
    privilegedHelperRequested: false,
    integration: plannerRuntime === "copilot-cli" ? "copilot-cli" : "demo-local",
    supervisionMode: "session-observed",
    executionAuthority: "advisory-only",
    promptContractId: "supervised-repair-v1",
    checkpointContractId: "supervised-repair-checkpoints-v1",
    checkpointTemplate: buildSupervisedRepairCheckpointTemplate()
  };
}

export function listAgents(plannerRuntime: AgentRuntimeOptions["plannerRuntime"] = "copilot-cli"): AgentManifest[] {
  return [buildPlannerAgent(plannerRuntime), buildSupervisedRepairAgent(plannerRuntime)];
}

export function listScripts(): ScriptDefinition[] {
  return SCRIPTS;
}

export function computeRunbookVersionHash(runbook: RunbookDefinition): string {
  const linkedScripts = runbook.scriptIds
    .map((scriptId) => findScript(scriptId))
    .filter((script): script is ScriptDefinition => Boolean(script));

  return createHash("sha256")
    .update(
      JSON.stringify({
        runbook,
        scripts: linkedScripts
      })
    )
    .digest("hex");
}

export function computeAgentManifestDigest(agent: AgentManifest): string {
  return createHash("sha256").update(JSON.stringify(agent)).digest("hex");
}

export function findRunbook(runbookId: string): RunbookDefinition | undefined {
  return RUNBOOKS.find((runbook) => runbook.id === runbookId);
}

export function findScript(scriptId: string): ScriptDefinition | undefined {
  return SCRIPTS.find((script) => script.id === scriptId);
}

export function findAgent(
  agentId: string,
  plannerRuntime: AgentRuntimeOptions["plannerRuntime"] = "copilot-cli"
): AgentManifest | undefined {
  return listAgents(plannerRuntime).find((agent) => agent.id === agentId);
}

function buildPlannerPrompt(prompt: string): string {
  return [
    "You are the planner-agent for wireguard-ops-cockpit.",
    "Your job is to produce a repair or maintenance plan, not to execute commands or mutate the host.",
    "Do not ask for sudo, Docker, helper execution, approvals, or direct host changes.",
    "Keep the answer explicit and structured.",
    "Include these sections:",
    "1. Summary",
    "2. Proposed runbook",
    "3. Parameters",
    "4. Target scope",
    "5. Risk class",
    "6. Expected impact",
    "7. Rollback hint",
    "8. Operator checks",
    "Task:",
    prompt
  ].join("\n");
}

function buildSupervisedRepairPrompt(prompt: string): string {
  return [
    "You are the supervised-repair-agent for wireguard-ops-cockpit.",
    "You are running in the operator's tmux session as an observed checkpoint actor.",
    "Do not execute commands, do not mutate the host, and do not claim execution authority.",
    "Only propose staged remediation checkpoints that map back to reviewed runbooks or explicit operator review.",
    "After every checkpoint, require the operator to review before continuing.",
    "Keep the answer explicit and structured.",
    "Include these sections:",
    "1. Summary",
    "2. Current checkpoint",
    "3. Proposed next step",
    "4. Suggested bounded runbook",
    "5. Risk class",
    "6. Expected impact",
    "7. Operator review gate",
    "8. Rollback hint",
    "Task:",
    prompt
  ].join("\n");
}

function buildAgentPrompt(agent: AgentManifest, prompt: string): string {
  if (agent.promptContractId === "supervised-repair-v1") {
    return buildSupervisedRepairPrompt(prompt);
  }

  return buildPlannerPrompt(prompt);
}

export function buildAgentCommand(
  repoRoot: string,
  agent: AgentManifest,
  prompt: string,
  runtimeOptions: AgentRuntimeOptions = {
    plannerRuntime: "copilot-cli",
    copilotExecutable: "copilot",
    copilotModel: null
  }
): { executable: string; args: string[]; cwd: string } {
  if (runtimeOptions.plannerRuntime === "demo-local") {
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

  const agentPrompt = buildAgentPrompt(agent, prompt);
  const modelArgs = runtimeOptions.copilotModel ? [`--model ${shellQuote(runtimeOptions.copilotModel)}`] : [];
  const secretEnvVars = ["COCKPIT_ADMIN_PASSWORD", "COCKPIT_TERMINAL_SIGNING_SECRET"].join(",");
  const script = [
    "set -euo pipefail",
    'if [ "${GITHUB_TOKEN:-}" != "" ] && [[ "${GITHUB_TOKEN}" == ghp_* ]]; then unset GITHUB_TOKEN; fi',
    'if [ "${GH_TOKEN:-}" != "" ] && [[ "${GH_TOKEN}" == ghp_* ]]; then unset GH_TOKEN; fi',
    `planner_executable=${shellQuote(runtimeOptions.copilotExecutable)}`,
    'if ! command -v "$planner_executable" >/dev/null 2>&1 && [ ! -x "$planner_executable" ]; then',
    '  printf "Configured Copilot CLI runtime %s was not found.\\n" "$planner_executable"',
    "  exec bash",
    "fi",
    `"$planner_executable" --mode plan --no-auto-update --disable-builtin-mcps --disallow-temp-dir --no-custom-instructions --deny-tool=shell --deny-tool=write --add-dir ${shellQuote(repoRoot)} --secret-env-vars ${shellQuote(secretEnvVars)} ${modelArgs.join(" ")} -i ${shellQuote(agentPrompt)}`.trim(),
    'status=$?',
    'printf "\\nPlanner runtime exited with status %s.\\n" "$status"',
    "exec bash"
  ].join("; ");

  return {
    executable: "bash",
    args: ["-lc", script],
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
    "nextcloud-enable-maintenance": {
      windowName: "nextcloud-maint-on",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-enable-maintenance.sh"))}`
    },
    "nextcloud-occ-upgrade": {
      windowName: "nextcloud-upgrade",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-occ-upgrade.sh"))}`
    },
    "nextcloud-disable-maintenance": {
      windowName: "nextcloud-maint-off",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-disable-maintenance.sh"))}`
    },
    "nextcloud-post-update-verify": {
      windowName: "nextcloud-verify",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-post-update-verify.sh"))}`
    },
    "nextcloud-rollback-restore": {
      windowName: "nextcloud-rollback",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-rollback-restore.sh"))}`
    },
    "nextcloud-rollback-verify": {
      windowName: "nextcloud-rollback-verify",
      commandLine: `sudo -n ${shellQuote(path.resolve(repoRoot, "bin/nextcloud-rollback-verify.sh"))}`
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

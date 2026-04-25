import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentCommand,
  computeAgentManifestDigest,
  buildRunbookDispatch,
  findAgent,
  findRunbook,
  listAgents,
  listScripts
} from "../src/registries.js";

describe("registries", () => {
  it("finds known runbooks and agents", () => {
    expect(findRunbook("disk-health-check")).toMatchObject({
      id: "disk-health-check",
      requiresApproval: false,
      scriptIds: ["script-disk-health-check"]
    });
    expect(findRunbook("nextcloud-enable-maintenance")).toMatchObject({
      id: "nextcloud-enable-maintenance",
      requiresApproval: true,
      scriptIds: ["script-nextcloud-enable-maintenance"]
    });
    expect(findRunbook("nextcloud-occ-upgrade")).toMatchObject({
      id: "nextcloud-occ-upgrade",
      requiresApproval: true,
      scriptIds: ["script-nextcloud-occ-upgrade"]
    });
    expect(findRunbook("nextcloud-disable-maintenance")).toMatchObject({
      id: "nextcloud-disable-maintenance",
      requiresApproval: true,
      scriptIds: ["script-nextcloud-disable-maintenance"]
    });
    expect(findRunbook("nextcloud-post-update-verify")).toMatchObject({
      id: "nextcloud-post-update-verify",
      requiresApproval: true,
      scriptIds: ["script-nextcloud-post-update-verify"]
    });
    expect(findRunbook("nextcloud-rollback-restore")).toMatchObject({
      id: "nextcloud-rollback-restore",
      requiresApproval: true,
      scriptIds: ["script-nextcloud-rollback-restore"]
    });
    expect(findRunbook("nextcloud-rollback-verify")).toMatchObject({
      id: "nextcloud-rollback-verify",
      requiresApproval: true,
      scriptIds: ["script-nextcloud-rollback-verify"]
    });
    expect(findRunbook("missing-runbook")).toBeUndefined();

    expect(findAgent("planner-agent")).toMatchObject({
      id: "planner-agent",
      integration: "copilot-cli",
      supervisionMode: "none"
    });
    expect(findAgent("supervised-repair-agent")).toMatchObject({
      id: "supervised-repair-agent",
      integration: "copilot-cli",
      requiresApproval: true,
      supervisionMode: "session-observed"
    });
    expect(findAgent("safety-agent")).toBeUndefined();
    expect(findAgent("squad")).toBeUndefined();
    expect(findAgent("missing-agent")).toBeUndefined();
  });

  it("lists reviewable script definitions", () => {
    expect(listScripts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "script-disk-health-check",
          reviewStatus: "allowlisted",
          sourcePath: "bin/disk-health-check.sh"
        }),
        expect.objectContaining({
          id: "script-nextcloud-rollback-restore",
          reviewStatus: "allowlisted",
          sourcePath: "bin/nextcloud-rollback-restore.sh"
        })
      ])
    );
  });

  it("lists the public planner and supervised repair agents", () => {
    const agents = listAgents();
    expect(agents).toHaveLength(2);
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "planner-agent", integration: "copilot-cli" }),
        expect.objectContaining({
          id: "supervised-repair-agent",
          supervisionMode: "session-observed",
          promptContractId: "supervised-repair-v1",
          checkpointContractId: "supervised-repair-checkpoints-v1"
        })
      ])
    );
  });

  it("computes a stable digest for the reviewed agent manifest", () => {
    const agent = findAgent("supervised-repair-agent");
    expect(agent).toBeDefined();
    expect(computeAgentManifestDigest(agent!)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeAgentManifestDigest(agent!)).toBe(computeAgentManifestDigest(agent!));
  });

  it("builds a bounded Copilot CLI planner command", () => {
    const command = buildAgentCommand(
      "/workspace/repo",
      {
        id: "planner-agent",
        name: "Planner agent",
        description: "Produces a structured plan.",
        requiresApproval: false,
        privilegedHelperRequested: false,
        integration: "copilot-cli",
        supervisionMode: "none",
        executionAuthority: "advisory-only",
        promptContractId: "planner-v1"
      },
      "summarize current context",
      {
        plannerRuntime: "copilot-cli",
        copilotExecutable: "copilot",
        copilotModel: "gpt-5.4"
      }
    );

    expect(command.executable).toBe("bash");
    expect(command.cwd).toBe("/workspace/repo");
    expect(command.args[0]).toBe("-lc");
    expect(command.args[1]).toContain('planner_executable=\'copilot\'');
    expect(command.args[1]).toContain("--mode plan");
    expect(command.args[1]).toContain("--disable-builtin-mcps");
    expect(command.args[1]).toContain("--deny-tool=shell");
    expect(command.args[1]).toContain("--deny-tool=write");
    expect(command.args[1]).toContain("--model 'gpt-5.4'");
    expect(command.args[1]).toContain("Task:");
    expect(command.args[1]).toContain("summarize current context");
  });

  it("builds a supervised repair prompt contract for the observed session agent", () => {
    const command = buildAgentCommand(
      "/workspace/repo",
      {
        id: "supervised-repair-agent",
        name: "Supervised repair agent",
        description: "Produces staged remediation checkpoints.",
        requiresApproval: true,
        privilegedHelperRequested: false,
        integration: "copilot-cli",
        supervisionMode: "session-observed",
        executionAuthority: "advisory-only",
        promptContractId: "supervised-repair-v1"
      },
      "Review the current Nextcloud upgrade blockers.",
      {
        plannerRuntime: "copilot-cli",
        copilotExecutable: "copilot",
        copilotModel: null
      }
    );

    expect(command.executable).toBe("bash");
    expect(command.args[1]).toContain("You are the supervised-repair-agent");
    expect(command.args[1]).toContain("After every checkpoint, require the operator to review before continuing.");
    expect(command.args[1]).toContain("Review the current Nextcloud upgrade blockers.");
  });

  it("keeps the demo launcher available as an explicit fallback", () => {
    const command = buildAgentCommand(
      "/workspace/repo",
      {
        id: "planner-agent",
        name: "Planner agent",
        description: "Produces a structured plan.",
        requiresApproval: false,
        privilegedHelperRequested: false,
        integration: "demo-local",
        supervisionMode: "none",
        executionAuthority: "advisory-only",
        promptContractId: "planner-v1"
      },
      "summarize current context",
      {
        plannerRuntime: "demo-local",
        copilotExecutable: "copilot",
        copilotModel: null
      }
    );

    expect(command.executable).toBe("node");
    expect(command.args).toEqual([
      path.resolve("/workspace/repo", "apps/api/runtime/demo-agent.mjs"),
      "--agent-id",
      "planner-agent",
      "--agent-name",
      "Planner agent",
      "--integration",
      "demo-local",
      "--prompt",
      "summarize current context"
    ]);
  });

  it("registers bounded dispatch commands for the split Nextcloud phase and rollback runbooks", () => {
    const upgradeDispatch = buildRunbookDispatch("/workspace/repo", findRunbook("nextcloud-occ-upgrade")!);
    const rollbackDispatch = buildRunbookDispatch("/workspace/repo", findRunbook("nextcloud-rollback-restore")!);

    expect(upgradeDispatch.windowName).toBe("nextcloud-upgrade");
    expect(upgradeDispatch.command.executable).toBe("bash");
    expect(upgradeDispatch.command.args[1]).toContain("nextcloud-occ-upgrade.sh");
    expect(rollbackDispatch.windowName).toBe("nextcloud-rollback");
    expect(rollbackDispatch.command.executable).toBe("bash");
    expect(rollbackDispatch.command.args[1]).toContain("nextcloud-rollback-restore.sh");
  });
});

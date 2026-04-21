import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentCommand, findAgent, findRunbook, listAgents, listScripts } from "../src/registries.js";

describe("registries", () => {
  it("finds known runbooks and agents", () => {
    expect(findRunbook("disk-health-check")).toMatchObject({
      id: "disk-health-check",
      requiresApproval: false,
      scriptIds: ["script-disk-health-check"]
    });
    expect(findRunbook("missing-runbook")).toBeUndefined();

    expect(findAgent("planner-agent")).toMatchObject({
      id: "planner-agent",
      integration: "control-plane"
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
        })
      ])
    );
  });

  it("lists only the public runtime planner agent", () => {
    const agents = listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "planner-agent",
      integration: "control-plane"
    });
  });

  it("builds a bounded local planner command", () => {
    const command = buildAgentCommand(
      "/workspace/repo",
      {
        id: "planner-agent",
        name: "Planner agent",
        description: "Produces a structured plan.",
        requiresApproval: false,
        privilegedHelperRequested: false,
        integration: "control-plane"
      },
      "summarize current context"
    );

    expect(command.executable).toBe("node");
    expect(command.cwd).toBe("/workspace/repo");
    expect(command.args).toEqual([
      path.resolve("/workspace/repo", "apps/api/runtime/demo-agent.mjs"),
      "--agent-id",
      "planner-agent",
      "--agent-name",
      "Planner agent",
      "--integration",
      "control-plane",
      "--prompt",
      "summarize current context"
    ]);
  });
});

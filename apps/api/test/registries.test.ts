import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentCommand, findAgent, findRunbook } from "../src/registries.js";

describe("registries", () => {
  it("finds known runbooks and agents", () => {
    expect(findRunbook("disk-health-check")).toMatchObject({
      id: "disk-health-check",
      requiresApproval: false
    });
    expect(findRunbook("missing-runbook")).toBeUndefined();

    expect(findAgent("demo-context-agent")).toMatchObject({
      id: "demo-context-agent",
      integration: "demo-local"
    });
    expect(findAgent("missing-agent")).toBeUndefined();
  });

  it("builds a repo-local demo agent command", () => {
    const command = buildAgentCommand("/workspace/repo", "summarize current context");

    expect(command).toEqual({
      executable: "node",
      args: [
        path.resolve("/workspace/repo", "apps/api/runtime/demo-agent.mjs"),
        "--prompt",
        "summarize current context"
      ],
      cwd: "/workspace/repo"
    });
  });
});
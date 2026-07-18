import { describe, expect, it } from "vitest";
import { evaluatePlanPolicy } from "../src/app.js";

function plan(zone: string, rollback: string, script = "/usr/bin/true") {
  return [
    "## Required Permissions", "/usr/bin/true", "", "```bash", script, "```",
    "## Intent", "test the change", "## Targets", "/opt/example",
    "## Risk Zone", zone, "## Prerequisites", "target exists",
    "## Rollback", rollback, "## Verification", "run health check",
  ].join("\n");
}

describe("Hermes plan policy", () => {
  it("allows green plans after safety review", () => {
    expect(evaluatePlanPolicy(plan("green", "none"), "passed")).toMatchObject({ allowed: true, zone: "green" });
  });

  it("allows reversible yellow plans", () => {
    expect(evaluatePlanPolicy(plan("yellow", "restore the previous file"), "approval_required")).toMatchObject({
      allowed: true, zone: "yellow", rollbackAvailable: true,
    });
  });

  it("blocks yellow plans without rollback as a prerequisite", () => {
    expect(evaluatePlanPolicy(plan("yellow", "none"), "passed")).toMatchObject({
      allowed: false, status: "blocked_prerequisite",
    });
  });

  it("requires operator approval at hard boundaries", () => {
    expect(evaluatePlanPolicy(plan("green", "restore", "rm -rf /etc/example"), "passed")).toMatchObject({
      allowed: false, zone: "red", status: "blocked_user_approval",
    });
  });
});

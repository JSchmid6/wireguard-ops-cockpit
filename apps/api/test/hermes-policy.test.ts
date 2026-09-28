import { describe, expect, it } from "vitest";
import { evaluatePlanPolicy } from "../src/app.js";
import { parseCapabilityManifest } from "../src/capability-manifest.js";

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

  it("allows read-only evidence checks for public bind addresses", () => {
    expect(evaluatePlanPolicy(plan("green", "none", "/usr/bin/ss -ltn | /usr/bin/grep '0.0.0.0'"), "passed")).toMatchObject({
      allowed: true, zone: "green", status: "ready",
    });
  });

  it("gates a borg repair in another fence language or a later code block", () => {
    const repair = "/usr/local/sbin/cockpit-borg-action repair";
    // The typed script of these plans is harmless (first bash fence); the repair
    // line would otherwise only meet the runner, which holds the whole plan.
    const fences = [
      ["```bash", "/usr/bin/true", "```", "```shell", repair, "```"].join("\n"),
      ["```bash", "/usr/bin/true", "```", "```sh", repair, "```"].join("\n"),
      ["```bash", "/usr/bin/true", "```", "prose", "```bash", repair, "```"].join("\n"),
    ];
    for (const text of fences) {
      expect(evaluatePlanPolicy(text, "passed")).toMatchObject({
        allowed: false, zone: "red", status: "blocked_user_approval", evidence: ["typed action: borg.repair"],
      });
    }
  });

  it("leaves the read-only borg forms to the normal policy", () => {
    for (const verb of ["status", "check"]) {
      expect(evaluatePlanPolicy(["```bash", `/usr/local/sbin/cockpit-borg-action ${verb}`, "```"].join("\n"), "passed"))
        .toMatchObject({ allowed: true, status: "ready" });
    }
  });

  it("gates a borg repair when the plan also carries a capability manifest", () => {
    const manifest = [
      "```capability",
      JSON.stringify({
        version: "cockpit-capability/v1", name: "adapt tool", purpose: "Apply a reversible config change",
        steps: [{ argv: ["/usr/bin/tool", "--current-flag"], cwd: "/tmp", runAsUser: "www-data" }],
        readablePaths: ["/var/tmp/cockpit-read"], writablePaths: ["/tmp/example.conf"], network: "none",
        expectedEffects: ["configuration updated"], verification: ["tool reports target state"],
        rollback: ["restore snapshot"], risk: ["contained"],
      }),
      "```",
    ].join("\n");
    const withoutRepair = `${plan("green", "restore the previous file", "/usr/bin/true")}\n\n${manifest}`;
    // The plan is a manifest stand: without the repair line it passes the policy.
    expect(parseCapabilityManifest(withoutRepair)).not.toBeNull();
    expect(evaluatePlanPolicy(withoutRepair, "passed")).toMatchObject({ allowed: true, status: "ready" });
    // With one, the plan stops for the operator — a manifest never switches the gate off.
    const withRepair = `${plan("green", "restore the previous file", "/usr/local/sbin/cockpit-borg-action repair")}\n\n${manifest}`;
    expect(parseCapabilityManifest(withRepair)).not.toBeNull();
    expect(evaluatePlanPolicy(withRepair, "passed")).toMatchObject({
      allowed: false, zone: "red", status: "blocked_user_approval", evidence: ["typed action: borg.repair"],
    });
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilityPlannerContract } from "../src/capability-manifest.js";
import { evaluatePlanPolicy } from "../src/app.js";

function plan(script: string): string {
  return `## Intent\nTest\n\n## Risk Zone\ngreen\n\n## Rollback\nnone needed\n\n\`\`\`bash\n${script}\n\`\`\`\n`;
}

describe("machine snapshots through the hoster (vps provider)", () => {
  it("tells the planner about the helper and its asymmetry", () => {
    // The planner learns the fixed helper from the contract, not by guessing
    // an endpoint. And it learns that a revert is never autonomous.
    const contract = capabilityPlannerContract();
    expect(contract).toContain("/usr/local/lib/wireguard-ops-cockpit/cockpit-vps-snapshot");
    expect(contract).toMatch(/revert <snapshotId> always require operator approval/);
    expect(contract).toMatch(/never exposes the hoster credentials/);
  });

  it("keeps the cockpit's own secret directory out of the agent's reach by structure", () => {
    // The hoster token can roll the whole machine back. No text filter on the
    // plan guards it any more (card t_abe2651b): the agent unit cannot see the
    // directory at all, and capability manifests treat it as a hard boundary.
    const unit = readFileSync(new URL("../../../deploy/systemd/wireguard-ops-cockpit-agent.service", import.meta.url), "utf8");
    expect(unit).toMatch(/^InaccessiblePaths=-\/etc\/wireguard-ops-cockpit$/m);
  });

  it("does not block the helper itself", () => {
    // The helper reads the file; a plan invoking the helper does not name it.
    const result = evaluatePlanPolicy(plan("/usr/bin/python3 /usr/local/lib/wireguard-ops-cockpit/cockpit-vps-snapshot status"), "passed");
    expect(result.allowed).toBe(true);
  });
});

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

  it("treats the cockpit's own secret directory as a hard boundary", () => {
    // The hoster token can roll the whole machine back. A plan that reads or
    // writes it crosses the same line as one touching the agent's credentials.
    for (const script of [
      "cat /etc/wireguard-ops-cockpit/contabo.env",
      "echo CONTABO_API_PASSWORD=x >> /etc/wireguard-ops-cockpit/contabo.env",
      "F=/etc/wireguard-ops-cockpit/api.env; cp $F /tmp/",
    ]) {
      const result = evaluatePlanPolicy(plan(script), "passed");
      expect(result.allowed).toBe(false);
      expect(result.status).toBe("blocked_user_approval");
      expect(result.evidence).toContain("cockpit secrets (execution authority, hoster API)");
    }
  });

  it("does not block the helper itself", () => {
    // The helper reads the file; a plan invoking the helper does not name it.
    const result = evaluatePlanPolicy(plan("/usr/bin/python3 /usr/local/lib/wireguard-ops-cockpit/cockpit-vps-snapshot status"), "passed");
    expect(result.allowed).toBe(true);
  });
});

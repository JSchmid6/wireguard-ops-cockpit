import { describe, expect, it } from "vitest";
import { capabilityNeedsOperatorApproval, capabilityPlannerContract } from "../src/capability-manifest.js";

const base = { version: "cockpit-capability/v1", name: "wp", steps: [], readablePaths: [], writablePaths: [] };

describe("WordPress updates can run autonomously once the tool owns the rollback", () => {
  it("still demands approval when a plan declares data_loss itself", () => {
    // This is what blocked the 18.08. WordPress job: safety passed, zone green,
    // but the manifest's own declaration escalated it. The rule stays.
    expect(capabilityNeedsOperatorApproval({ ...base, network: "outbound", risk: ["contained", "data_loss"] } as never)).toBe(true);
  });

  it("lets a contained capability through", () => {
    // The helper backs up, verifies and restores on failure, so `contained` is
    // the truthful declaration — not a weakened rule.
    expect(capabilityNeedsOperatorApproval({ ...base, network: "outbound", risk: ["contained"] } as never)).toBe(false);
  });

  it("keeps host networking and secret access gated regardless", () => {
    expect(capabilityNeedsOperatorApproval({ ...base, network: "host", risk: ["contained"] } as never)).toBe(true);
    expect(capabilityNeedsOperatorApproval({ ...base, network: "none", risk: ["identity_or_secret"] } as never)).toBe(true);
  });

  it("tells the planner about the helper instead of letting it invent one", () => {
    const contract = capabilityPlannerContract();
    expect(contract).toContain("/usr/local/sbin/cockpit-wordpress-update");
    expect(contract).toContain("empty readablePaths/writablePaths");
  });
});

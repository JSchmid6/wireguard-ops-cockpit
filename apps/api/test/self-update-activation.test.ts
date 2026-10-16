import { describe, expect, it } from "vitest";

import { activationAction, activationReason, pendingSelfUpdateActivations, selfUpdateVerifierNote } from "../src/self-update-activation.js";

// The typed executor result of VPS job b3833e76 (16.10.2026), shortened: the
// deploy was verified, the activation scheduled for +600 s.
const SHA = "0239df46276a3fa52410ec42e53b02128044da48";
const UNIT = "wireguard-ops-cockpit-self-update-activate-0239df4-1792171491";

function helperOutput(patch: Record<string, unknown> = {}, activation: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "self.update", ok: true, result: "ok", phase: "awaiting-activation", sha: SHA,
    activation: { delay_seconds: 600, scheduled_at: "2026-10-16T17:24:51Z", status: "scheduled", unit: UNIT, ...activation },
    verification: { api_health: "ok", revision: "ok", services: "ok" },
    ...patch,
  });
}

function typedResult(output: string, status = "success") {
  return `## EXECUTION RESULT\nSTATUS: ${status}\nEXIT_CODE: 0\nWHAT_RAN: typed executor actions: self.update ${SHA}\nOUTPUT: ${output}\nNOTES: executed by isolated capability broker`;
}

describe("self.update: verified deploy with a pending activation", () => {
  it("recognizes a scheduled activation in the typed executor result and tells the verifier the target state", () => {
    const pending = pendingSelfUpdateActivations(typedResult(helperOutput()));
    expect(pending).toEqual([{ sha: SHA, unit: UNIT, dueAt: "2026-10-16T17:34:51.000Z" }]);
    const note = selfUpdateVerifierNote(pending);
    expect(note).toContain(SHA);
    expect(note).toContain(UNIT);
    expect(note).toContain("NOT a reason to fail");
    expect(note).toContain("Fail when the installation is not at the commit");
    expect(activationReason(pending)).toContain("0239df46276a at 2026-10-16T17:34:51.000Z");
    expect(activationAction(pending)).toContain("after 2026-10-16T17:34:51.000Z");
  });

  it("gives no relief for anything but a verified deploy with a scheduled activation", () => {
    const refused = [
      typedResult(helperOutput(), "failed"),
      typedResult(helperOutput({ ok: false })),
      typedResult(helperOutput({ result: "failed" })),
      typedResult(helperOutput({ phase: "deploy" })),
      typedResult(helperOutput({ action: "dienste.update" })),
      typedResult(helperOutput({ sha: "0239df4" })),
      typedResult(helperOutput({}, { status: "failed" })),
      typedResult(helperOutput({}, { unit: "evil; rm -rf /" })),
      typedResult(helperOutput({}, { scheduled_at: "soon" })),
      typedResult("{not json"),
      typedResult(helperOutput({ activation: null })),
      "",
    ];
    for (const result of refused) expect(pendingSelfUpdateActivations(result)).toEqual([]);
    // Never from a runner's free text: no typed result, no relief.
    expect(pendingSelfUpdateActivations(null)).toEqual([]);
    expect(selfUpdateVerifierNote([])).toBe("");
    expect(activationReason([])).toBe("");
    expect(activationAction([])).toBe("No further action is required.");
  });
});

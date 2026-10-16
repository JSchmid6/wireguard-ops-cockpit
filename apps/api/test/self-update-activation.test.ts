import { describe, expect, it } from "vitest";

import {
  activationAction,
  activationReason,
  capabilityExecution,
  hostRunExecution,
  selfUpdateActivation,
  selfUpdateVerifierNote,
  typedActionsExecution,
} from "../src/self-update-activation.js";

// The typed executor result of VPS job b3833e76 (16.10.2026), shortened: the
// deploy was verified, the activation scheduled for +600 s.
const SHA = "0239df46276a3fa52410ec42e53b02128044da48";
const OTHER_SHA = "ce91f03846e62d350959002e2fcf2dec6912a22b";
const UNIT = "wireguard-ops-cockpit-self-update-activate-0239df4-1792171491";

function helperOutput(patch: Record<string, unknown> = {}, activation: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "self.update", ok: true, result: "ok", phase: "awaiting-activation", sha: SHA,
    activation: { delay_seconds: 600, scheduled_at: "2026-10-16T17:24:51Z", status: "scheduled", unit: UNIT, ...activation },
    verification: { api_health: "ok", revision: "ok", services: "ok" },
    ...patch,
  });
}

const selfUpdate = (output: string, target = SHA) => ({ action: "self.update", target, output });

describe("self.update: verified deploy with a pending activation", () => {
  it("derives the activation from the self.update action's own return value and tells the verifier the target state", () => {
    const typed = typedActionsExecution([selfUpdate(helperOutput())]);
    expect(typed.result).toContain("STATUS: success");
    expect(typed.result).toContain(`WHAT_RAN: typed executor actions: self.update ${SHA}`);
    const pending = typed.pendingActivations;
    expect(pending).toEqual([{ sha: SHA, unit: UNIT, dueAt: "2026-10-16T17:34:51.000Z" }]);
    const note = selfUpdateVerifierNote(pending);
    expect(note).toContain(SHA);
    expect(note).toContain(UNIT);
    expect(note).toContain("NOT a reason to fail");
    expect(note).toContain("Fail when the installation is not at the commit");
    expect(activationReason(pending)).toContain("0239df46276a at 2026-10-16T17:34:51.000Z");
    expect(activationAction(pending)).toContain("after 2026-10-16T17:34:51.000Z");
    // Next to other typed actions only the self.update action counts.
    expect(typedActionsExecution([{ action: "self.status", target: "state", output: "{}" }, selfUpdate(helperOutput())]).pendingActivations).toHaveLength(1);
  });

  it("gives no relief for anything but a verified deploy with a scheduled activation of the planned commit", () => {
    const refused = [
      helperOutput({ ok: false }),
      helperOutput({ result: "failed" }),
      helperOutput({ phase: "deploy" }),
      helperOutput({ action: "dienste.update" }),
      helperOutput({ sha: "0239df4" }),
      helperOutput({}, { status: "failed" }),
      helperOutput({}, { unit: "evil; rm -rf /" }),
      helperOutput({}, { scheduled_at: "soon" }),
      "{not json",
      helperOutput({ activation: null }),
      "",
    ];
    for (const output of refused) {
      expect(selfUpdateActivation(selfUpdate(output))).toBeNull();
      expect(typedActionsExecution([selfUpdate(output)]).pendingActivations).toEqual([]);
    }
    expect(selfUpdateVerifierNote([])).toBe("");
    expect(activationReason([])).toBe("");
    expect(activationAction([])).toBe("No further action is required.");
  });

  it("never relieves when the helper's sha is not the commit the plan named (action.target)", () => {
    expect(typedActionsExecution([selfUpdate(helperOutput(), OTHER_SHA)]).pendingActivations).toEqual([]);
    expect(typedActionsExecution([selfUpdate(helperOutput({ sha: OTHER_SHA }))]).pendingActivations).toEqual([]);
    expect(typedActionsExecution([selfUpdate(helperOutput(), "state")]).pendingActivations).toEqual([]);
  });

  it("never relieves from a typed run without a self.update action, even when its output carries the helper line", () => {
    // Zweitprüfung t_36b6a834: WHAT_RAN service.status nginx with an echoed helper line.
    const typed = typedActionsExecution([
      { action: "service.status", target: "nginx", output: helperOutput() },
      { action: "self.status", target: "state", output: helperOutput() },
      { action: "dienste.update", target: SHA, output: helperOutput() },
    ]);
    expect(typed.result).toContain(helperOutput());
    expect(typed.pendingActivations).toEqual([]);
  });

  it("never relieves from an agent-authored capability (capability.execute) or the host door (host.run)", () => {
    // Zweitprüfung t_36b6a834: a manifest that echoes the self.update line.
    const capability = capabilityExecution("fake-self-update", `${helperOutput()}\n${helperOutput()}`);
    expect(capability.result).toContain("STATUS: success");
    expect(capability.result).toContain(helperOutput());
    expect(capability.pendingActivations).toEqual([]);
    const hostRun = hostRunExecution(`## EXECUTION RESULT\nSTATUS: success\nEXIT_CODE: 0\nWHAT_RAN: host.run\nOUTPUT: ${helperOutput()}`);
    expect(hostRun.pendingActivations).toEqual([]);
  });
});

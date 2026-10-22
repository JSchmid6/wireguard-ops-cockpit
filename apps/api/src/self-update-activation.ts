// self.update deploys and verifies at once, but switches the running services
// over only by a delayed activation (a systemd timer, +600 s; see
// deploy/helpers/cockpit-self-update-run). A verifier that looks before the
// timer fired sees the old services still running — 16.10.2026, VPS job
// b3833e76: failed_verification after a correct deploy. The target state of
// the job is therefore "deployed, verified, activation scheduled".
//
// Derived only from the return value of exactly the typed self.update action
// (the root helper's JSON for the commit the plan named), never from a text
// that merely contains such a line: neither a runner's handoff, nor the output
// of an agent-authored capability (capability.execute), nor the host door
// (host.run), nor another typed action can claim it.

export interface PendingActivation {
  sha: string;
  unit: string;
  dueAt: string;
}

// The typed execution as executeTypedCapabilities hands it on: the result text
// for runner handoff and verifier, and the activations of its self.update actions.
export interface TypedExecution {
  result: string;
  pendingActivations: PendingActivation[];
}

export interface TypedActionOutput {
  action: string;
  target: string;
  output: string;
}

const SHA = /^[0-9a-f]{40}$/;
const UNIT = /^wireguard-ops-cockpit-self-update-activate-[0-9a-f]{7}-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// One self.update action: its helper output, its commit (action.target).
export function selfUpdateActivation(action: TypedActionOutput): PendingActivation | null {
  if (action.action !== "self.update" || !SHA.test(action.target)) return null;
  for (const raw of action.output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: Record<string, any>;
    try { value = JSON.parse(line); } catch { continue; }
    const activation = value?.activation;
    if (value?.action !== "self.update" || value.ok !== true || value.result !== "ok" || value.phase !== "awaiting-activation") continue;
    if (value.sha !== action.target) continue;
    if (!activation || activation.status !== "scheduled") continue;
    if (typeof activation.unit !== "string" || !UNIT.test(activation.unit)) continue;
    if (typeof activation.scheduled_at !== "string" || !ISO.test(activation.scheduled_at)) continue;
    const delay = Number.isInteger(activation.delay_seconds) && activation.delay_seconds >= 0 ? activation.delay_seconds : 0;
    const dueAt = new Date(Date.parse(activation.scheduled_at) + delay * 1000).toISOString();
    return { sha: action.target, unit: activation.unit, dueAt };
  }
  return null;
}

// The typed executor actions of a plan, all of which succeeded (a failed one
// throws before this point). Outputs go whole (the executor broker bounds each
// one); the verifier's prompt chooses from them within its bound
// (verifier-prompt.ts) instead of a blind cut here.
export function typedActionsExecution(actions: TypedActionOutput[]): TypedExecution {
  const ran = actions.map((action) => `${action.action} ${action.target}`).join(", ");
  return {
    result: `## EXECUTION RESULT\nSTATUS: success\nEXIT_CODE: 0\nWHAT_RAN: typed executor actions: ${ran}\nOUTPUT: ${actions.map((action) => action.output).join("\n")}\nNOTES: executed by isolated capability broker`,
    pendingActivations: actions.map(selfUpdateActivation).filter((item): item is PendingActivation => item !== null),
  };
}

// An agent-authored capability: its output is whatever the manifest printed,
// so it never brings an activation.
export function capabilityExecution(name: string, filteredOutput: string): TypedExecution {
  return {
    result: `## EXECUTION RESULT\nSTATUS: success\nEXIT_CODE: 0\nWHAT_RAN: ${name}\nOUTPUT: ${filteredOutput}\nNOTES: executed from a signed, agent-authored capability manifest in the host-effect sandbox`,
    pendingActivations: [],
  };
}

// The host door: its result never brings an activation either.
export function hostRunExecution(result: string): TypedExecution {
  return { result, pendingActivations: [] };
}

export function selfUpdateVerifierNote(pending: PendingActivation[]): string {
  if (pending.length === 0) return "";
  const items = pending.map((item) => `commit ${item.sha} with activation unit ${item.unit} (timer due ${item.dueAt})`).join("; ");
  return [
    "Self-update target state: the self.update door deploys and verifies now and switches the running services over later by a delayed activation (a systemd timer).",
    `For this job the target state is reached when, for ${items}: the installation is at that commit, the deploy verification in the runner handoff passed, and the activation timer is scheduled (active/waiting) — or, when it is already due, the activation ran without failure.`,
    "Services that still run the previous commit before the timer is due are expected and are NOT a reason to fail.",
    "Fail when the installation is not at the commit, the deploy verification did not pass, or no activation is scheduled.",
  ].join(" ");
}

// How a verified job with a pending activation reports itself: the job is done,
// the switch-over still lies ahead, and whoever reads the job learns when.
export function activationReason(pending: PendingActivation[]): string {
  if (pending.length === 0) return "";
  return ` The activation is still pending: ${pending.map((item) => `${item.sha.slice(0, 12)} at ${item.dueAt} (unit ${item.unit})`).join(", ")}.`;
}

export function activationAction(pending: PendingActivation[]): string {
  if (pending.length === 0) return "No further action is required.";
  const last = pending.map((item) => item.dueAt).sort().at(-1);
  return `No action is required now; after ${last} confirm that the services run the new commit.`;
}

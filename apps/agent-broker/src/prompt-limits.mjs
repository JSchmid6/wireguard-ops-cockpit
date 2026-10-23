// The one definition of the agent broker's prompt bounds, in characters
// (JavaScript string length). The broker enforces them (index.mjs,
// validateRequest); the API reads the same file to build its prompts within
// them (apps/api/src/agent-broker.ts, verifier-prompt.ts, host-run.ts,
// update-review.ts) and to refuse an oversized prompt before it is sent.
//
// The safety role reviews plans and a bounded diff excerpt of a Cockpit
// self-update, the verifier reads the trusted intent, the reviewed plan and
// the runner handoff: both get the larger budget (30,000 refused finished
// host runs on 21.10.2026, jobs ba5196ee and a86a0577). The prompt reaches
// opencode on stdin, not as an argv element, so no byte bound applies
// (Linux caps one argument at 128 KiB, MAX_ARG_STRLEN; until 22.10.2026 that
// was a second bound of 120,000 bytes).
export const PROMPT_LIMITS = Object.freeze({
  planner: 30_000,
  research: 30_000,
  runner: 30_000,
  safety: 100_000,
  verifier: 100_000,
});

export function promptLimit(role) {
  if (!Object.hasOwn(PROMPT_LIMITS, role)) throw new Error("invalid agent role");
  return PROMPT_LIMITS[role];
}

// Null when the prompt fits, otherwise the reason with bound and length, so a
// violation explains itself ("prompt length 41234 exceeds verifier limit 30000").
export function promptLimitProblem(role, prompt) {
  if (typeof prompt !== "string" || prompt.length < 1) return "prompt is empty or not a string";
  const limit = promptLimit(role);
  if (prompt.length > limit) return `prompt length ${prompt.length} exceeds ${role} limit ${limit}`;
  return null;
}

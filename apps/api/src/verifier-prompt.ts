import { buildAgentTask } from "./hermes-security.js";

// The verifier's prompt bound. The agent broker refuses a longer prompt with
// "prompt length is invalid" (apps/agent-broker/src/index.mjs, promptLimits):
// the prompt is one argv element of opencode, so a byte bound applies as well.
// Both numbers must stay equal to the broker's; a test reads the broker's own
// validateRequest against them.
export const VERIFIER_PROMPT_CHARS = 100_000;
export const VERIFIER_PROMPT_BYTES = 120_000;

// 21.10.2026 (jobs ba5196ee, a86a0577): a host run updating many php packages
// handed the verifier 30,000 characters of apt log next to the intent and the
// plan; the broker refused the prompt, and the job ended failed_execution with
// completed [] although the run had finished on the host. The handoff is
// therefore clipped before it reaches the verifier, deterministically: the
// header fields and every "== ..." line of the run log stay, check sections
// stay whole as long as they fit, step bodies keep their head and their end.
// Every cut is marked; the job record keeps the unclipped handoff.

interface Section { header: string | null; body: string; check: boolean }

const CHECK_HEADER = /^== \S+ check \d+\/\d+: /;

function marker(left: number): string {
  return `[... ${left} characters of this section left out for the verifier's prompt bound; the job record keeps the full text ...]`;
}

// Head and end of a text within `limit` characters, the cut marked in between.
export function clipMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const mark = marker(text.length);
  const room = limit - mark.length - 2;
  // Too little room for head and end: the cut is still marked, if need be
  // a little beyond the limit (the callers measure the result and shrink).
  if (room < 40) return limit >= mark.length ? mark : `[... ${text.length} characters cut ...]`;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${text.slice(0, head)}\n${marker(text.length - head - tail)}\n${text.slice(text.length - tail)}`;
}

function sections(output: string): Section[] {
  const result: Section[] = [];
  let current: Section = { header: null, body: "", check: false };
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.startsWith("== ")) {
      if (current.header !== null || current.body) result.push(current);
      current = { header: line, body: "", check: CHECK_HEADER.test(line) };
    } else {
      current.body = current.body ? `${current.body}\n${line}` : line;
    }
  }
  result.push(current);
  return result;
}

function join(parts: Section[]): string {
  return parts.map((part) => [part.header, part.body].filter((item) => item !== null && item !== "").join("\n")).join("\n");
}

// Shares `room` among the bodies: the smaller ones whole, the rest equal parts.
function share(bodies: Section[], room: number): Map<Section, number> {
  const limits = new Map<Section, number>();
  const open = [...bodies].sort((a, b) => a.body.length - b.body.length);
  let left = room;
  while (open.length > 0) {
    const part = Math.floor(left / open.length);
    const next = open.shift()!;
    const limit = Math.max(0, Math.min(next.body.length, part));
    limits.set(next, limit);
    left -= limit;
  }
  return limits;
}

function clipOutput(output: string, limit: number): string {
  if (output.length <= limit) return output;
  const parts = sections(output);
  const fixed = parts.reduce((sum, part) => sum + (part.header?.length ?? 0) + 1, 0);
  if (fixed >= limit) return clipMiddle(output, limit);
  const checks = parts.filter((part) => part.check && part.body);
  const others = parts.filter((part) => !part.check && part.body);
  const checkSize = checks.reduce((sum, part) => sum + part.body.length + 1, 0);
  let room = limit - fixed;
  for (let attempt = 0; attempt < 4 && room > 0; attempt += 1) {
    // Check outputs prove the target state: whole when they fit, the steps share the rest.
    const limits = checkSize <= room
      ? new Map([...checks.map((part) => [part, part.body.length] as const), ...share(others, room - checkSize - others.length)])
      : share([...checks, ...others], room - checks.length - others.length);
    const text = join(parts.map((part) => ({ ...part, body: part.body ? clipMiddle(part.body, limits.get(part) ?? 0) : part.body })));
    if (text.length <= limit) return text;
    room -= text.length - limit;
  }
  return clipMiddle(output, limit);
}

// The runner handoff within `limit` characters: STATUS, EXIT_CODE, WHAT_RAN and
// NOTES whole, the OUTPUT field clipped.
export function clipHandoff(handoff: string, limit: number): string {
  if (handoff.length <= limit) return handoff;
  const start = handoff.indexOf("OUTPUT: ");
  if (start < 0) return clipMiddle(handoff, limit);
  const outputStart = start + "OUTPUT: ".length;
  const notes = handoff.lastIndexOf("\nNOTES:");
  const outputEnd = notes > outputStart ? notes : handoff.length;
  const prefix = handoff.slice(0, outputStart);
  const suffix = handoff.slice(outputEnd);
  const room = limit - prefix.length - suffix.length;
  if (room < 200) return clipMiddle(handoff, limit);
  return prefix + clipOutput(handoff.slice(outputStart, outputEnd), room) + suffix;
}

function fits(prompt: string): boolean {
  return prompt.length <= VERIFIER_PROMPT_CHARS && Buffer.byteLength(prompt, "utf8") <= VERIFIER_PROMPT_BYTES;
}

function overBy(prompt: string): number {
  return Math.max(prompt.length - VERIFIER_PROMPT_CHARS, Buffer.byteLength(prompt, "utf8") - VERIFIER_PROMPT_BYTES);
}

export interface VerifierPrompt { prompt: string; clipped: boolean }

// The verifier's prompt within the broker's bound. Only the untrusted evidence
// is clipped (the handoff first, the plan only when the handoff alone cannot
// make room); the trusted instruction never is. When even the instruction does
// not fit, the caller gets an error it reports as a failed verification.
export function boundedVerifierPrompt(instruction: string, plan: string, handoff: string): VerifierPrompt {
  const build = (planText: string, handoffText: string) => buildAgentTask(instruction, [
    { source: "reviewed-plan", content: planText }, { source: "runner-handoff", content: handoffText },
  ]);
  const whole = build(plan, handoff);
  if (fits(whole)) return { prompt: whole, clipped: false };
  if (!fits(build("", ""))) throw new Error(`the trusted intent alone exceeds the verifier's prompt bound (${VERIFIER_PROMPT_CHARS} characters)`);
  let planText = plan;
  for (let round = 0; round < 4; round += 1) {
    let limit = Math.max(0, VERIFIER_PROMPT_CHARS - (build(planText, "").length));
    for (let attempt = 0; attempt < 12 && limit >= 1000; attempt += 1) {
      const prompt = build(planText, clipHandoff(handoff, limit));
      if (fits(prompt)) return { prompt, clipped: true };
      // JSON escaping and multi-byte characters make the text longer than its count.
      limit -= Math.ceil(overBy(prompt) * 1.25) + 64;
    }
    // The handoff alone cannot make room: the plan gives up half its size.
    planText = clipMiddle(plan, Math.floor(planText.length / 2));
  }
  const last = build(clipMiddle(plan, 2000), clipHandoff(handoff, 2000));
  if (fits(last)) return { prompt: last, clipped: true };
  throw new Error("the verifier's prompt could not be brought within its bound");
}

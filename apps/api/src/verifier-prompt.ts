import { agentPromptLimit } from "./agent-broker.js";
import { buildAgentTask } from "./hermes-security.js";

// The verifier's prompt bound, from the file the agent broker enforces
// (apps/agent-broker/src/prompt-limits.mjs). A longer prompt is refused with
// "prompt length <n> exceeds verifier limit <bound>".
export const VERIFIER_PROMPT_CHARS = agentPromptLimit("verifier");

// 21.10.2026 (jobs ba5196ee, a86a0577): a host run updating many php packages
// handed the verifier 30,000 characters of apt log next to the intent and the
// plan; the broker refused the prompt, and the job ended failed_execution with
// completed [] although the run had finished on the host. The handoff is
// therefore clipped before it reaches the verifier, deterministically: the
// header fields and every "== ..." line of the run log stay, check sections
// stay whole as long as they fit, step bodies keep their head, the lines that
// tell how they went (errors, failures, exit codes) and their end. Every cut
// is marked in place, and a note ahead of the evidence says what was left out;
// the job record keeps the unclipped handoff.

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

// Lines that tell how a step went. They stay when the body around them is cut.
const SALIENT = /\b(?:errors?|fail(?:ed|ure|s)?|fatal|panic|abort(?:ed|ing)?|denied|refused|traceback|exception|timed? ?out|cannot|unable|not found|no such|warn(?:ing)?s?|guard)\b|^(?:E|W|ERROR|FATAL):|\b(?:exit(?:ed)?|exit code|exit status|returned|rc)\b\D{0,12}\d+/i;
const LINE_LIMIT = 600;

function gap(lines: string[]): string {
  const characters = lines.reduce((sum, line) => sum + line.length + 1, 0);
  return `[... ${lines.length} line${lines.length === 1 ? "" : "s"} (${characters} characters) left out for the verifier's prompt bound; the job record keeps the full text ...]`;
}

// Picks whole lines within `room`: the end first (where a step ends, its
// result is), then the head, then the salient lines of the middle, the latest
// first; what room is left extends the end further. Each run of left-out
// lines becomes one marker.
function selectLines(lines: string[], room: number): string {
  const keep = new Set<number>();
  const shown = lines.map((line) => line.length > LINE_LIMIT ? clipMiddle(line, LINE_LIMIT) : line);
  let left = Math.floor(room * 0.95);
  const take = (index: number, cap: number): boolean => {
    const cost = shown[index].length + 1;
    if (keep.has(index)) return true;
    if (cost > cap || cost > left) return false;
    keep.add(index);
    left -= cost;
    return true;
  };
  let tail = Math.floor(room * 0.45);
  for (let index = lines.length - 1; index >= 0 && tail > 0; index -= 1) {
    const before = left;
    if (!take(index, tail)) break;
    tail -= before - left;
  }
  let head = Math.floor(room * 0.15);
  for (let index = 0; index < lines.length && head > 0; index += 1) {
    const before = left;
    if (!take(index, head)) break;
    head -= before - left;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!keep.has(index) && SALIENT.test(lines[index])) take(index, left);
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!take(index, left)) break;
  }
  const parts: string[] = [];
  let skipped: string[] = [];
  lines.forEach((line, index) => {
    if (!keep.has(index)) { skipped.push(line); return; }
    if (skipped.length > 0) { parts.push(gap(skipped)); skipped = []; }
    parts.push(shown[index]);
  });
  if (skipped.length > 0) parts.push(gap(skipped));
  return parts.join("\n");
}

// A log body within `limit` characters, chosen line by line (selectLines);
// text without line structure falls back to head and end.
export function clipLog(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  if (lines.length >= 3) {
    let room = limit;
    for (let attempt = 0; attempt < 4 && room > 0; attempt += 1) {
      const selected = selectLines(lines, room);
      if (selected.length <= limit && /\S/.test(selected.replace(/\[\.\.\. \d+ lines? \(\d+ characters\) left out[^\]]*\]/g, ""))) return selected;
      room -= Math.max(1, selected.length - limit);
    }
  }
  return clipMiddle(text, limit);
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
    const text = join(parts.map((part) => ({ ...part, body: part.body ? clipLog(part.body, limits.get(part) ?? 0) : part.body })));
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
  return prompt.length <= VERIFIER_PROMPT_CHARS;
}

export interface VerifierPrompt { prompt: string; clipped: boolean }

const CUT_MARK = /\[\.\.\. (?:(\d+) lines? \((\d+) characters\)|(\d+) characters)(?: of this section)? (?:left out|cut)/g;

// What was left out, in words, ahead of the evidence: the verifier must know
// that a missing line is a cut, not an absent event.
function budgetNote(name: string, original: string, shown: string): string {
  if (shown === original) return `${name}: complete (${original.length} characters).`;
  let cuts = 0;
  let lines = 0;
  for (const match of shown.matchAll(CUT_MARK)) {
    cuts += 1;
    lines += Number(match[1] ?? 0);
  }
  return `${name}: shortened from ${original.length} to ${shown.length} characters; ${cuts} cut${cuts === 1 ? "" : "s"}${lines ? ` (${lines} lines)` : ""}, each marked in place with "[... left out ...]".`;
}

function note(plan: string, planText: string, handoff: string, handoffText: string): string {
  return [
    `The verifier's prompt is limited to ${VERIFIER_PROMPT_CHARS} characters (agent broker, verifier role). To fit, the Cockpit shortened the evidence before it reached you:`,
    budgetNote("reviewed-plan", plan, planText),
    budgetNote("runner-handoff", handoff, handoffText),
    "Kept in the runner handoff: STATUS, EXIT_CODE, WHAT_RAN, NOTES, every \"== ...\" run-log line, check sections as long as they fit, and of each shortened body its head, its error, failure and exit-code lines and its end. The job record keeps the full text. A part that was left out is evidence neither for nor against the target state; check it yourself when it matters.",
  ].join("\n");
}

// The verifier's prompt within the broker's bound. Only the untrusted evidence
// is clipped (the handoff first, the plan only when the handoff alone cannot
// make room); the trusted instruction never is. When even the instruction does
// not fit, the caller gets an error it reports as a failed verification.
export function boundedVerifierPrompt(instruction: string, plan: string, handoff: string): VerifierPrompt {
  const plain = (planText: string, handoffText: string) => buildAgentTask(instruction, [
    { source: "reviewed-plan", content: planText }, { source: "runner-handoff", content: handoffText },
  ]);
  const build = (planText: string, handoffText: string) => buildAgentTask(instruction, [
    { source: "cockpit-prompt-budget", content: note(plan, planText, handoff, handoffText) },
    { source: "reviewed-plan", content: planText }, { source: "runner-handoff", content: handoffText },
  ]);
  const whole = plain(plan, handoff);
  if (fits(whole)) return { prompt: whole, clipped: false };
  if (!fits(build("", ""))) throw new Error(`the trusted intent alone exceeds the verifier's prompt bound (${VERIFIER_PROMPT_CHARS} characters)`);
  let planText = plan;
  for (let round = 0; round < 4; round += 1) {
    const base = build(planText, "").length;
    const room = VERIFIER_PROMPT_CHARS - base;
    let limit = room;
    for (let attempt = 0; attempt < 12 && limit >= 1000; attempt += 1) {
      const shown = clipHandoff(handoff, limit);
      const prompt = build(planText, shown);
      if (fits(prompt)) return { prompt, clipped: true };
      // JSON escaping makes the text longer than its count: the next limit
      // scales by the measured ratio, so the handoff fills its room closely.
      const cost = (prompt.length - base) / Math.max(1, shown.length);
      limit = Math.min(limit - 64, Math.floor(room / cost) - 64);
    }
    // The handoff alone cannot make room: the plan gives up half its size.
    planText = clipMiddle(plan, Math.floor(planText.length / 2));
  }
  const last = build(clipMiddle(plan, 2000), clipHandoff(handoff, 2000));
  if (fits(last)) return { prompt: last, clipped: true };
  throw new Error("the verifier's prompt could not be brought within its bound");
}

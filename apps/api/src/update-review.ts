import { randomBytes } from "node:crypto";

import {
  hashCanonical,
  parseTypedDiensteUpdates,
  parseTypedSelfUpdates,
  typedPlanScript,
  type ExecutionEnvelope,
  type UntrustedEvidence,
} from "./hermes-security.js";
import {
  DIENSTE_REVIEW_INSTRUCTIONS,
  UPDATE_REVIEW_INSTRUCTIONS,
  updateReviewClosingReminder,
  updateReviewDataNotice,
} from "./update-review-prompt.js";

// Pre-install review of a Cockpit self-update.
//
// Before a typed `self.update <sha>` runs, the running (old) Cockpit fetches
// the diff deployed-base..sha through the executor broker (`self.diff`, the
// runner's read-only `diff`), lets an isolated reviewer judge it against the
// guarantees in update-review-prompt.ts, and binds the reviewed diff hash to
// the execution envelope and to the broker request. The runner recomputes the
// hash right before the deploy script and refuses a mismatch.
//
// Deterministic stops (operator approval): the review input is unavailable or
// incomplete inside a focus area or the deploy material, the reviewer failed,
// its answer does not parse, or it answered VERDICT flag. Touching a focus area is never a stop by
// itself.
//
// The same review guards a second repository: `dienste.update <sha>` installs a
// merged commit of server-dienste (the root supervisor that runs James' Docker
// services). Its runner answers `dienste.diff`, its reviewer gets the
// supervisor's own guarantees (D1-D8), and its bindings carry their own
// evidence source, so a review of one repository never unlocks the other.

// Bytes of the whole reviewer prompt. Stays below the agent broker's
// safety-role bounds (100,000 characters, 120,000 bytes: one argv element).
export const UPDATE_REVIEW_PROMPT_LIMIT = 96_000;
const FILE_LIST_BUDGET = 8_000;
const EVIDENCE_ITEM_LIMIT = 4_000;
const SHA = /^[a-f0-9]{40}$/;
const DIFF_HASH = /^[a-f0-9]{64}$/;

export type UpdateKind = "self" | "dienste";

export interface UpdateKindSpec {
  diffAction: "self.diff" | "dienste.diff";
  updateAction: "self.update" | "dienste.update";
  evidencePrefix: string;
  instructions: string;
  subject: string;
}

export const UPDATE_KINDS: Record<UpdateKind, UpdateKindSpec> = {
  self: {
    diffAction: "self.diff", updateAction: "self.update", evidencePrefix: "self-update-review",
    instructions: UPDATE_REVIEW_INSTRUCTIONS, subject: "the new Cockpit code",
  },
  dienste: {
    diffAction: "dienste.diff", updateAction: "dienste.update", evidencePrefix: "dienste-update-review",
    instructions: DIENSTE_REVIEW_INSTRUCTIONS, subject: "the new server-dienste stand (root supervisor)",
  },
};

function kindOf(value: unknown): UpdateKind {
  return value === "dienste" ? "dienste" : "self";
}

function kindField(value: unknown): { kind?: UpdateKind } {
  return kindOf(value) === "self" ? {} : { kind: kindOf(value) };
}

export interface UpdateTarget {
  kind: UpdateKind;
  sha: string;
}

export interface UpdateFocusArea {
  kind: string;
  guarantees: string[];
  reason: string;
  files: string[];
  hunks: string[];
  lockfiles: string[];
  packages: string[];
}

export interface UpdateDiffFile {
  status: string;
  path: string;
  added: number | null;
  deleted: number | null;
  class: string;
}

export interface UpdateDiffSection {
  path: string;
  text: string;
}

export interface UpdateDiff {
  kind?: UpdateKind;
  base: string;
  sha: string;
  diffSha256: string;
  baseSource: string;
  commitSubject: string;
  files: UpdateDiffFile[];
  filesTotal: number;
  stat: string;
  focusAreas: UpdateFocusArea[];
  excerpt: UpdateDiffSection[];
  truncated: boolean;
  partialFiles: string[];
  omittedFiles: string[];
}

export interface UpdateBinding {
  kind?: UpdateKind;
  base: string;
  sha: string;
  diffSha256: string;
}

export interface UpdateReviewCoverage {
  sha: string;
  // Focus-area and deploy files the reviewer could not see completely: a
  // deterministic stop.
  incomplete: string[];
  // Files cut or left out of the prompt (focus or not), for the record.
  cut: string[];
  omitted: string[];
}

export interface UpdateReviewFinding {
  title: string;
  guarantee: string;
  file: string;
  code: string;
  reason: string;
  severity: string;
  quoteFound: boolean;
}

export interface UpdateReviewAnswer {
  verdict: "approve" | "flag" | "invalid";
  findings: UpdateReviewFinding[];
  notes: string;
  problem: string | null;
}

export interface UpdateReviewOutcome {
  kind?: UpdateKind;
  bindings: UpdateBinding[];
  unavailable?: string | null;
  coverage: UpdateReviewCoverage[];
  answer?: UpdateReviewAnswer | null;
  reviewerError?: string | null;
}

// Structurally identical to the plan policy in app.ts.
export interface ReviewedPolicy {
  zone: "green" | "yellow" | "red";
  allowed: boolean;
  status: "ready" | "blocked_policy" | "blocked_user_approval" | "blocked_prerequisite";
  reason: string;
  evidence: string[];
  neededToContinue: string[];
  rollbackAvailable: boolean;
}

function strings(value: unknown, limit = 2000): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[... clipped ...]` : value;
}

export function selfUpdateTargets(plan: string): string[] {
  return updateTargets(plan).filter((target) => target.kind === "self").map((target) => target.sha);
}

// Every reviewed install a plan would run, in plan order, deduplicated.
export function updateTargets(plan: string): UpdateTarget[] {
  const script = typedPlanScript(plan);
  const found: UpdateTarget[] = [
    ...parseTypedSelfUpdates(script).actions.filter((action) => action.action === "self.update").map((action) => ({ kind: "self" as const, sha: action.target })),
    ...parseTypedDiensteUpdates(script).actions.filter((action) => action.action === "dienste.update").map((action) => ({ kind: "dienste" as const, sha: action.target })),
  ];
  const seen = new Set<string>();
  return found.filter((target) => {
    const key = `${target.kind}:${target.sha}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Strict reading of the runner's `diff` JSON: anything malformed is an
// unavailable review input, never a partially trusted one.
export function parseUpdateDiff(raw: string, expectedSha: string, kind: UpdateKind = "self"): UpdateDiff {
  const action = UPDATE_KINDS[kind].diffAction;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${action} returned no JSON`); }
  if (!value || typeof value !== "object") throw new Error(`${action} returned no object`);
  const data = value as Record<string, unknown>;
  if (data.ok !== true || data.action !== action) throw new Error(`${action} returned an unexpected answer`);
  if (data.sha !== expectedSha) throw new Error(`${action} answered for a different commit`);
  if (typeof data.base !== "string" || !SHA.test(data.base)) throw new Error(`${action} returned no valid base commit`);
  if (typeof data.diffSha256 !== "string" || !DIFF_HASH.test(data.diffSha256)) throw new Error(`${action} returned no valid diff sha256`);
  if (!Array.isArray(data.files) || !Array.isArray(data.focusAreas) || !Array.isArray(data.excerpt)) throw new Error(`${action} returned an incomplete review input`);
  const files = data.files.flatMap((item): UpdateDiffFile[] => {
    if (!item || typeof item !== "object") return [];
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.status !== "string") return [];
    return [{
      status: file.status.slice(0, 2), path: file.path,
      added: typeof file.added === "number" ? file.added : null,
      deleted: typeof file.deleted === "number" ? file.deleted : null,
      class: typeof file.class === "string" ? file.class : "other",
    }];
  });
  const focusAreas = data.focusAreas.flatMap((item): UpdateFocusArea[] => {
    if (!item || typeof item !== "object") return [];
    const area = item as Record<string, unknown>;
    if (typeof area.kind !== "string") return [];
    return [{
      kind: area.kind.slice(0, 60), guarantees: strings(area.guarantees, 8), reason: typeof area.reason === "string" ? area.reason.slice(0, 400) : "",
      files: strings(area.files), hunks: strings(area.hunks, 6), lockfiles: strings(area.lockfiles, 20), packages: strings(area.packages, 400),
    }];
  });
  const excerpt = data.excerpt.flatMap((item): UpdateDiffSection[] => {
    if (!item || typeof item !== "object") return [];
    const section = item as Record<string, unknown>;
    return typeof section.path === "string" && typeof section.text === "string" ? [{ path: section.path, text: section.text }] : [];
  });
  if (excerpt.length !== data.excerpt.length) throw new Error(`${action} returned a malformed excerpt`);
  return {
    kind,
    base: data.base, sha: data.sha, diffSha256: data.diffSha256,
    baseSource: typeof data.baseSource === "string" ? data.baseSource : "unknown",
    commitSubject: typeof data.commitSubject === "string" ? data.commitSubject.slice(0, 200) : "",
    files, filesTotal: typeof data.filesTotal === "number" ? data.filesTotal : files.length,
    stat: typeof data.stat === "string" ? data.stat : "",
    focusAreas, excerpt, truncated: data.truncated === true,
    partialFiles: strings(data.partialFiles), omittedFiles: strings(data.omittedFiles),
  };
}

// High-confidence secret formats only (G6): the reviewer must still see code
// such as `password: string` to judge the auth guarantees.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY]"],
  [/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED:API_KEY]"],
  [/glpat-[a-zA-Z0-9_.-]{20,}/g, "[REDACTED:TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED:TOKEN]"],
  [/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, "[REDACTED:JWT]"],
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export function focusFiles(diff: UpdateDiff): Set<string> {
  return new Set(diff.focusAreas.flatMap((area) => area.files));
}

// Material that runs as root on the host: the deploy tree holds the installer,
// the root helpers, the systemd units and the sudoers sources. It comes first in
// the excerpt; when it does not fit it is named and stops the update. The runner orders its sections
// by file class, which puts a file it classes as `other` behind tests and docs —
// that is how deploy/vps/vps-cockpit-deploy.sh fell out of the material of the
// 28.09.2026 rollout review although it installs everything as root.
const DEPLOY_MATERIAL = /^deploy\//;

// The diff sections in review order: deploy material first, everything else in
// the runner's order (stable, so a focus area still precedes tests and docs).
export function materialOrder(sections: UpdateDiffSection[]): UpdateDiffSection[] {
  return [
    ...sections.filter((section) => DEPLOY_MATERIAL.test(section.path)),
    ...sections.filter((section) => !DEPLOY_MATERIAL.test(section.path)),
  ];
}

// Deploy material the excerpt does not cover completely, whether cut, left out,
// or never emitted as a section by the runner. Each such file is a
// deterministic stop (like an incomplete focus area): a root installer the
// reviewer could not read is never approved silently.
function deployGaps(diff: UpdateDiff, complete: Set<string>): string[] {
  return diff.files
    .map((file) => file.path)
    .filter((path) => DEPLOY_MATERIAL.test(path) && !complete.has(path));
}

// The gaps that are not already named as cut: reported as left out, so the
// reviewer sees them in the state line instead of assuming a complete material.
function namedDeployGaps(diff: UpdateDiff, complete: Set<string>, cut: string[]): string[] {
  return deployGaps(diff, complete).filter((path) => !cut.includes(path));
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

function describeUpdate(diff: UpdateDiff, index: number, total: number): string {
  const focus = focusFiles(diff);
  const lines = [
    `# Update ${index + 1}/${total}: ${diff.sha} (installed base ${diff.base}, from ${diff.baseSource})`,
    `Commit subject (data): ${redactSecrets(diff.commitSubject) || "(none)"}`,
    `Reviewed diff sha256: ${diff.diffSha256} (${diff.filesTotal} changed file(s))`,
    "",
    "## Focus areas",
  ];
  if (diff.focusAreas.length === 0) lines.push("(none: the update touches no guarantee-relevant file)");
  for (const area of diff.focusAreas) {
    lines.push(`- ${area.kind} [${area.guarantees.join(", ") || "any"}]: ${area.reason}`);
    if (area.files.length) lines.push(`  files: ${area.files.slice(0, 40).join(", ")}${area.files.length > 40 ? `, ... (${area.files.length - 40} more)` : ""}`);
    for (const hunk of area.hunks) {
      const header = hunk.split("\n").find((line) => line.startsWith("@@"));
      if (header) lines.push(`  hunk: ${header}`);
    }
    if (area.lockfiles.length) lines.push(`  lockfiles (summarized, not in the excerpt): ${area.lockfiles.join(", ")}`);
    for (const pkg of area.packages) lines.push(`  package: ${pkg}`);
  }
  lines.push("", "## Changed files");
  let listed = 0;
  let others = 0;
  let used = 0;
  for (const file of diff.files) {
    const line = `${file.status} ${file.path} (+${file.added ?? "?"} -${file.deleted ?? "?"}) [${file.class}]`;
    if (!focus.has(file.path) && used + line.length > FILE_LIST_BUDGET) { others += 1; continue; }
    lines.push(line);
    used += line.length;
    listed += 1;
  }
  const unlisted = others + Math.max(0, diff.filesTotal - diff.files.length);
  if (unlisted > 0) lines.push(`... ${unlisted} more changed file(s) outside the focus areas`);
  if (listed === 0 && unlisted === 0) lines.push("(none)");
  const summary = diff.stat.trim().split("\n").at(-1)?.trim();
  lines.push("", "## Stat", summary || "(none)");
  return lines.join("\n");
}

// The complete reviewer prompt. The instruction block comes first, then the
// material inside nonce-marked data markers, then a short reminder. Sections of
// the diff are taken in review order — the deploy material first, then the
// runner's order (focus areas first) — while they fit the budget; focus-area and
// deploy files that do not fit completely are reported as incomplete coverage
// (a stop), deploy material without any section is also named as left out.
export function buildUpdateReviewPrompt(diffs: UpdateDiff[], options: { nonce?: string; limit?: number } = {}): { prompt: string; coverage: UpdateReviewCoverage[] } {
  const nonce = options.nonce || randomBytes(8).toString("hex");
  const limit = options.limit ?? UPDATE_REVIEW_PROMPT_LIMIT;
  // One reviewer, one set of guarantees: a prompt never mixes repositories.
  const kinds = new Set(diffs.map((diff) => kindOf(diff.kind)));
  if (kinds.size > 1) throw new Error("one review covers one repository; the plan mixes self.update and dienste.update");
  const instructions = UPDATE_KINDS[kindOf(diffs[0]?.kind)].instructions;
  const head = [instructions, "", updateReviewDataNotice(nonce), "", `BEGIN_REVIEW_DATA ${nonce}`].join("\n");
  const tail = [`END_REVIEW_DATA ${nonce}`, "", updateReviewClosingReminder(nonce)].join("\n");
  const descriptions = diffs.map((diff, index) => describeUpdate(diff, index, diffs.length));
  let remaining = limit - bytes(head) - bytes(tail) - descriptions.reduce((sum, text) => sum + bytes(text) + 400, 0);
  const coverage: UpdateReviewCoverage[] = [];
  const blocks: string[] = [];
  diffs.forEach((diff, index) => {
    const included: string[] = [];
    const cut: string[] = [];
    const omitted: string[] = [...diff.omittedFiles];
    const complete = new Set<string>();
    const shown = new Set<string>();
    for (const section of materialOrder(diff.excerpt)) {
      const text = redactSecrets(section.text.endsWith("\n") ? section.text : `${section.text}\n`);
      const size = bytes(text);
      if (cut.length || omitted.length > diff.omittedFiles.length) {
        omitted.push(section.path);
      } else if (size <= remaining) {
        included.push(text);
        remaining -= size;
        shown.add(section.path);
        if (!diff.partialFiles.includes(section.path) && !/^Binary files /m.test(text)) complete.add(section.path);
      } else if (remaining > 1024) {
        const room = Buffer.from(text, "utf8").subarray(0, remaining - 200).toString("utf8").replace(/\uFFFD+$/, "");
        const partial = `${room.slice(0, Math.max(0, room.lastIndexOf("\n")))}\n[... ${section.path} truncated for the review budget ...]\n`;
        included.push(partial);
        remaining -= bytes(partial);
        cut.push(section.path);
      } else {
        omitted.push(section.path);
      }
    }
    const incomplete = [...new Set([...[...focusFiles(diff)].filter((file) => !complete.has(file)), ...deployGaps(diff, complete)])].sort();
    // cut: partially in the prompt (by the runner or here); omitted: not at all.
    const cutFiles = [...new Set([...diff.partialFiles.filter((file) => shown.has(file)), ...cut])];
    const omittedFiles = [...new Set([...omitted, ...namedDeployGaps(diff, complete, cutFiles)])];
    coverage.push({ sha: diff.sha, incomplete, cut: cutFiles, omitted: omittedFiles });
    const excerpt = included.join("");
    const state = cutFiles.length || omittedFiles.length
      ? `The excerpt is INCOMPLETE. Cut: ${cutFiles.join(", ") || "none"}. Left out: ${omittedFiles.join(", ") || "none"}.`
      : "The excerpt is complete (every changed file's diff section is included; lockfiles are summarized above).";
    const marker = fence(excerpt);
    blocks.push([descriptions[index], "", "## Diff excerpt", state, `${marker}diff`, excerpt.trimEnd(), marker].join("\n"));
  });
  return { prompt: [head, blocks.join("\n\n"), tail].join("\n"), coverage };
}

// Upper-case keys only (as the format demands), optionally bulleted or bold.
const ANSWER_KEY = /^\s*(?:[-*]\s+)?\**\s*(VERDICT|FINDING|GUARANTEE|FILE|CODE|REASON|SEVERITY|NOTES)\s*\**\s*:\s*\**\s*(.*?)\s*\**\s*$/;
const FINDING_LIMITS = { title: 200, guarantee: 40, file: 300, code: 4000, reason: 2000, severity: 20 };

// Deterministic reading of the reviewer's answer. Exactly one VERDICT line of
// approve or flag; anything else is invalid and stops the update. Lines inside
// ``` fences are always continuation (quoted code never becomes a key).
export function parseUpdateReviewAnswer(raw: string): UpdateReviewAnswer {
  const lines = raw.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((line) => !/^(?:timestamp=|tee:|> build )/.test(line));
  const verdicts: string[] = [];
  const findings: Array<Omit<UpdateReviewFinding, "quoteFound">> = [];
  const notes: string[] = [];
  let field: "title" | "guarantee" | "file" | "code" | "reason" | "severity" | "notes" | null = null;
  let inFence = false;
  const current = () => {
    if (findings.length === 0) findings.push({ title: "", guarantee: "", file: "", code: "", reason: "", severity: "" });
    return findings[findings.length - 1];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    const key = inFence ? null : line.match(ANSWER_KEY);
    if (!key) {
      if (field === "code" || field === "reason") current()[field] += `${current()[field] ? "\n" : ""}${line}`;
      else if (field === "notes" && line.trim()) notes.push(line.trim());
      continue;
    }
    const name = key[1];
    const value = key[2];
    if (name === "VERDICT") { verdicts.push(value.toLowerCase()); field = null; continue; }
    if (name === "NOTES") { if (value) notes.push(value); field = "notes"; continue; }
    if (name === "FINDING") {
      findings.push({ title: value, guarantee: "", file: "", code: "", reason: "", severity: "" });
      field = "title";
      continue;
    }
    field = name.toLowerCase() as "guarantee" | "file" | "code" | "reason" | "severity";
    current()[field] = value;
  }
  const bounded = findings.slice(0, 10).map((finding) => ({
    title: finding.title.trim().slice(0, FINDING_LIMITS.title),
    guarantee: finding.guarantee.trim().toUpperCase().slice(0, FINDING_LIMITS.guarantee),
    file: finding.file.trim().slice(0, FINDING_LIMITS.file),
    code: clip(finding.code.replace(/^\n+|\s+$/g, ""), FINDING_LIMITS.code),
    reason: clip(finding.reason.trim(), FINDING_LIMITS.reason),
    severity: finding.severity.trim().toLowerCase().slice(0, FINDING_LIMITS.severity),
    quoteFound: false,
  }));
  const noteText = clip(notes.join("\n"), 4000);
  if (verdicts.length !== 1) {
    return { verdict: "invalid", findings: bounded, notes: noteText, problem: `expected exactly one VERDICT line, got ${verdicts.length}` };
  }
  // The first word decides; an echo of the template ("approve | flag") is invalid.
  const words: string[] = verdicts[0].match(/[a-z]+/g) ?? [];
  const verdict = words.includes("approve") && words.includes("flag") ? "" : words[0];
  if (verdict === "approve") {
    return bounded.length
      ? { verdict: "invalid", findings: bounded, notes: noteText, problem: "VERDICT approve together with FINDING blocks is contradictory" }
      : { verdict: "approve", findings: [], notes: noteText, problem: null };
  }
  if (verdict === "flag") {
    return { verdict: "flag", findings: bounded, notes: noteText, problem: bounded.length ? null : "VERDICT flag without a FINDING block" };
  }
  return { verdict: "invalid", findings: bounded, notes: noteText, problem: `unknown verdict: ${verdicts[0].slice(0, 40)}` };
}

// Marks whether a finding's quoted code actually occurs in the material the
// reviewer saw (whitespace-insensitive, diff prefixes ignored). A quote that is
// not found is shown to the operator as such; it never changes the verdict.
export function verifyQuotes(answer: UpdateReviewAnswer, prompt: string): UpdateReviewAnswer {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const begin = prompt.indexOf("\nBEGIN_REVIEW_DATA ");
  const end = prompt.lastIndexOf("\nEND_REVIEW_DATA ");
  const material = begin >= 0 && end > begin ? prompt.slice(begin, end) : "";
  const haystack = normalize(material.split("\n").map((line) => line.replace(/^[+\- ]/, "")).join("\n"));
  const findings = answer.findings.map((finding) => {
    // Models often escape quotes inside a quote (\" for "); that is not a different line.
    const quoted = finding.code.split("\n")
      .map((line) => normalize(line.replace(/^\s*[+-]?\s?/, "").replace(/\\(["'])/g, "$1")))
      .filter((line) => line.length >= 8 && !/^\.{3}|^\[\.\.\./.test(line));
    return { ...finding, quoteFound: quoted.length > 0 && quoted.every((line) => haystack.includes(line)) };
  });
  return { ...answer, findings };
}

function describeFinding(finding: UpdateReviewFinding): string {
  return clip([
    `FINDING [${finding.guarantee || "?"}, ${finding.severity || "?"}]: ${finding.title || "(untitled)"}`,
    `FILE: ${finding.file || "(not given)"}`,
    `REASON: ${finding.reason || "(not given)"}`,
    `CODE (quoted by the reviewer; ${finding.quoteFound ? "found" : "NOT found"} in the reviewed diff):`,
    finding.code || "(no code quoted)",
  ].join("\n"), EVIDENCE_ITEM_LIMIT);
}

// Operator-facing stop reasons and evidence of one review. An empty `reasons`
// list means the review let the update through.
export function updateReviewFindings(outcome: UpdateReviewOutcome): { reasons: string[]; evidence: string[]; needed: string[] } {
  const reasons: string[] = [];
  const needed: string[] = [];
  const evidence = outcome.bindings.map((binding) =>
    `pre-install review of ${binding.sha.slice(0, 12)}: base ${binding.base.slice(0, 12)}, diff sha256 ${binding.diffSha256}`);
  if (outcome.unavailable) {
    reasons.push(`the review input is unavailable (${outcome.unavailable.slice(0, 300)})`);
    evidence.push(`review input unavailable: ${outcome.unavailable.slice(0, 600)}`);
    needed.push(`Inspect the commit yourself (or retry once ${UPDATE_KINDS[kindOf(outcome.kind)].diffAction} works); approving installs it without a completed code review.`);
  }
  const incomplete = outcome.coverage.filter((item) => item.incomplete.length > 0);
  if (incomplete.length > 0) {
    const count = incomplete.reduce((sum, item) => sum + item.incomplete.length, 0);
    reasons.push(`the review input is incomplete: ${count} focus-area or deploy file(s) were not fully visible to the reviewer`);
    for (const item of incomplete) {
      evidence.push(`not fully reviewed (${item.sha.slice(0, 12)}): ${item.incomplete.slice(0, 30).join(", ")}${item.incomplete.length > 30 ? ", ..." : ""}`);
    }
    needed.push("Review the listed files of the diff yourself before approving.");
  }
  if (outcome.reviewerError) {
    reasons.push(`the reviewer did not answer (${outcome.reviewerError.slice(0, 300)})`);
    evidence.push(`reviewer failure: ${outcome.reviewerError.slice(0, 600)}`);
    needed.push("Review the diff yourself or retry the job once the reviewer is available.");
  }
  const answer = outcome.answer;
  if (answer?.verdict === "invalid") {
    reasons.push(`the reviewer's answer could not be parsed (${answer.problem})`);
    evidence.push(`reviewer answer unparseable: ${answer.problem}`);
    needed.push("Review the diff yourself or retry the job.");
  }
  if (answer?.verdict === "flag") {
    reasons.push(`the reviewer flagged ${answer.findings.length || "an unspecified"} finding(s)${answer.findings.length ? `: ${answer.findings.map((finding) => finding.title || "(untitled)").join("; ").slice(0, 400)}` : ""}`);
    if (answer.problem) evidence.push(`reviewer answer: ${answer.problem}`);
    needed.push("Read each finding with its quoted code against the reviewed diff, then approve or reject this update.");
  }
  if (answer) evidence.push(`pre-install review verdict: ${answer.verdict}`);
  if (answer && answer.verdict !== "approve") evidence.push(...answer.findings.slice(0, 8).map(describeFinding));
  return { reasons, evidence, needed };
}

// Folds the review into the plan policy. A stop turns an allowed plan into
// blocked_user_approval; a plan that is already blocked keeps its status and
// gains the review's reasons and evidence.
export function applyUpdateReviewPolicy<P extends ReviewedPolicy>(policy: P, outcome: UpdateReviewOutcome): P {
  const { reasons, evidence, needed } = updateReviewFindings(outcome);
  if (reasons.length === 0) return { ...policy, evidence: [...policy.evidence, ...evidence] };
  const reason = `The pre-install review of ${UPDATE_KINDS[kindOf(outcome.kind)].subject} stopped for the operator: ${reasons.join("; ")}.`;
  if (policy.allowed) {
    return { ...policy, zone: "red", allowed: false, status: "blocked_user_approval", reason, evidence: [...policy.evidence, ...evidence], neededToContinue: needed };
  }
  return { ...policy, reason: `${policy.reason} ${reason}`, evidence: [...policy.evidence, ...evidence], neededToContinue: [...policy.neededToContinue, ...needed] };
}

export function updateBindings(diffs: UpdateDiff[]): UpdateBinding[] {
  // A self-update binding keeps its original shape; only other repositories carry their kind.
  return diffs.map((diff) => ({ ...kindField(diff.kind), base: diff.base, sha: diff.sha, diffSha256: diff.diffSha256 }));
}

export function normalizeUpdateBindings(value: unknown): UpdateBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const binding = item as Record<string, unknown>;
    return typeof binding.base === "string" && SHA.test(binding.base) && typeof binding.sha === "string" && SHA.test(binding.sha)
      && typeof binding.diffSha256 === "string" && DIFF_HASH.test(binding.diffSha256)
      ? [{ ...kindField(binding.kind), base: binding.base, sha: binding.sha, diffSha256: binding.diffSha256 }] : [];
  });
}

// Envelope evidence items: the signed envelope carries the digest of exactly
// the reviewed (base, sha, diffSha256).
export function updateReviewEvidence(bindings: UpdateBinding[]): UntrustedEvidence[] {
  return bindings.map((binding) => ({
    source: `${UPDATE_KINDS[kindOf(binding.kind)].evidencePrefix}:${binding.sha}`,
    content: JSON.stringify({ base: binding.base, sha: binding.sha, diffSha256: binding.diffSha256 }),
  }));
}

// The reviewed diff hash the broker receives with `self.update <target>`.
// null: no review was bound for this commit (its input was unavailable).
// Throws when the stored binding is missing or differs from the one the
// signed envelope carries.
export function reviewedDiffFor(target: string, envelope: ExecutionEnvelope, bindings: UpdateBinding[], kind: UpdateKind = "self"): string | null {
  const binding = bindings.find((item) => item.sha === target && kindOf(item.kind) === kind);
  if (!binding) {
    if (envelope.evidence.some((entry) => entry.source === `${UPDATE_KINDS[kind].evidencePrefix}:${target}`)) {
      throw new Error(`the reviewed diff record of ${target} is missing from the job`);
    }
    return null;
  }
  const [item] = updateReviewEvidence([binding]);
  const bound = envelope.evidence.some((entry) =>
    entry.source === item.source && entry.digest === hashCanonical(item.content) && entry.length === item.content.length);
  if (!bound) throw new Error(`the reviewed diff of ${target} is not bound to the execution envelope`);
  return binding.diffSha256;
}

// What the job keeps: the decision and its grounds, not the excerpt.
export function summarizeUpdateReview(diffs: UpdateDiff[], outcome: UpdateReviewOutcome, reviewPath: string | null): Record<string, unknown> {
  return {
    kind: kindOf(outcome.kind),
    reviewPath,
    bindings: outcome.bindings,
    updates: diffs.map((diff) => ({
      sha: diff.sha, base: diff.base, baseSource: diff.baseSource, diffSha256: diff.diffSha256, commitSubject: diff.commitSubject,
      filesTotal: diff.filesTotal, runnerTruncated: diff.truncated,
      focusAreas: diff.focusAreas.map((area) => ({ kind: area.kind, guarantees: area.guarantees, reason: area.reason, files: area.files.slice(0, 50) })),
    })),
    coverage: outcome.coverage,
    unavailable: outcome.unavailable || null,
    reviewerError: outcome.reviewerError || null,
    verdict: outcome.answer?.verdict ?? null,
    problem: outcome.answer?.problem ?? null,
    findings: outcome.answer?.findings ?? [],
    notes: outcome.answer?.notes ?? "",
  };
}

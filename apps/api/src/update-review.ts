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
  updateReviewPassNotice,
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
// The operator is asked only for a finding (VERDICT flag with a finding that
// is not UNVERIFIABLE). Everything else that keeps the review from a judgement
// on complete material stops the job without an approval offer
// (blocked_prerequisite, for the agent): the review input is unavailable or
// incomplete (a focus-area file or any changed file that is not documentation
// did not reach a review pass completely), the reviewer failed,
// its answer does not parse, or it flagged only UNVERIFIABLE points. Touching a
// focus area is never a stop by itself. See applyUpdateReviewPolicy.
//
// The same review guards a second repository: `dienste.update <sha>` installs a
// merged commit of server-dienste (the root supervisor that runs James' Docker
// services). Its runner answers `dienste.diff`, its reviewer gets the
// supervisor's own guarantees (D1-D8), and its bindings carry their own
// evidence source, so a review of one repository never unlocks the other.

// Bytes of one reviewer prompt (one review pass). Stays below the agent broker's
// safety-role bounds (100,000 characters, 120,000 bytes: one argv element).
export const UPDATE_REVIEW_PROMPT_LIMIT = 96_000;
const FILE_LIST_BUDGET = 8_000;
const NAME_LIST_BUDGET = 500;
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
  // Changed files that never run, build or install anything on the host. They
  // come last in the material and may be cut for the budget; every other
  // changed file must reach the reviewer completely in one pass, or the review
  // stops.
  supplementary: (path: string) => boolean;
}

// Documentation and agent instructions (markdown) and the npm lockfile, whose
// package changes the runner summarizes as the G8 package list. Markdown under
// bin/ is not documentation: the runbook plans there (bin/gen-*.md) are read
// at runtime (safety-review.ts). Tests are not supplementary since the review
// runs in passes (12.10.2026): only documentation may be cut.
const DOCS_AND_LOCKFILES = /^(?!bin\/)(?:.*\.(?:md|markdown)$|(?:.*\/)?package-lock\.json$)/i;

export const UPDATE_KINDS: Record<UpdateKind, UpdateKindSpec> = {
  self: {
    diffAction: "self.diff", updateAction: "self.update", evidencePrefix: "self-update-review",
    instructions: UPDATE_REVIEW_INSTRUCTIONS, subject: "the new Cockpit code",
    supplementary: (path) => DOCS_AND_LOCKFILES.test(path),
  },
  dienste: {
    diffAction: "dienste.diff", updateAction: "dienste.update", evidencePrefix: "dienste-update-review",
    instructions: DIENSTE_REVIEW_INSTRUCTIONS, subject: "the new server-dienste stand (root supervisor)",
    supplementary: (path) => DOCS_AND_LOCKFILES.test(path),
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
  // Files the reviewer had to see completely and did not (focus-area files and
  // every changed file that is not supplementary): a deterministic stop.
  incomplete: string[];
  // Files cut or left out of the prompt (focus or not), for the record.
  cut: string[];
  omitted: string[];
  // The files of each review pass of this update, in pass order.
  passes?: string[][];
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

// Material that runs as root on the host or goes into the service images: the
// deploy tree (installer, root helpers, systemd units, sudoers sources), the
// helper copies under ops/, Dockerfiles, compose files, systemd units anywhere
// and the npm manifests. It comes first, so it lands complete in the first
// review pass. The runner orders its sections by file class, which put
// deploy/vps/vps-cockpit-deploy.sh behind tests and docs in the rollout review
// of 28.09.2026, and Dockerfile.api in the review of cba7628 (11.10.2026).
const SECURITY_MATERIAL = /^(?:deploy|ops)\/|(?:^|\/)(?:Dockerfile[^/]*|(?:docker-)?compose[^/]*\.ya?ml|package\.json)$|\.(?:service|timer|socket|path)$|(?:^|\/)sudoers(?:\.d)?\//;
// The npm lockfile: summarized by the runner as the G8 package list, shown
// whole when it fits a pass.
const LOCKFILE = /(?:^|\/)package-lock\.json$/;

// The diff sections in review order: root and build material first, then the
// lockfile, then every other file the review must see, supplementary files
// (documentation) last; stable inside each group, so a focus area still
// precedes the rest.
export function materialOrder(sections: UpdateDiffSection[], supplementary: (path: string) => boolean = () => false): UpdateDiffSection[] {
  const group = (path: string) => SECURITY_MATERIAL.test(path) ? 0 : LOCKFILE.test(path) ? 1 : supplementary(path) ? 3 : 2;
  return [0, 1, 2, 3].flatMap((rank) => sections.filter((section) => group(section.path) === rank));
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// A file list of the excerpt's state line inside NAME_LIST_BUDGET bytes.
function nameList(names: string[]): string {
  if (names.length === 0) return "none";
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    if (used + bytes(name) + 2 > NAME_LIST_BUDGET - 40) break;
    shown.push(name);
    used += bytes(name) + 2;
  }
  const rest = names.length - shown.length;
  return rest > 0 ? `${[...shown, `... (${rest} more)`].join(", ")}` : shown.join(", ");
}

function backtickRun(text: string): number {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function fence(text: string): string {
  return "`".repeat(backtickRun(text) + 1);
}

function clipBytes(text: string, limit: number, note: string): string {
  if (bytes(text) <= limit) return text;
  const room = Buffer.from(text, "utf8").subarray(0, Math.max(0, limit - bytes(note) - 1)).toString("utf8").replace(/�+$/, "");
  return `${room.slice(0, Math.max(0, room.lastIndexOf("\n")))}\n${note}`;
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

// At most this many reviewer calls per job. The runner caps its excerpt at
// 200 KB, which fills about three passes.
export const UPDATE_REVIEW_MAX_PASSES = 5;
// Per pass: the pass notice and the state line (two name lists each), the
// headings and the fence lines.
const PASS_FRAME = 1200 + 4 * NAME_LIST_BUDGET;

interface ReviewPass {
  update: number;
  paths: string[];
  texts: string[];
  used: number;
  fenceLength: number;
}

// The reviewer prompts of one review: one or more passes, each inside the
// budget. Every pass carries the instruction block, the update's description
// (focus areas, file list, stat) and complete diff sections of a part of its
// files, inside nonce-marked data markers. Sections are placed whole in review
// order (root and build material first) into the first pass with room; a
// section that fits no open pass opens the next one. So every changed file
// reaches the reviewer completely in exactly one pass, and the answers of all
// passes are united (mergeUpdateReviewAnswers).
//
// Only the kind's supplementary files (documentation) may be cut: they fill the
// room the other material leaves and never open a pass of their own. Every
// other file (and every focus-area file) that does not reach a pass completely
// — larger than a whole pass, beyond the pass limit, cut or left out by the
// runner, or not listed at all — is incomplete coverage: a deterministic stop
// before any reviewer's answer counts, never a gap the reviewer has to guess at.
export function buildUpdateReviewPasses(diffs: UpdateDiff[], options: { nonce?: string; limit?: number; maxPasses?: number } = {}): { prompts: string[]; coverage: UpdateReviewCoverage[] } {
  const nonce = options.nonce || randomBytes(8).toString("hex");
  const limit = options.limit ?? UPDATE_REVIEW_PROMPT_LIMIT;
  const maxPasses = options.maxPasses ?? UPDATE_REVIEW_MAX_PASSES;
  // One reviewer, one set of guarantees: a prompt never mixes repositories.
  const kinds = new Set(diffs.map((diff) => kindOf(diff.kind)));
  if (kinds.size > 1) throw new Error("one review covers one repository; the plan mixes self.update and dienste.update");
  const spec = UPDATE_KINDS[kindOf(diffs[0]?.kind)];
  const head = [spec.instructions, "", updateReviewDataNotice(nonce), "", `BEGIN_REVIEW_DATA ${nonce}`].join("\n");
  const tail = [`END_REVIEW_DATA ${nonce}`, "", updateReviewClosingReminder(nonce)].join("\n");
  const room = limit - bytes(head) - bytes(tail);
  const passes: ReviewPass[] = [];
  const coverage: UpdateReviewCoverage[] = [];
  const descriptions: string[] = [];
  diffs.forEach((diff, index) => {
    // The description goes into every pass of its update and takes at most
    // half of a pass's room; a mass change of focus files or packages is clipped there,
    // and the clip is incomplete coverage.
    const full = describeUpdate(diff, index, diffs.length);
    const description = clipBytes(full, Math.max(0, Math.floor((room - PASS_FRAME) / 2)), "[... update description clipped for the review budget ...]");
    descriptions.push(description);
    const capacity = room - bytes(description) - PASS_FRAME;
    const focus = focusFiles(diff);
    const supplementary = (path: string) => !focus.has(path) && spec.supplementary(path);
    const own: ReviewPass[] = [];
    const complete = new Set<string>();
    const shown = new Set<string>();
    const cut: string[] = [];
    const omitted: string[] = [...diff.omittedFiles];
    const skipped: UpdateDiffSection[] = [];
    // A pass's fence (twice in the block) outgrows any backtick run in it.
    const fenceCost = (fenceLength: number, text: string) => 2 * Math.max(0, backtickRun(text) + 1 - fenceLength);
    const fits = (pass: ReviewPass, text: string) => pass.used + bytes(text) + fenceCost(pass.fenceLength, text) <= capacity;
    const open = (): ReviewPass | null => {
      if (passes.length + own.length >= maxPasses) return null;
      const pass: ReviewPass = { update: index, paths: [], texts: [], used: 0, fenceLength: 3 };
      own.push(pass);
      return pass;
    };
    const place = (pass: ReviewPass, path: string, text: string) => {
      pass.used += bytes(text) + fenceCost(pass.fenceLength, text);
      pass.fenceLength = Math.max(pass.fenceLength, backtickRun(text) + 1);
      pass.texts.push(text);
      pass.paths.push(path);
      shown.add(path);
    };
    for (const section of materialOrder(diff.excerpt, supplementary)) {
      const text = redactSecrets(section.text.endsWith("\n") ? section.text : `${section.text}\n`);
      const optional = supplementary(section.path);
      const alone = bytes(text) + fenceCost(3, text) <= capacity;
      // Documentation never opens a pass of its own (the lockfile may).
      const mayOpen = alone && (!optional || LOCKFILE.test(section.path) || own.length === 0);
      const pass = own.find((item) => fits(item, text)) ?? (mayOpen ? open() : null);
      if (pass) {
        place(pass, section.path, text);
        if (diff.partialFiles.includes(section.path)) continue;
        // git shows a binary file only by name: complete for an ordinary file,
        // never for a focus-area file.
        if (!focus.has(section.path) || !/^Binary files /m.test(text)) complete.add(section.path);
        continue;
      }
      if (!optional) {
        // Never cut into pieces the reviewer would have to guess at: left out,
        // and that stops the review.
        omitted.push(section.path);
        continue;
      }
      skipped.push({ path: section.path, text });
    }
    // Documentation that fits nowhere whole: after everything else, cut into
    // the pass with the most room.
    for (const { path, text } of skipped) {
      const note = `\n[... ${path} truncated for the review budget ...]\n`;
      const target = own.reduce<ReviewPass | null>((best, item) => !best || item.used < best.used ? item : best, null) ?? open();
      const usable = target ? capacity - target.used - bytes(note) - fenceCost(target.fenceLength, text) : 0;
      if (target && usable > 1024) {
        const kept = Buffer.from(text, "utf8").subarray(0, usable - 200).toString("utf8").replace(/\uFFFD+$/, "");
        place(target, path, `${kept.slice(0, Math.max(0, kept.lastIndexOf("\n")))}${note}`);
        cut.push(path);
      } else {
        omitted.push(path);
      }
    }
    // An update without excerpt sections still gets its description reviewed.
    if (own.length === 0) open();
    passes.push(...own);
    // Files the review must see completely: every focus-area file and every
    // changed file that is not supplementary — whether the runner sent a
    // section, cut it, left it out or did not list the file at all.
    const required = [...new Set([...focus, ...diff.files.map((file) => file.path).filter((path) => !supplementary(path))])];
    // git can show one path in two sections (a type change: symlink to file);
    // a path is complete only when none of its sections was cut or left out.
    const lost = new Set([...omitted, ...cut, ...diff.partialFiles]);
    for (const path of lost) complete.delete(path);
    const incomplete = required.filter((file) => !complete.has(file)).sort();
    const unlisted = Math.max(0, diff.filesTotal - diff.files.length);
    if (unlisted > 0) incomplete.push(`(${unlisted} changed file(s) the runner did not list)`);
    if (own.length === 0) incomplete.push(`(no review pass left for this update: at most ${maxPasses} passes)`);
    if (description !== full) incomplete.push("(the update description: focus areas or file list clipped)");
    // cut: partially in a pass (by the runner or here); omitted: not at all.
    const cutFiles = [...new Set([...diff.partialFiles.filter((file) => shown.has(file)), ...cut])];
    const missing = required.filter((path) => !complete.has(path) && !cutFiles.includes(path));
    const omittedFiles = [...new Set([...omitted, ...missing])];
    coverage.push({ sha: diff.sha, incomplete, cut: cutFiles, omitted: omittedFiles, passes: own.map((pass) => pass.paths) });
  });
  const prompts = passes.map((pass, number) => {
    const item = coverage[pass.update];
    // Required files are named first; the full lists stay in the coverage.
    const named = [...item.omitted.filter((path) => item.incomplete.includes(path)), ...item.omitted.filter((path) => !item.incomplete.includes(path))];
    const state = item.cut.length || item.omitted.length
      ? `The excerpt is INCOMPLETE. Cut: ${nameList(item.cut)}. Left out: ${nameList(named)}.`
      : "The excerpt is complete (every changed file's diff section is included; lockfiles are summarized above).";
    const elsewhere = passes.filter((other) => other.update === pass.update && other !== pass).flatMap((other) => other.paths);
    const notice = passes.length > 1
      ? ["", "## Review pass", updateReviewPassNotice(number + 1, passes.length, nameList(pass.paths), nameList(elsewhere))]
      : [];
    const excerpt = pass.texts.join("");
    const marker = fence(excerpt);
    const block = [descriptions[pass.update], ...notice, "", "## Diff excerpt", state, `${marker}diff`, excerpt.trimEnd(), marker].join("\n");
    return [head, block, tail].join("\n");
  });
  return { prompts, coverage };
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

// The answers of all review passes as one: the union of their findings. One
// flag makes the whole a flag (findings of every pass, also of an unparseable
// one); an unparseable pass beside it is named as the problem (a gap for
// updateReviewFindings). Without a flag, one unparseable pass makes the whole
// unparseable; approve only when every answered pass approved. A pass whose
// reviewer failed is null here (the caller records the failure as
// reviewerError); null when no pass answered.
export function mergeUpdateReviewAnswers(answers: Array<UpdateReviewAnswer | null>): UpdateReviewAnswer | null {
  const answered = answers.flatMap((answer, index) => answer ? [{ answer, label: `pass ${index + 1}/${answers.length}` }] : []);
  if (answered.length === 0) return null;
  if (answers.length === 1) return answered[0].answer;
  // Evidenced findings first, so the bound never drops one behind UNVERIFIABLE points.
  const all = answered.flatMap(({ answer }) => answer.findings);
  const findings = [...all.filter((finding) => !unverifiable(finding)), ...all.filter(unverifiable)].slice(0, 30);
  const notes = clip(answered.flatMap(({ answer, label }) => answer.notes ? [`${label}: ${answer.notes}`] : []).join("\n"), 4000);
  const problems = answered.flatMap(({ answer, label }) => answer.verdict !== "approve" && answer.problem ? [`${label}: ${answer.problem}`] : []);
  if (answered.some(({ answer }) => answer.verdict === "flag")) return { verdict: "flag", findings, notes, problem: problems.join("; ") || null };
  if (answered.some(({ answer }) => answer.verdict === "invalid")) return { verdict: "invalid", findings, notes, problem: problems.join("; ") };
  return { verdict: "approve", findings: [], notes, problem: null };
}

// Asks the reviewer pass by pass, one after the other (the reviewer's host is
// shared). A failed pass does not keep the others from answering, so a finding
// still reaches the operator; the failure is the reviewerError (a gap). Each
// quote is checked against the material of its own pass.
export async function runUpdateReviewPasses(prompts: string[], runner: (prompt: string) => Promise<string>): Promise<Pick<UpdateReviewOutcome, "answer" | "reviewerError">> {
  const answers: Array<UpdateReviewAnswer | null> = [];
  const errors: string[] = [];
  for (const [index, prompt] of prompts.entries()) {
    try {
      answers.push(verifyQuotes(parseUpdateReviewAnswer(redactSecrets(await runner(prompt))), prompt));
    } catch (error) {
      answers.push(null);
      const message = error instanceof Error ? error.message : "reviewer failed";
      errors.push(prompts.length === 1 ? message : `pass ${index + 1}/${prompts.length}: ${message}`);
    }
  }
  const answer = mergeUpdateReviewAnswers(answers);
  return { ...(answer ? { answer } : {}), ...(errors.length ? { reviewerError: errors.join("; ") } : {}) };
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

// What a review comes to (operator decision of 11.10.2026: the operator is
// asked only when a reviewer raises its hand):
// - pass: VERDICT approve on complete material. The update runs.
// - finding: the reviewer flagged at least one finding that is not
//   UNVERIFIABLE (a guarantee, INJECTION, or anything it did not label). It
//   always goes to the operator, also when the material was incomplete too.
// - incomplete: no judgement on complete material and no finding: the input
//   was unavailable or incomplete, the reviewer failed, its answer does not
//   parse, or it flagged nothing but UNVERIFIABLE (or no finding at all). That
//   is a fault of the tool chain for the agent to clear, never an approval
//   request: nothing is installed and nothing is offered for approval.
export type UpdateReviewResult = "pass" | "finding" | "incomplete";

function unverifiable(finding: UpdateReviewFinding): boolean {
  return /^UNVERIFIABLE\b/.test(finding.guarantee);
}

// Reasons, evidence and next steps of one review, split by what stops: a
// finding (for the operator) or a gap (for the agent).
export function updateReviewFindings(outcome: UpdateReviewOutcome): {
  result: UpdateReviewResult; findings: string[]; gaps: string[]; evidence: string[]; needed: string[];
} {
  const findings: string[] = [];
  const gaps: string[] = [];
  const needed: string[] = [];
  const evidence = outcome.bindings.map((binding) =>
    `pre-install review of ${binding.sha.slice(0, 12)}: base ${binding.base.slice(0, 12)}, diff sha256 ${binding.diffSha256}`);
  if (outcome.unavailable) {
    gaps.push(`the review input is unavailable (${outcome.unavailable.slice(0, 300)})`);
    evidence.push(`review input unavailable: ${outcome.unavailable.slice(0, 600)}`);
    needed.push(`Make ${UPDATE_KINDS[kindOf(outcome.kind)].diffAction} work again and submit the update again.`);
  }
  const incomplete = outcome.coverage.filter((item) => item.incomplete.length > 0);
  if (incomplete.length > 0) {
    const count = incomplete.reduce((sum, item) => sum + item.incomplete.length, 0);
    gaps.push(`the review input is incomplete: ${count} file(s) the reviewer must see completely were not fully visible to it`);
    for (const item of incomplete) {
      evidence.push(`not fully reviewed (${item.sha.slice(0, 12)}): ${item.incomplete.slice(0, 30).join(", ")}${item.incomplete.length > 30 ? ", ..." : ""}`);
    }
    needed.push("Fix the collection of the review material (or split the update) so that every listed file reaches the reviewer completely, then submit it again.");
  }
  if (outcome.reviewerError) {
    gaps.push(`the reviewer did not answer (${outcome.reviewerError.slice(0, 300)})`);
    evidence.push(`reviewer failure: ${outcome.reviewerError.slice(0, 600)}`);
    needed.push("Submit the update again once the reviewer is available.");
  }
  const answer = outcome.answer;
  if (answer?.verdict === "invalid") {
    gaps.push(`the reviewer's answer could not be parsed (${answer.problem})`);
    evidence.push(`reviewer answer unparseable: ${answer.problem}`);
    needed.push("Submit the update again.");
  }
  if (answer?.verdict === "flag") {
    const real = answer.findings.filter((finding) => !unverifiable(finding));
    const open = answer.findings.filter(unverifiable);
    if (real.length > 0) {
      findings.push(`the reviewer flagged ${real.length} finding(s): ${real.map((finding) => finding.title || "(untitled)").join("; ").slice(0, 400)}`);
      needed.push("Read each finding with its quoted code against the reviewed diff, then approve or reject this update.");
    } else {
      gaps.push(open.length > 0
        ? `the reviewer could not verify ${open.length} point(s) and found nothing else: ${open.map((finding) => finding.title || "(untitled)").join("; ").slice(0, 400)}`
        : "the reviewer flagged without a finding");
      needed.push("Clear why the reviewer could not judge the update (missing material is a fault of the collection, not a question for the operator), then submit it again.");
    }
    if (answer.problem) evidence.push(`reviewer answer: ${answer.problem}`);
    // A finding of one pass goes to the operator; a pass beside it without a
    // usable answer is named in the reason too.
    if (answer.problem && real.length > 0) gaps.push(`part of the review gave no usable answer (${answer.problem.slice(0, 300)})`);
  }
  if (answer) evidence.push(`pre-install review verdict: ${answer.verdict}`);
  if (answer && answer.verdict !== "approve") evidence.push(...answer.findings.slice(0, 8).map(describeFinding));
  // Pass is never the remainder: only VERDICT approve on complete material
  // passes. Anything else without a finding (no answer at all, too) is a gap.
  const approved = answer?.verdict === "approve" && gaps.length === 0;
  if (!approved && findings.length === 0 && gaps.length === 0) {
    gaps.push("the review produced no verdict");
    needed.push("Submit the update again.");
  }
  const result: UpdateReviewResult = findings.length > 0 ? "finding" : approved ? "pass" : "incomplete";
  evidence.push(`pre-install review result: ${result}`);
  return { result, findings, gaps, evidence, needed };
}

// Folds the review into the plan policy, after every plan check:
// - pass: the plan keeps its status (a plan block still stops).
// - finding: an allowed plan becomes blocked_user_approval; a blocked plan
//   keeps its status (an approval must never lift a prerequisite or policy
//   block) and gains the finding. The operator still learns of it: the job
//   records the result (summarizeUpdateReview) and GET /api/inbox lists it
//   under `reviewFindings`, which James forwards.
// - incomplete: blocked_prerequisite (zone red) — also over a plan that would
//   otherwise ask the operator, because an unreviewed update is never offered
//   for approval. Only blocked_policy, which nobody can approve either, stays.
export function applyUpdateReviewPolicy<P extends ReviewedPolicy>(policy: P, outcome: UpdateReviewOutcome): P {
  const { result, findings, gaps, evidence, needed } = updateReviewFindings(outcome);
  const merged = { ...policy, evidence: [...policy.evidence, ...evidence] };
  if (result === "pass") return merged;
  const subject = UPDATE_KINDS[kindOf(outcome.kind)].subject;
  const stillBlocked = (reason: string, status: P["status"]): P => policy.allowed
    ? { ...merged, zone: "red", allowed: false, status, reason, neededToContinue: needed }
    : { ...merged, status, reason: `${policy.reason} ${reason}`, neededToContinue: [...policy.neededToContinue, ...needed] };
  if (result === "finding") {
    const reason = `The pre-install review of ${subject} stopped for the operator: ${[...findings, ...gaps].join("; ")}.`;
    if (policy.allowed) return stillBlocked(reason, "blocked_user_approval");
    const blocked = stillBlocked(reason, policy.status);
    return { ...blocked, neededToContinue: [...blocked.neededToContinue, "Tell the operator about the review finding (GET /api/inbox lists it under reviewFindings); fixing the plan does not clear it."] };
  }
  const reason = `The pre-install review of ${subject} is incomplete, so nothing is installed and nothing is offered for approval: ${gaps.join("; ")}.`;
  return { ...stillBlocked(reason, policy.status === "blocked_policy" ? "blocked_policy" : "blocked_prerequisite"), zone: "red" };
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
    result: updateReviewFindings(outcome).result,
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

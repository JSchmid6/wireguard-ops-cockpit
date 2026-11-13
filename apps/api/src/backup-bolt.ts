// Backup bolt in the self-update (operator decision 12.11.2026, cards
// t_967ed75b, t_fcb051fa): merges and rollouts are James' decision, except a
// change to the backup bolt itself. A self-update whose installed diff changes
// the bolt therefore always waits for the operator (blocked_user_approval),
// also after the update review's pass and also with a verified second review.
// See doc/setup/self-update.md, „Backup bolt in the update“.
//
// This file is the one place that says what „the bolt“ is, and it is part of
// it: a diff that changes this list is a bolt change itself. The rule reads
// paths and code names in the diff, never plan or command text (operator
// decision 08.11.2026: no text filters).
//
// 1. Bolt files (BACKUP_BOLT_FILES): a changed, added or deleted file whose
//    path matches is a bolt change. The runner diffs with --no-renames, so a
//    rename names the old path too.
// 2. Places that ask the bolt (BACKUP_BOLT_SYMBOLS): files such as host-run.ts,
//    app.ts and update-review.ts also hold code outside the bolt (a hash pin,
//    the plan policy), so a path rule would be too wide there. A changed line
//    (+/-) or the function context of a hunk (`@@ … @@ <context>`) naming one
//    of these code names is a bolt change. A name counts also when written
//    with escapes (\u0048, \u{48}, \x48) or across a backslash line
//    continuation; JavaScript and TypeScript read those as the same name.
//    Documentation and lockfiles are not read for names, nor data files under
//    the test roots (TEST_ROOT); test code is read like any code.
// 3. Fail closed: a file the names rule must read and cannot (the runner cut
//    or left out its section, or clipped the file list) is reported as
//    unreadable; the update then stops for the agent and no second review lifts
//    that stop.
//
// Honest limit: a change that weakens an asking place without naming one of
// the symbols on a changed line or in its hunk context (for example only the
// condition around the call) is not seen here; that stays the reviewer's G10,
// and a G10 finding is never lifted by the second review (secondReviewStops).

export const BACKUP_BOLT_FILES: RegExp[] = [
  // The rules and their bounds (also any copy under ops/).
  /^(?:deploy\/helpers|ops)\/cockpit-backup-guard\./,
  /^(?:deploy\/helpers|ops)\/cockpit-borg-retention-rules\./,
  // Users of the retention bounds: Lab0's retention service (sudo entry and
  // logic) and the API's retention decisions.
  /^(?:deploy\/helpers|ops)\/cockpit-borg-retention(?:\.mjs)?$/,
  /^apps\/api\/src\/borg-retention\.ts$/,
  // The root helper asks the bolt at the start and on every resume.
  /^deploy\/helpers\/cockpit-host-run$/,
  // Code that creates, rotates or deletes backups or snapshots, with its bounds
  // (finding B1, card t_1621fa3e): the host snapshot (KEEP, removal in its
  // store, qm/pct delsnapshot of its name form), Lab0's self-update snapshot
  // (KEEP, removal loop), the hoster snapshot (rotation, delete), the backup
  // helper (also the quarter bound of `sources add`).
  /^deploy\/helpers\/cockpit-host-snapshot$/,
  /^deploy\/helpers\/cockpit-self-update-snapshot$/,
  /^ops\/cockpit-vps-snapshot$/,
  /^deploy\/helpers\/cockpit-borg-action$/,
  // The instance role decides which snapshot a mutating run takes first.
  /^deploy\/[^/]+\/instance-role\.env$/,
  // The units that run them (finding B3, card t_834fb98c): the prune/compact
  // run and its start time, and the lock drop-in that makes the nightly backup
  // wait for a running check instead of failing.
  /^deploy\/systemd\/cockpit-borg-retention\.(?:service|timer)$/,
  /^deploy\/systemd\/borgmatic-cockpit-borg-lock\.conf$/,
  // This list and the names below.
  /^apps\/api\/src\/backup-bolt\.ts$/,
];

export const BACKUP_BOLT_SYMBOLS: string[] = [
  // The bolt's decisions, asked in host-run.ts (policy) and app.ts (runHostRun).
  "backupGuardHits",
  "hostRunRisksNeedingApproval",
  // The G10 exception of the second review (update-review.ts).
  "SECOND_REVIEW_STOP_GUARANTEES",
  "stopsDespiteSecondReview",
  // This rule and where the update review applies it.
  "backupBoltChanges",
  "applyBackupBolt",
  "backupBolt",
];

const SYMBOL = new RegExp(`\\b(?:${BACKUP_BOLT_SYMBOLS.join("|")})\\b`);
// Tests that cannot ship (finding B1, cards t_834fb98c, t_a1e77c69,
// t_c8fc1f51): in the root test/ and in the test folders of packages that build
// only src/, only data stays unread (.json, .md, .txt, .sh). Code there is read
// like code, in every form: rootDir "src" only makes tsc refuse to import a
// .ts/.mts/.cts/.tsx from there (TS6059), and only tsc. JavaScript with a
// declaration file builds (a test/shim.mjs next to a test/shim.d.mts, the
// pattern host-run.ts uses for deploy/helpers), and the pinned Node (>= 22.18)
// loads .ts/.mts itself at run time (type stripping), so test/shim.mjs can
// re-export a test/impl.mts, and a computed `await import(p)` in src can reach
// a .ts directly. On Lab0 and box the API runs from the checkout, so test/ lies
// next to dist. Consequence: an update that changes a test naming the bolt
// (backup-bolt.test.ts) waits for the operator. A test/ folder or *.test.* file
// anywhere else — under src/, deploy/ or ops/ — is built or installed and is
// read like code as well. JSON imported with `with { type: "json" }` stays data.
const TEST_ROOT = /^(?:test|apps\/api\/test|packages\/[^/]+\/test)\//;
const TEST_ROOT_UNSHIPPED = /^[^/]*\.(?:json|md|txt|sh)$/;
// The exemption rests on how the packages build and load files. A diff that
// changes a tsconfig, jsconfig or package.json could change that (rootDir "..",
// include "../../test", allowJs, "imports"), so with such a file in the same
// update no test file is exempt.
const BUILD_CONFIG = /(?:^|\/)(?:[tj]sconfig[^/]*\.json|package\.json)$/;

function unshippedTest(path: string): boolean {
  return TEST_ROOT.test(path) && TEST_ROOT_UNSHIPPED.test(path.slice(path.lastIndexOf("/") + 1));
}

// Escapes JavaScript resolves in identifiers and string export names.
function unescapeNames(text: string): string {
  const char = (hex: string, raw: string) => {
    const code = Number.parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  };
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (raw, hex: string) => char(hex, raw))
    .replace(/\\u([0-9a-fA-F]{4})/g, (raw, hex: string) => char(hex, raw))
    .replace(/\\x([0-9a-fA-F]{2})/g, (raw, hex: string) => char(hex, raw));
}

export interface BackupBoltDiff {
  files: Array<{ path: string }>;
  filesTotal: number;
  excerpt: Array<{ path: string; text: string }>;
  partialFiles: string[];
  omittedFiles: string[];
}

export interface BackupBoltChange {
  // What changes the bolt: „<path>“ or „<path>: <symbol>“.
  changes: string[];
  // Files the names rule could not read completely.
  unreadable: string[];
}

export function isBackupBoltFile(path: string): boolean {
  return BACKUP_BOLT_FILES.some((pattern) => pattern.test(path));
}

// The code names a file section changes: on +/- lines after the first hunk
// header and in the hunk headers' function context. Each side of a hunk (old:
// context and -, new: context and +) is read in logical lines: a line ending in
// a backslash continues on the next one of the same side, and a logical line
// counts when one of its parts is a changed line.
function changedSymbols(text: string): string[] {
  const found = new Set<string>();
  const sides: Record<"-" | "+", { text: string; changed: boolean }> = {
    "-": { text: "", changed: false },
    "+": { text: "", changed: false },
  };
  const scan = (value: string) => {
    const match = unescapeNames(value).match(SYMBOL);
    if (match) found.add(match[0]);
  };
  const flush = (side: "-" | "+") => {
    if (sides[side].changed) scan(sides[side].text);
    sides[side] = { text: "", changed: false };
  };
  const push = (side: "-" | "+", line: string, changed: boolean) => {
    const logical = sides[side];
    logical.text += line;
    logical.changed ||= changed;
    // An odd number of trailing backslashes continues the line.
    if ((/\\*$/.exec(line)?.[0].length ?? 0) % 2 === 1) logical.text = logical.text.slice(0, -1);
    else flush(side);
  };
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      flush("-");
      flush("+");
      inHunk = true;
      scan(line.replace(/^@@[^@]*@@/, ""));
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) push("-", line.slice(1), true);
    else if (line.startsWith("+")) push("+", line.slice(1), true);
    else if (line.startsWith(" ")) {
      push("-", line.slice(1), false);
      push("+", line.slice(1), false);
    }
  }
  flush("-");
  flush("+");
  return [...found];
}

// `supplementary`: documentation and lockfiles (UPDATE_KINDS.self), which
// never run on the host and are not read for names.
export function backupBoltChanges(diffs: BackupBoltDiff[], supplementary: (path: string) => boolean): BackupBoltChange {
  const changes: string[] = [];
  const unreadable: string[] = [];
  const buildConfigChanged = diffs.some((diff) => diff.files.some(({ path }) => BUILD_CONFIG.test(path)));
  for (const diff of diffs) {
    if (diff.filesTotal > diff.files.length) unreadable.push(`file list clipped (${diff.files.length} of ${diff.filesTotal} files)`);
    for (const { path } of diff.files) {
      if (isBackupBoltFile(path)) {
        changes.push(path);
        continue;
      }
      if (supplementary(path) || (!buildConfigChanged && unshippedTest(path))) continue;
      const sections = diff.excerpt.filter((section) => section.path === path);
      if (sections.length === 0 || diff.partialFiles.includes(path) || diff.omittedFiles.includes(path)) {
        unreadable.push(path);
        continue;
      }
      for (const symbol of new Set(sections.flatMap((section) => changedSymbols(section.text)))) changes.push(`${path}: ${symbol}`);
    }
  }
  return { changes: [...new Set(changes)], unreadable: [...new Set(unreadable)] };
}

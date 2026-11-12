import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKUP_BOLT_SYMBOLS, backupBoltChanges, isBackupBoltFile, type BackupBoltDiff } from "../src/backup-bolt.js";
import { parseUpdateDiff, selfUpdateBackupBolt, UPDATE_KINDS } from "../src/update-review.js";

// Backup bolt in the update (operator decision 12.11.2026, card t_fcb051fa):
// which diffs change the bolt. The policy side is in update-review.test.ts.

function section(path: string, lines: string[]): { path: string; text: string } {
  return { path, text: `${[`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...lines].join("\n")}\n` };
}

function diff(sections: Array<{ path: string; text: string }>, overrides: Partial<BackupBoltDiff> = {}): BackupBoltDiff {
  const files = sections.map(({ path }) => ({ path }));
  return { files, filesTotal: files.length, excerpt: sections, partialFiles: [], omittedFiles: [], ...overrides };
}

const supplementary = UPDATE_KINDS.self.supplementary;
const check = (sections: Array<{ path: string; text: string }>, overrides: Partial<BackupBoltDiff> = {}) =>
  backupBoltChanges([diff(sections, overrides)], supplementary);

describe("backup bolt: which files and names are the bolt", () => {
  it("knows the bolt files and their ops copies, nothing else at the door", () => {
    for (const path of [
      "deploy/helpers/cockpit-backup-guard.mjs", "deploy/helpers/cockpit-backup-guard.d.mts",
      "deploy/helpers/cockpit-borg-retention-rules.mjs", "deploy/helpers/cockpit-borg-retention-rules.d.mts",
      "deploy/helpers/cockpit-borg-retention.mjs", "deploy/helpers/cockpit-borg-retention",
      "apps/api/src/borg-retention.ts", "deploy/helpers/cockpit-host-run", "apps/api/src/backup-bolt.ts",
      "ops/cockpit-backup-guard.mjs", "ops/cockpit-borg-retention-rules.mjs",
    ]) expect(isBackupBoltFile(path), path).toBe(true);
    for (const path of [
      "apps/api/src/host-run.ts", "apps/api/src/app.ts", "apps/api/src/update-review.ts",
      "deploy/helpers/cockpit-borg-action", "deploy/helpers/cockpit-state-steps.mjs", "deploy/helpers/cockpit-host-snapshot",
      "doc/setup/borg-retention.md", "apps/api/test/backup-guard.test.ts", "deploy/helpers/cockpit-borg-retention-x",
    ]) expect(isBackupBoltFile(path), path).toBe(false);
  });

  it("every bolt file the list names exists in this stand (no stale entry by typo)", () => {
    for (const path of ["deploy/helpers/cockpit-backup-guard.mjs", "deploy/helpers/cockpit-borg-retention-rules.mjs",
      "deploy/helpers/cockpit-borg-retention.mjs", "deploy/helpers/cockpit-borg-retention", "apps/api/src/borg-retention.ts",
      "deploy/helpers/cockpit-host-run", "apps/api/src/backup-bolt.ts"]) {
      expect(fs.existsSync(new URL(`../../../${path}`, import.meta.url)), path).toBe(true);
    }
  });

  it("every bolt symbol names real code in this stand", () => {
    const sources = ["apps/api/src/host-run.ts", "apps/api/src/app.ts", "apps/api/src/update-review.ts", "apps/api/src/backup-bolt.ts"]
      .map((path) => fs.readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")).join("\n");
    for (const symbol of BACKUP_BOLT_SYMBOLS) expect(sources, symbol).toMatch(new RegExp(`\\b${symbol}\\b`));
  });
});

describe("backup bolt: changes in a diff", () => {
  it("a changed bolt file is a bolt change, a deleted one too (--no-renames names both sides)", () => {
    expect(check([section("deploy/helpers/cockpit-backup-guard.mjs", ["@@ -1 +1 @@", "-a", "+b"])]).changes)
      .toEqual(["deploy/helpers/cockpit-backup-guard.mjs"]);
    const renamed = check([
      section("deploy/helpers/cockpit-backup-guard.mjs", ["deleted file mode 100644", "@@ -1 +0,0 @@", "-x"]),
      section("deploy/helpers/guard-new.mjs", ["new file mode 100644", "@@ -0,0 +1 @@", "+x"]),
    ]);
    expect(renamed.changes).toEqual(["deploy/helpers/cockpit-backup-guard.mjs"]);
    // Only the file list matters for a bolt file, even without its section.
    expect(check([], { files: [{ path: "deploy/helpers/cockpit-host-run" }], filesTotal: 1 }).changes).toEqual(["deploy/helpers/cockpit-host-run"]);
  });

  it("a changed line naming a place that asks the bolt is a bolt change (app.ts, host-run.ts, update-review.ts)", () => {
    const removedCall = section("apps/api/src/app.ts", [
      "@@ -2318,8 +2318,6 @@ export function buildApp(config: AppConfig) {",
      "     // Backup bolt (host-run.ts): the policy already stops such a run for the",
      "-    const backup = backupGuardHits(manifest);",
      "-    if (backup.length > 0 && !envelope.operatorApproved) throw new Error(\"x\");",
      "     const risks = 1;",
    ]);
    expect(check([removedCall]).changes).toEqual(["apps/api/src/app.ts: backupGuardHits"]);
    const g10 = section("apps/api/src/update-review.ts", ["@@ -1125 +1125 @@", "-export const SECOND_REVIEW_STOP_GUARANTEES = new Set([1, 2, 7, 10]);", "+export const SECOND_REVIEW_STOP_GUARANTEES = new Set([1, 2, 7]);"]);
    expect(check([g10]).changes).toEqual(["apps/api/src/update-review.ts: SECOND_REVIEW_STOP_GUARANTEES"]);
  });

  it("a change inside a bolt function counts through the hunk's function context", () => {
    const body = section("apps/api/src/update-review.ts", [
      "@@ -1130,4 +1130,4 @@ function stopsDespiteSecondReview(finding: UpdateReviewFinding): boolean {",
      "   if (unverifiable(finding)) return false;",
      "-  if (/\\bINJECTION\\b/.test(finding.guarantee)) return true;",
      "+  if (false) return true;",
    ]);
    expect(check([body]).changes).toEqual(["apps/api/src/update-review.ts: stopsDespiteSecondReview"]);
  });

  it("other code in the same files is no bolt change (e.g. the hash pin of PR #86)", () => {
    const pin = section("apps/api/src/host-run.ts", [
      "@@ -400,3 +400,4 @@ export function hostRunVisibleScripts(manifest: HostRunManifest): string[] {",
      "   const seen = new Set<string>();",
      "+  const pinned = sha256(text);",
      "   return [...seen];",
    ]);
    // Context lines naming a symbol are unchanged code.
    const context = section("apps/api/src/app.ts", ["@@ -10,3 +10,4 @@", "   const backup = backupGuardHits(manifest);", "+  const other = 1;"]);
    expect(check([pin, context])).toEqual({ changes: [], unreadable: [] });
  });

  it("tests and documentation are not read for names", () => {
    expect(check([
      section("apps/api/test/host-run.test.ts", ["@@ -1 +1 @@", "-backupGuardHits(a)", "+backupGuardHits(b)"]),
      section("doc/setup/self-update.md", ["@@ -1 +1 @@", "-hostRunRisksNeedingApproval", "+x"]),
      section("test/cockpit-host-run.test.sh", ["@@ -1 +1 @@", "-backupGuardHits", "+x"]),
    ])).toEqual({ changes: [], unreadable: [] });
  });

  it("a header line is not a changed line, a changed line beginning with -- is", () => {
    expect(check([section("apps/api/src/app.ts", ["@@ -1 +1 @@", "-x", "+y"])]).changes).toEqual([]);
    expect(check([section("apps/api/src/app.ts", ["@@ -1,2 +1 @@", "--- backupGuardHits", "+y"])]).changes).toEqual(["apps/api/src/app.ts: backupGuardHits"]);
  });

  it("fails closed: a code file without its whole section, or a clipped file list, is unreadable", () => {
    const app = section("apps/api/src/app.ts", ["@@ -1 +1 @@", "-x", "+y"]);
    expect(check([app], { partialFiles: ["apps/api/src/app.ts"] }).unreadable).toEqual(["apps/api/src/app.ts"]);
    expect(check([app], { omittedFiles: ["apps/api/src/app.ts"] }).unreadable).toEqual(["apps/api/src/app.ts"]);
    expect(check([], { files: [{ path: "apps/api/src/app.ts" }], filesTotal: 1 }).unreadable).toEqual(["apps/api/src/app.ts"]);
    expect(check([app], { filesTotal: 5 }).unreadable).toEqual(["file list clipped (1 of 5 files)"]);
    // Documentation left out of the excerpt is no gap.
    expect(check([], { files: [{ path: "README.md" }], filesTotal: 1 }).unreadable).toEqual([]);
  });

  it("real diffs: PR #83 (helper verb, guard unchanged) stays free, ad82dbf..cba7628 (root helper) is a bolt change", () => {
    const real = (name: string) => {
      const raw = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
      return parseUpdateDiff(raw, (JSON.parse(raw) as { sha: string }).sha);
    };
    expect(selfUpdateBackupBolt([real("self-diff-b9372e1-0d0edf42.json")])).toEqual({ changes: [], unreadable: [] });
    expect(selfUpdateBackupBolt([real("self-diff-ad82dbf-cba7628.json")])).toEqual({ changes: ["deploy/helpers/cockpit-host-run"], unreadable: [] });
  });
});

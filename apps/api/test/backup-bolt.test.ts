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
      // Code that creates, rotates or deletes backups or snapshots (finding B1, t_1621fa3e).
      "deploy/helpers/cockpit-host-snapshot", "deploy/helpers/cockpit-self-update-snapshot", "ops/cockpit-vps-snapshot",
      "deploy/helpers/cockpit-borg-action",
      "deploy/vps/instance-role.env", "deploy/lab0/instance-role.env", "deploy/box/instance-role.env",
      // The units that run them (finding B3, t_834fb98c).
      "deploy/systemd/cockpit-borg-retention.service", "deploy/systemd/cockpit-borg-retention.timer",
      "deploy/systemd/borgmatic-cockpit-borg-lock.conf",
    ]) expect(isBackupBoltFile(path), path).toBe(true);
    for (const path of [
      "apps/api/src/host-run.ts", "apps/api/src/app.ts", "apps/api/src/update-review.ts",
      "deploy/helpers/cockpit-state-steps.mjs", "deploy/helpers/cockpit-self-update-run",
      "doc/setup/borg-retention.md", "apps/api/test/backup-guard.test.ts", "deploy/helpers/cockpit-borg-retention-x",
      "deploy/helpers/cockpit-borg-action-x", "deploy/helpers/cockpit-host-snapshot.bak", "deploy/instance-role.env",
      "deploy/systemd/cockpit-borg-retention.service.bak", "deploy/systemd/borgmatic.service",
    ]) expect(isBackupBoltFile(path), path).toBe(false);
  });

  it("every bolt file the list names exists in this stand (no stale entry by typo)", () => {
    for (const path of ["deploy/helpers/cockpit-backup-guard.mjs", "deploy/helpers/cockpit-borg-retention-rules.mjs",
      "deploy/helpers/cockpit-borg-retention.mjs", "deploy/helpers/cockpit-borg-retention", "apps/api/src/borg-retention.ts",
      "deploy/helpers/cockpit-host-run", "apps/api/src/backup-bolt.ts",
      "deploy/helpers/cockpit-host-snapshot", "deploy/helpers/cockpit-self-update-snapshot", "ops/cockpit-vps-snapshot",
      "deploy/helpers/cockpit-borg-action",
      "deploy/vps/instance-role.env", "deploy/lab0/instance-role.env", "deploy/box/instance-role.env",
      "deploy/systemd/cockpit-borg-retention.service", "deploy/systemd/cockpit-borg-retention.timer",
      "deploy/systemd/borgmatic-cockpit-borg-lock.conf"]) {
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

  it("tests that cannot ship and documentation are not read for names", () => {
    expect(check([
      section("apps/api/test/host-run.test.ts", ["@@ -1 +1 @@", "-backupGuardHits(a)", "+backupGuardHits(b)"]),
      section("doc/setup/self-update.md", ["@@ -1 +1 @@", "-hostRunRisksNeedingApproval", "+x"]),
      section("test/cockpit-host-run.test.sh", ["@@ -1 +1 @@", "-backupGuardHits", "+x"]),
      section("packages/domain/test/x.test.ts", ["@@ -1 +1 @@", "-backupGuardHits", "+x"]),
    ])).toEqual({ changes: [], unreadable: [] });
  });

  // Finding B1 (second review t_f7369424, probe /opt/data/out/t_f7369424/):
  // apps/api builds src/**, so a shim under src/test/ ships. It redefined
  // backupGuardHits as a no-op, and app.ts changed only its `from` line; the old
  // test exemption (any test/ segment or .test. name) saw neither.
  it("a test-like file that ships (src/test/, src/*.test.*, deploy/, ops/) is read like code", () => {
    const appFrom = section("apps/api/src/app.ts", [
      "@@ -117,7 +117,7 @@ import {",
      "   verifyHostRunFindings,",
      "   type HostRunManifest,",
      "   type HostRunReviewOutcome,",
      "-} from \"./host-run.js\";",
      "+} from \"./test/host-run-shim.js\";",
    ]);
    const shim = (path: string) => section(path, [
      "new file mode 100644",
      "@@ -0,0 +1,3 @@",
      "+import type { BackupGuardHit } from \"../host-run.js\";",
      "+export * from \"../host-run.js\";",
      "+export function backupGuardHits(_m: unknown): BackupGuardHit[] { return []; }",
    ]);
    expect(check([appFrom, shim("apps/api/src/test/host-run-shim.ts")]))
      .toEqual({ changes: ["apps/api/src/test/host-run-shim.ts: backupGuardHits"], unreadable: [] });
    expect(check([shim("apps/api/src/host-run-shim.test.ts")]).changes).toEqual(["apps/api/src/host-run-shim.test.ts: backupGuardHits"]);
    for (const path of ["apps/api/src/tests/shim.ts", "apps/web/test/shim.ts", "apps/agent-broker/test/shim.mjs",
      "deploy/helpers/test/shim.mjs", "ops/x.test.mjs", "packages/domain/src/test/shim.ts"]) {
      expect(check([shim(path)]).changes, path).toEqual([`${path}: backupGuardHits`]);
    }
    // Fail closed there too: a shipping test file without its section is unreadable.
    expect(check([], { files: [{ path: "apps/api/src/test/host-run-shim.ts" }], filesTotal: 1 }).unreadable)
      .toEqual(["apps/api/src/test/host-run-shim.ts"]);
  });

  // Finding B1 rest (second review t_72eb02d2, probe /opt/data/out/t_72eb02d2/sonde/):
  // rootDir "src" stops only TypeScript sources. A shim as .mjs with a .d.mts
  // under a test root built with tsc rc=0, and backupGuardHits returned [] at
  // run time; app.ts changed only its `from` line.
  const sondeAppFrom = (specifier: string) => section("apps/api/src/app.ts", [
    "index c62d04daddd1bd2c201ab45c0fbb8d51cda62113..a00d8c174b47ceecc34bc91896bb20f862b47d5c 100644",
    "@@ -117,7 +117,7 @@ import {",
    "   verifyHostRunFindings,",
    "   type HostRunManifest,",
    "   type HostRunReviewOutcome,",
    "-} from \"./host-run.js\";",
    `+} from "${specifier}";`,
    " ",
    " interface AppOptions {",
    "   config?: AppConfig;",
  ]);
  const sondeShim = (dir: string, up: string) => [
    section(`${dir}/host-run-shim.d.mts`, [
      "new file mode 100644",
      "@@ -0,0 +1,3 @@",
      `+import type { BackupGuardHit } from "${up}apps/api/src/host-run.js";`,
      `+export * from "${up}apps/api/src/host-run.js";`,
      "+export declare function backupGuardHits(manifest: unknown): BackupGuardHit[];",
    ]),
    section(`${dir}/host-run-shim.mjs`, [
      "new file mode 100644",
      "@@ -0,0 +1,2 @@",
      `+export * from "${up}apps/api/dist/host-run.js";`,
      "+export function backupGuardHits() { return []; }",
    ]),
  ];

  it("a JavaScript shim with its declaration file under a test root is read like code (.mjs + .d.mts)", () => {
    for (const [dir, up, from] of [
      ["test", "../", "../../../test/host-run-shim.mjs"],
      ["apps/api/test", "../../../", "../test/host-run-shim.mjs"],
      ["packages/domain/test", "../../../", "../../../packages/domain/test/host-run-shim.mjs"],
    ]) {
      expect(check([sondeAppFrom(from), ...sondeShim(dir, up)]), dir).toEqual({
        changes: [`${dir}/host-run-shim.d.mts: backupGuardHits`, `${dir}/host-run-shim.mjs: backupGuardHits`],
        unreadable: [],
      });
    }
    // Every shape that can ship next to a declaration, and names without a known extension.
    for (const path of ["test/s.js", "test/s.cjs", "test/s.jsx", "test/s.d.ts", "test/s.d.cts", "test/s.d.json.ts",
      "apps/api/test/x/s.mjs", "packages/tmux-adapter/test/s.test.mjs", "test/s", "test/s.node"]) {
      expect(check([section(path, ["@@ -0,0 +1 @@", "+export function backupGuardHits() { return []; }"])]).changes, path)
        .toEqual([`${path}: backupGuardHits`]);
    }
    // Fail closed: such a file without its section is unreadable, not exempt.
    expect(check([], { files: [{ path: "test/host-run-shim.mjs" }], filesTotal: 1 }).unreadable).toEqual(["test/host-run-shim.mjs"]);
    // TypeScript sources and data under a test root stay unread: tsc refuses them (TS6059).
    for (const path of ["test/s.ts", "test/s.mts", "test/s.cts", "test/s.tsx", "apps/api/test/fixtures/x.json", "test/x.test.sh"]) {
      expect(check([section(path, ["@@ -1 +1 @@", "-backupGuardHits", "+x"])]).changes, path).toEqual([]);
    }
  });

  it("a tsconfig, jsconfig or package.json in the same update voids the test exemption", () => {
    const tsTest = section("test/host-run-shim.ts", ["@@ -0,0 +1 @@", "+export function backupGuardHits() { return []; }"]);
    expect(check([tsTest]).changes).toEqual([]);
    for (const config of ["apps/api/tsconfig.json", "packages/domain/tsconfig.json", "tsconfig.base.json",
      "apps/api/tsconfig.build.json", "apps/api/jsconfig.json", "package.json", "apps/api/package.json"]) {
      const widen = section(config, ["@@ -6 +6 @@", "-    \"rootDir\": \"src\"", "+    \"rootDir\": \"../..\""]);
      expect(check([widen, tsTest]).changes, config).toEqual(["test/host-run-shim.ts: backupGuardHits"]);
      // Also when the config sits in another diff of the same update.
      expect(backupBoltChanges([diff([widen]), diff([tsTest])], supplementary).changes, config)
        .toEqual(["test/host-run-shim.ts: backupGuardHits"]);
    }
  });

  it("a name written with escapes or across a line continuation is the same name", () => {
    for (const line of ["+export function backupGuard\\u0048its() { return []; }",
      "+export function \\u{62}ackupGuardHits() { return []; }",
      "+export { noop as \"backupGuard\\x48its\" };"]) {
      expect(check([section("apps/api/src/shim.ts", ["@@ -0,0 +1 @@", line])]).changes, line).toEqual(["apps/api/src/shim.ts: backupGuardHits"]);
    }
    const continued = section("apps/api/src/shim.mjs", ["@@ -0,0 +1,2 @@", "+export { noop as \"backupGuard\\", "+Hits\" };"]);
    expect(check([continued]).changes).toEqual(["apps/api/src/shim.mjs: backupGuardHits"]);
    // A changed line continued by an unchanged one counts, unchanged lines alone do not.
    const intoContext = section("apps/api/src/shim.mjs", ["@@ -1,2 +1,2 @@", "-export { noop as \"x\\", "+export { noop as \"backupGuard\\", " Hits\" };"]);
    expect(check([intoContext]).changes).toEqual(["apps/api/src/shim.mjs: backupGuardHits"]);
    const contextOnly = section("apps/api/src/shim.mjs", ["@@ -1,3 +1,3 @@", " const a = \"backupGuard\\", " Hits\";", "-x", "+y"]);
    expect(check([contextOnly]).changes).toEqual([]);
    // An escaped backslash does not continue the line.
    expect(check([section("apps/api/src/shim.mjs", ["@@ -0,0 +1,2 @@", "+const a = \"backupGuard\\\\", "+Hits\";"])]).changes).toEqual([]);
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

  // PR #83 added `sources add-large` to the backup helper with the guard
  // unchanged; since finding B1 (t_1621fa3e) the backup helper is a bolt file.
  it("real diffs: PR #83 (backup helper) and ad82dbf..cba7628 (root helper) are bolt changes", () => {
    const real = (name: string) => {
      const raw = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
      return parseUpdateDiff(raw, (JSON.parse(raw) as { sha: string }).sha);
    };
    expect(selfUpdateBackupBolt([real("self-diff-b9372e1-0d0edf42.json")])).toEqual({ changes: ["deploy/helpers/cockpit-borg-action"], unreadable: [] });
    expect(selfUpdateBackupBolt([real("self-diff-ad82dbf-cba7628.json")])).toEqual({ changes: ["deploy/helpers/cockpit-host-run"], unreadable: [] });
  });
});

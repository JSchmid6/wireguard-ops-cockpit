import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Harness für den Aufräum-Dienst (deploy/helpers/cockpit-borg-retention.mjs).
// Der Helfer läuft echt (gleiches Node); borg und systemctl sind Stubs, die ihre
// Aufrufe mitschreiben. Der borg-Stub hält das Repo als JSON-Datei: Archive mit
// id, Name und Zeit; prune behält die jüngsten keep_daily Archive.

// Jeder Fall startet den Helfer mehrmals als eigenen Node-Prozess (je ~0,5 s,
// unter Coverage mehr); die 5 s Vorgabe reichen dafür nicht.
vi.setConfig({ testTimeout: 60_000 });

const HELPER = fileURLToPath(new URL("../../../deploy/helpers/cockpit-borg-retention.mjs", import.meta.url));

let dir: string;
let repoFile: string;
let callsFile: string;

const id = (n: number) => n.toString(16).padStart(64, "0");
const archive = (n: number) => ({ id: id(n), name: `vmd61162-2026-09-${String(n).padStart(2, "0")}T00:37:11`, start: `2026-09-${String(n).padStart(2, "0")}T00:37:11.000000` });

function writeRepo(archives: Array<{ id: string; name: string; start: string }>, extra: Record<string, unknown> = {}) {
  writeFileSync(repoFile, JSON.stringify({ archives, ...extra }));
}
const readRepo = () => JSON.parse(readFileSync(repoFile, "utf8")) as { archives: Array<{ id: string; name: string }> };
const calls = (): string[][] => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const borgVerbs = () => calls().filter((call) => call[0] === "borg").map((call) => call[1]);

function stubs() {
  const borg = path.join(dir, "borg");
  writeFileSync(borg, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const repoFile = ${JSON.stringify(repoFile)};
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(["borg", ...args, "PASSCOMMAND=" + (process.env.BORG_PASSCOMMAND ? "set" : "missing"), "PASSPHRASE=" + (process.env.BORG_PASSPHRASE ? "set" : "none")]) + "\\n");
const repo = JSON.parse(fs.readFileSync(repoFile, "utf8"));
if (repo.fail === args[0]) { process.stderr.write("Failed to create/acquire the lock\\n"); process.exit(2); }
if (args[0] === "list" && repo.listFailsAfterPrune && repo.pruned) { process.stderr.write("Connection closed\\n"); process.exit(2); }
if (args[0] === "list") { process.stdout.write(JSON.stringify({ archives: repo.archives })); process.exit(0); }
if (args[0] === "prune") {
  const keep = Number(args[args.indexOf("--keep-daily") + 1]);
  const sorted = [...repo.archives].sort((a, b) => b.start.localeCompare(a.start));
  const removed = sorted.slice(keep);
  for (const [i, a] of removed.entries()) process.stderr.write("Pruning archive (" + (i + 1) + "/" + removed.length + "):  " + a.name + "  Sun, 2026-09-27 00:37:12 [" + a.id + "]\\n");
  const gone = new Set([...removed.map((a) => a.id), ...(repo.foreignDuringPrune || [])]);
  repo.archives = repo.archives.filter((a) => !gone.has(a.id));
  repo.pruned = true;
  fs.writeFileSync(repoFile, JSON.stringify(repo));
  process.exit(0);
}
if (args[0] === "compact") {
  if (repo.foreignDuringCompact) { const gone = new Set(repo.foreignDuringCompact); repo.archives = repo.archives.filter((a) => !gone.has(a.id)); delete repo.foreignDuringCompact; fs.writeFileSync(repoFile, JSON.stringify(repo)); }
  process.exit(0);
}
if (args[0] === "info") { process.stdout.write(JSON.stringify({ cache: { stats: { unique_csize: 1000, total_size: 5000 } } })); process.exit(0); }
process.exit(2);
`);
  chmodSync(borg, 0o755);
  const systemctl = path.join(dir, "systemctl");
  writeFileSync(systemctl, `#!/bin/sh
printf '%s\\n' "$(printf '"%s",' systemctl "$@" | sed 's/,$//; s/^/[/; s/$/]/')" >> ${JSON.stringify(callsFile)}
case "$1" in
  is-active) cat ${JSON.stringify(path.join(dir, "active"))} 2>/dev/null || echo inactive; exit 3 ;;
  list-timers) echo '[{"unit":"cockpit-borg-retention.timer","next":1790920800000000}]' ;;
esac
exit 0
`);
  chmodSync(systemctl, 0o755);
  return { borg, systemctl };
}

function hookEnv(extra: Record<string, string> = {}) {
  const { borg, systemctl } = stubs();
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    BORG_RETENTION_TEST: "1",
    BORG_RETENTION_CONFIG_DIR: path.join(dir, "etc"),
    BORG_RETENTION_STATE_DIR: path.join(dir, "state"),
    BORG_RETENTION_UNIT_DIR: path.join(dir, "units"),
    BORG_RETENTION_REPO: path.join(dir, "repo"),
    BORG_RETENTION_BORG: borg,
    BORG_RETENTION_SYSTEMCTL: systemctl,
    BORG_RETENTION_LOCK_WAIT: "1",
    ...extra,
  };
}

function helper(args: string[], extra: Record<string, string> = {}) {
  const out = spawnSync(process.execPath, [HELPER, ...args], { encoding: "utf8", env: hookEnv(extra), timeout: 30_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

// Der Lauf, wie ihn die Unit startet: mit ihrer Umgebung und der Credential.
const serviceRun = (extra: Record<string, string> = {}) => helper(["--im-dienst"], { COCKPIT_BORG_RETENTION_IN_UNIT: "1", CREDENTIALS_DIRECTORY: path.join(dir, "credentials"), ...extra });

const state = () => JSON.parse(readFileSync(path.join(dir, "state", "zustand.json"), "utf8"));
const runs = () => readFileSync(path.join(dir, "state", "laeufe.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const lastRun = () => runs().at(-1);
function status() {
  const out = helper(["status"]);
  expect(out.code).toBe(0);
  const marker = "== DATEN (cockpit-borg-retention/v1) ==\n";
  expect(out.stdout.startsWith(marker)).toBe(true);
  return JSON.parse(out.stdout.slice(marker.length));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "borg-retention-"));
  repoFile = path.join(dir, "repo.json");
  callsFile = path.join(dir, "calls.jsonl");
  for (const sub of ["state", "repo", "credentials", "units"]) mkdirSync(path.join(dir, sub));
  writeFileSync(path.join(dir, "credentials", "passphrase"), "geheim-nur-im-test\n", { mode: 0o600 });
  writeRepo([1, 2, 3, 4, 5].map(archive));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cockpit-borg-retention: the service run", () => {
  it("prunes on the first run, keeps the inventory as baseline and does not compact yet", () => {
    const out = serviceRun();
    expect(out.code, out.stderr).toBe(0);
    expect(borgVerbs()).toEqual(["list", "prune", "list", "info"]);
    const prune = calls().find((call) => call[1] === "prune")!;
    expect(prune).toEqual(expect.arrayContaining(["--glob-archives", "vmd61162-*", "--keep-daily", "3", "--keep-weekly", "2", path.join(dir, "repo")]));
    expect(prune).not.toContain("--keep-monthly");
    expect(readRepo().archives.map((item) => item.id)).toEqual([id(3), id(4), id(5)]);
    expect(state()).toMatchObject({ status: "ok", anomaly: null });
    expect(state().baseline.map((item: { id: string }) => item.id)).toEqual([id(3), id(4), id(5)]);
    expect(lastRun()).toMatchObject({ result: "ok", before: 5, after: 3, pruned: 2, compacted: false });
    expect(lastRun().compactSkipped).toMatch(/first run/);
  });

  it("compacts on the next run when nothing foreign is missing", () => {
    serviceRun();
    writeRepo([...readRepo().archives as never[], archive(6)]); // das nächtliche Backup kam dazu
    const out = serviceRun();
    expect(out.code, out.stderr).toBe(0);
    expect(borgVerbs().slice(4)).toEqual(["list", "prune", "list", "compact", "list", "info"]);
    expect(calls().find((call) => call[1] === "compact")).toEqual(expect.arrayContaining(["--lock-wait", "1"]));
    expect(lastRun()).toMatchObject({ result: "ok", before: 4, after: 3, pruned: 1, compacted: true });
    expect(state().repoStats).toMatchObject({ uniqueCompressedBytes: 1000, totalSizeBytes: 5000 });
  });

  it("hands the passphrase to borg only as a command that reads the credential", () => {
    serviceRun();
    for (const call of calls().filter((item) => item[0] === "borg")) {
      expect(call).toContain("PASSCOMMAND=set");
      expect(call).toContain("PASSPHRASE=none");
      expect(call.join(" ")).not.toContain("geheim-nur-im-test");
    }
    expect(readFileSync(path.join(dir, "state", "laeufe.jsonl"), "utf8")).not.toContain("geheim");
  });

  it("halts on archives it did not remove itself: no prune, no compact, status angehalten", () => {
    serviceRun();
    writeRepo([archive(4), archive(5), archive(6)]); // archive 3 is gone — someone else deleted it
    const out = serviceRun();
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/1 archive\(s\) missing that this service did not remove/);
    expect(borgVerbs().slice(4)).toEqual(["list"]);
    expect(state().status).toBe("angehalten");
    expect(state().anomaly).toMatchObject({ phase: "before-prune", count: 1, missing: [{ id: id(3), name: archive(3).name }] });
    expect(lastRun()).toMatchObject({ result: "anomalie", compacted: false });
    // …and stays halted on the next timer run, without touching the repository.
    const again = serviceRun();
    expect(again.code).toBe(3);
    expect(borgVerbs().slice(4)).toEqual(["list"]);
    expect(lastRun().result).toBe("angehalten");
  });

  it("halts when an archive was recreated under the same name", () => {
    serviceRun();
    writeRepo([archive(3), { ...archive(4), id: id(44) }, archive(5)]);
    expect(serviceRun().code).toBe(3);
    expect(state().anomaly.missing).toEqual([{ id: id(4), name: archive(4).name }]);
  });

  it("does not compact when an archive vanished during prune that prune did not name", () => {
    serviceRun();
    writeRepo([archive(3), archive(4), archive(5), archive(6)], { foreignDuringPrune: [id(5)] });
    const out = serviceRun();
    expect(out.code).toBe(3);
    expect(borgVerbs().slice(4)).toEqual(["list", "prune", "list"]);
    expect(state()).toMatchObject({ status: "angehalten", anomaly: { phase: "after-prune", count: 1, missing: [{ id: id(5) }] } });
    // Was prune selbst entfernt hat (Archiv 3), gilt nicht als fremd: nach der
    // Freigabe für Archiv 5 geht es weiter, ohne Schleife.
    expect(state().baseline.map((item: { id: string }) => item.id)).toEqual([id(4), id(5), id(6)]);
    expect(helper(["freigeben", state().anomaly.id]).code).toBe(0);
    const resumed = serviceRun();
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(lastRun()).toMatchObject({ result: "ok", compacted: true });
  });

  it("does not take its own prune for a foreign loss when the run breaks after prune", () => {
    serviceRun();
    // borg list nach prune scheitert: der Lauf endet mit Fehler …
    writeRepo([archive(3), archive(4), archive(5), archive(6)], { listFailsAfterPrune: true });
    expect(serviceRun().code).toBe(1);
    expect(readRepo().archives.map((item) => item.id)).toEqual([id(4), id(5), id(6)]);
    writeRepo(readRepo().archives as never[]);
    // … und der nächste Lauf hält Archiv 3 (selbst gepruned) nicht für fremd.
    const next = serviceRun();
    expect(next.code, next.stderr).toBe(0);
    expect(state().status).toBe("ok");
  });

  it("skips compact when the repository is busy right before it", () => {
    serviceRun();
    writeRepo(readRepo().archives as never[], { fail: "compact" });
    const out = serviceRun();
    expect(out.code, out.stderr).toBe(0);
    expect(lastRun()).toMatchObject({ result: "ok", compacted: false });
    expect(lastRun().compactSkipped).toMatch(/repository busy right before compact/);
    // Zweimal in Folge ist ein Fehler, kein grüner Lauf.
    const again = serviceRun();
    expect(again.code).toBe(1);
    expect(lastRun()).toMatchObject({ result: "fehler", compacted: false });
    expect(lastRun().note).toMatch(/two runs in a row/);
  });

  it("halts and says so when an archive vanished while compacting", () => {
    serviceRun();
    writeRepo(readRepo().archives as never[], { foreignDuringCompact: [id(4)] });
    const out = serviceRun();
    expect(out.code).toBe(3);
    expect(state()).toMatchObject({ status: "angehalten", anomaly: { phase: "after-compact", missing: [{ id: id(4) }] } });
  });

  it("goes on only with Jochen's approval for exactly the anomaly he saw", () => {
    serviceRun();
    writeRepo([archive(4), archive(5), archive(6)]);
    serviceRun();
    const anomaly = state().anomaly.id as string;
    expect(helper(["freigeben", "0123456789abcdef"]).code).toBe(77);
    expect(helper(["freigeben", "nicht-hex"]).code).toBe(64);
    writeFileSync(path.join(dir, "active"), "activating\n"); // der Dienst läuft gerade
    expect(helper(["freigeben", anomaly]).code).toBe(3);
    rmSync(path.join(dir, "active"));
    const approve = helper(["freigeben", anomaly]);
    expect(approve.code, approve.stderr).toBe(0);
    expect(JSON.parse(approve.stdout)).toMatchObject({ approved: anomaly, missing: 1, started: true });
    expect(calls()).toContainEqual(["systemctl", "start", "--no-block", "cockpit-borg-retention.service"]);
    const out = serviceRun();
    expect(out.code, out.stderr).toBe(0);
    expect(lastRun()).toMatchObject({ result: "ok", compacted: true });
    expect(state()).toMatchObject({ status: "ok", anomaly: null, approval: null });
    expect(readFileSync(path.join(dir, "state", "einstellungen.jsonl"), "utf8")).toContain(anomaly);
  });

  it("an approval does not cover further archives lost after it, a new one covers all", () => {
    serviceRun();
    writeRepo([archive(4), archive(5), archive(6)]);
    serviceRun();
    helper(["freigeben", state().anomaly.id]);
    writeRepo([archive(5), archive(6)]); // archive 4 vanished after the approval
    expect(serviceRun().code).toBe(3);
    // Die neue Anomalie nennt den ganzen Verlust gegen den Vergleichsstand …
    expect(state().anomaly.missing).toEqual([{ id: id(3), name: archive(3).name }, { id: id(4), name: archive(4).name }]);
    expect(borgVerbs()).not.toContain("compact");
    // … und ihre Freigabe führt weiter, ohne dass die erste wieder auftaucht.
    expect(helper(["freigeben", state().anomaly.id]).code).toBe(0);
    const resumed = serviceRun();
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(state()).toMatchObject({ status: "ok", anomaly: null });
  });

  it("runs the retention set in the cockpit, also monthly", () => {
    expect(helper(["set", "4", "2", "6", "07:15"]).code).toBe(0);
    serviceRun();
    const prune = calls().find((call) => call[1] === "prune")!;
    expect(prune).toEqual(expect.arrayContaining(["--keep-daily", "4", "--keep-weekly", "2", "--keep-monthly", "6"]));
  });

  it("refuses to run from outside its unit or without the passphrase", () => {
    expect(helper(["--im-dienst"]).code).toBe(67);
    const out = helper(["--im-dienst"], { COCKPIT_BORG_RETENTION_IN_UNIT: "1", CREDENTIALS_DIRECTORY: path.join(dir, "nirgends") });
    expect(out.code).toBe(78);
    expect(borgVerbs()).toEqual([]);
    expect(lastRun()).toMatchObject({ result: "fehler" });
  });

  it("deletes nothing when the stored retention is below the minimum without approval", () => {
    mkdirSync(path.join(dir, "etc"));
    writeFileSync(path.join(dir, "etc", "aufbewahrung.json"), JSON.stringify({ keepDaily: 1, keepWeekly: 0, keepMonthly: 0, time: "06:00", freigabe: false }));
    expect(serviceRun().code).toBe(77);
    expect(borgVerbs()).toEqual([]);
    expect(lastRun().result).toBe("abgelehnt");
  });

  it("reports a borg failure without changing the status", () => {
    serviceRun();
    writeRepo(readRepo().archives as never[], { fail: "prune" });
    const out = serviceRun();
    expect(out.code).toBe(1);
    expect(lastRun()).toMatchObject({ result: "fehler" });
    expect(lastRun().note).toMatch(/borg prune failed \(rc 2\)/);
    expect(state().status).toBe("ok");
  });
});

describe("cockpit-borg-retention: settings", () => {
  it("writes the setting, the timer drop-in and the log for a change inside the bounds", () => {
    const out = helper(["set", "7", "4", "6", "06:30"]);
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ vorher: { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" }, nachher: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, time: "06:30" }, freigabe: false });
    expect(JSON.parse(readFileSync(path.join(dir, "etc", "aufbewahrung.json"), "utf8"))).toMatchObject({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6, time: "06:30", freigabe: false });
    expect(readFileSync(path.join(dir, "units", "cockpit-borg-retention.timer.d", "uhrzeit.conf"), "utf8")).toContain("OnCalendar=\nOnCalendar=*-*-* 06:30:00\n");
    expect(calls()).toContainEqual(["systemctl", "daemon-reload"]);
    expect(calls()).toContainEqual(["systemctl", "try-restart", "cockpit-borg-retention.timer"]);
    expect(readFileSync(path.join(dir, "state", "einstellungen.jsonl"), "utf8")).toContain("\"freigabe\":false");
  });

  it("needs --freigabe below the minimum and refuses beyond the bounds", () => {
    expect(helper(["set", "2", "2", "0", "06:00"]).code).toBe(77);
    expect(existsSync(path.join(dir, "etc", "aufbewahrung.json"))).toBe(false);
    expect(helper(["set", "2", "2", "0", "06:00", "--freigabe"]).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "etc", "aufbewahrung.json"), "utf8"))).toMatchObject({ keepDaily: 2, freigabe: true });
    expect(helper(["set", "31", "2", "0", "06:00"]).code).toBe(65);
    expect(helper(["set", "0", "2", "0", "06:00", "--freigabe"]).code).toBe(65);
    expect(helper(["set", "3", "2", "0", "02:00"]).code).toBe(65);
    expect(helper(["set", "3", "2", "0"]).code).toBe(64);
    expect(helper(["prune"]).code).toBe(64);
  });

  it("reports settings, bounds, status, runs, inventory and space for the cockpit", () => {
    serviceRun();
    const report = status();
    expect(report).toMatchObject({
      version: "cockpit-borg-retention/v1",
      installed: { service: false, timer: false, passphrase: "missing" },
      settings: { keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00", source: "default" },
      bounds: { keepDaily: { floor: 1, min: 3, max: 30 } },
      timer: { next: "2026-10-02T06:00:00.000Z" },
      state: { status: "ok", anomaly: null },
      inventory: { count: 3 },
      repoStats: { uniqueCompressedBytes: 1000 },
    });
    expect(report.inventory.archives.map((item: { name: string }) => item.name)).toEqual([archive(5).name, archive(4).name, archive(3).name]);
    expect(report.runs).toHaveLength(1);
    expect(report.space.totalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("geheim");
  });

  it("checks that only root can read the passphrase file", () => {
    mkdirSync(path.join(dir, "etc"));
    writeFileSync(path.join(dir, "etc", "passphrase"), "x", { mode: 0o644 });
    expect(status().installed.passphrase).toBe("unsafe");
    chmodSync(path.join(dir, "etc", "passphrase"), 0o600);
    expect(status().installed.passphrase).toBe("ok");
  });

  it("starts the service run on request", () => {
    expect(helper(["run"]).code).toBe(0);
    expect(calls()).toContainEqual(["systemctl", "start", "--no-block", "cockpit-borg-retention.service"]);
  });
});

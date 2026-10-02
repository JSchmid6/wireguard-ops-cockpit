#!/opt/node-v20.19.1-linux-x64/bin/node
// cockpit-borg-retention — der Aufräum-Dienst für das borg-Repo auf Lab0
// (doc/setup/borg-retention.md).
//
// Der VPS sichert nur noch (borgmatic create + check, sein Schlüssel ist auf
// Lab0 append-only). Gelöscht wird nur hier: täglich nach dem Backup prune nach
// der eingestellten Aufbewahrung, danach compact — lokal auf dem Repo-Pfad, nicht
// über borg serve. Die Einstellung kommt aus dem Cockpit und bleibt in festen
// Grenzen (cockpit-borg-retention-rules.mjs).
//
// Fremde Löschungen werden nie endgültig: vor prune und noch einmal vor compact
// vergleicht der Lauf den Archivbestand (über die Archiv-id) mit seinem letzten
// Lauf. Fehlt ein Archiv, das er nicht selbst entfernt hat — etwa vom VPS im
// append-only-Modus zum Löschen vorgemerkt —, kompaktiert er nicht, setzt seinen
// Status auf "angehalten" und endet mit 3 (die Unit steht dann auf failed, das
// Cockpit zeigt es). Weiter geht es nur mit Jochens Freigabe (`freigeben`), und
// die gilt genau für die Archive, die er gesehen hat.
//
// Verben (sudoers: /usr/local/sbin/cockpit-borg-retention *, über den Executor):
//   status                       lesend: Einstellung, Grenzen, Status, Läufe,
//                                Bestand, Platz — ein JSON-Block für das Cockpit
//   run                          startet den Dienstlauf jetzt (Routine, ohne Warten)
//   set <d> <w> <m> <HH:MM>      Einstellung innerhalb der Grenzen (Routine)
//   set <d> <w> <m> <HH:MM> --freigabe
//                                unter der Untergrenze: nur mit Jochens Freigabe,
//                                die die API vorher geprüft hat
//   freigeben <anomalie-id>      Fortsetzen nach einer Anomalie (Freigabe)
//   --im-dienst                  der Lauf selbst; nur aus cockpit-borg-retention.service
//                                (User=borg, COCKPIT_BORG_RETENTION_IN_UNIT, das die
//                                Unit setzt; sudo setzt die Umgebung zurück)
//
// Rückgabewerte: 0 ok · 1 borg-Fehler · 3 angehalten oder Dienst läuft gerade ·
// 64 Aufruffehler · 65 außerhalb der Grenzen · 67 falscher Benutzer/Umgebung ·
// 69 systemctl scheiterte · 77 braucht Jochens Freigabe · 78 Einrichtung fehlt
// (Passphrase, Repo-Besitzer).
//
// Prüf-Haken (BORG_RETENTION_*) lenken Pfade und Werkzeuge für
// apps/api/test/borg-retention-helper.test.ts um. Über sudo kommen sie nie an
// (env_reset), und die Unit setzt nur COCKPIT_BORG_RETENTION_IN_UNIT.
import { createHash } from "node:crypto";
import { appendFileSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ARCHIVE_ID, DEFAULT_RETENTION, PRUNE_ARCHIVE_GLOB, RETENTION_BOUNDS, RETENTION_RULES_VERSION, RETENTION_TIME_WINDOW,
  classifyRetention, missingArchives, parsePrunedArchives, parseRetentionArgs, unexplainedLoss,
} from "./cockpit-borg-retention-rules.mjs";

const env = process.env;
const CONFIG_DIR = env.BORG_RETENTION_CONFIG_DIR || "/etc/cockpit-borg-retention";
const STATE_DIR = env.BORG_RETENTION_STATE_DIR || "/var/lib/cockpit-borg-retention";
const LOG_DIR = env.BORG_RETENTION_LOG_DIR || "/var/log/cockpit-borg-retention";
const UNIT_DIR = env.BORG_RETENTION_UNIT_DIR || "/etc/systemd/system";
const REPO = env.BORG_RETENTION_REPO || "/media/RAID/backup_VServer/borg";
const BORG = env.BORG_RETENTION_BORG || "/usr/bin/borg";
const SYSTEMCTL = env.BORG_RETENTION_SYSTEMCTL || "/usr/bin/systemctl";
const TEST_MODE = env.BORG_RETENTION_TEST === "1";

const SETTINGS_FILE = `${CONFIG_DIR}/aufbewahrung.json`;
const PASSPHRASE_FILE = `${CONFIG_DIR}/passphrase`; // root 0600, über LoadCredential in die Unit
const STATE_FILE = `${STATE_DIR}/zustand.json`;
const RUNS_FILE = `${STATE_DIR}/laeufe.jsonl`;
const SETTINGS_LOG = `${LOG_DIR}/einstellungen.jsonl`;
const SERVICE = "cockpit-borg-retention.service";
const TIMER = "cockpit-borg-retention.timer";
const TIMER_DROPIN_DIR = `${UNIT_DIR}/${TIMER}.d`;
const TIMER_DROPIN = `${TIMER_DROPIN_DIR}/uhrzeit.conf`;
const PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

const LOCK_WAIT = env.BORG_RETENTION_LOCK_WAIT || "3600"; // das nächtliche Backup darf zu Ende laufen
const MAX_RUNS_KEPT = 100;
const MAX_RUNS_SHOWN = 10;
const MAX_ARCHIVES_SHOWN = 60;
const MAX_NAMES = 50;
const BUSY = new Set(["active", "activating", "deactivating", "reloading"]);

const now = () => new Date().toISOString();
const clip = (text, limit = 300) => String(text || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(-limit);

class Stop extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── Dateien ────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Atomar: erst die neue Datei, dann rename. Besitzer wie das Verzeichnis, damit
// ein root-Aufruf (freigeben) dem Dienstlauf (borg) nichts Fremdes hinterlässt.
function writeJsonAtomic(file, value, mode) {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const temp = `${file}.neu-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.getuid?.() === 0) {
    const owner = statSync(dir);
    chownSync(temp, owner.uid, owner.gid);
  }
  renameSync(temp, file);
}

function appendLine(file, value) {
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o640 });
}

function readLines(file, limit) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter(Boolean).slice(-limit).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function trimRuns() {
  const lines = readLines(RUNS_FILE, MAX_RUNS_KEPT);
  writeFileSync(`${RUNS_FILE}.neu-${process.pid}`, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o640 });
  renameSync(`${RUNS_FILE}.neu-${process.pid}`, RUNS_FILE);
}

// Die gültige Einstellung: die Datei, sonst die Vorgabe. Eine Datei außerhalb
// der Grenzen (oder unter der Untergrenze ohne Freigabe) gilt nicht — dann
// löscht der Lauf nicht, statt zu raten.
function loadSettings() {
  const stored = readJson(SETTINGS_FILE);
  if (!stored) return { settings: { ...DEFAULT_RETENTION }, approved: false, changedAt: null, source: "default" };
  const verdict = classifyRetention(stored);
  if (!verdict.ok) throw new Stop(65, `stored retention is outside the bounds: ${verdict.errors.join("; ")}`);
  if (verdict.belowMinimum.length > 0 && stored.freigabe !== true) throw new Stop(77, `stored retention is below the minimum without approval: ${verdict.belowMinimum.join("; ")}`);
  return { settings: verdict.settings, approved: stored.freigabe === true, changedAt: typeof stored.geaendert === "string" ? stored.geaendert : null, source: "cockpit" };
}

function emptyState() {
  return { version: RETENTION_RULES_VERSION, status: "neu", baseline: null, baselineAt: null, anomaly: null, approval: null, repoStats: null };
}

function loadState() {
  return { ...emptyState(), ...(readJson(STATE_FILE) || {}) };
}

// ── systemctl ──────────────────────────────────────────────────────────────

function systemctl(args) {
  const result = spawnSync(SYSTEMCTL, args, { encoding: "utf8", env: { PATH } });
  return { code: result.status ?? 69, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

function unitState(unit) {
  const { out } = systemctl(["is-active", unit]);
  return /^[a-z-]{1,20}$/.test(out) ? out : null;
}

function timerNext() {
  const { code, out } = systemctl(["list-timers", TIMER, "--all", "--output=json"]);
  if (code !== 0) return null;
  try {
    const entry = JSON.parse(out).find((item) => item.unit === TIMER);
    return entry && Number.isSafeInteger(entry.next) && entry.next > 0 ? new Date(Math.floor(entry.next / 1000)).toISOString() : null;
  } catch { return null; }
}

// ── status ─────────────────────────────────────────────────────────────────

function passphraseState() {
  try {
    const info = statSync(PASSPHRASE_FILE);
    // Nur root darf lesen: Besitzer root, keine Rechte für Gruppe und andere.
    return info.isFile() && (info.uid === 0 || TEST_MODE) && (info.mode & 0o077) === 0 ? "ok" : "unsafe";
  } catch { return "missing"; }
}

function space() {
  try {
    const info = statfsSync(existsSync(REPO) ? REPO : REPO.slice(0, REPO.lastIndexOf("/")) || "/");
    const total = info.blocks * info.bsize;
    const free = info.bavail * info.bsize;
    return { totalBytes: total, freeBytes: free, usedPercent: total > 0 ? Math.round(((total - info.bfree * info.bsize) / total) * 100) : null };
  } catch { return null; }
}

function statusReport() {
  let settings;
  let settingsError = null;
  try { settings = loadSettings(); } catch (error) { settings = null; settingsError = clip(error.message); }
  const state = loadState();
  const inventory = Array.isArray(state.baseline) ? state.baseline : [];
  return {
    version: RETENTION_RULES_VERSION,
    measuredAt: now(),
    host: hostname(),
    installed: {
      service: existsSync(`${UNIT_DIR}/${SERVICE}`),
      timer: existsSync(`${UNIT_DIR}/${TIMER}`),
      passphrase: passphraseState(),
    },
    settings: settings ? { ...settings.settings, approved: settings.approved, changedAt: settings.changedAt, source: settings.source } : null,
    settingsError,
    bounds: RETENTION_BOUNDS,
    window: RETENTION_TIME_WINDOW,
    timer: { active: unitState(TIMER), next: timerNext() },
    service: { active: unitState(SERVICE) },
    state: {
      status: state.status,
      anomaly: state.anomaly ? { id: state.anomaly.id, detectedAt: state.anomaly.detectedAt, phase: state.anomaly.phase, count: state.anomaly.count, missing: state.anomaly.missing } : null,
      approval: state.approval,
      baselineAt: state.baselineAt,
    },
    inventory: {
      at: state.baselineAt,
      count: inventory.length,
      archives: [...inventory].sort((a, b) => String(b.time || "").localeCompare(String(a.time || ""))).slice(0, MAX_ARCHIVES_SHOWN).map((item) => ({ name: item.name, time: item.time || null })),
    },
    space: space(),
    repoStats: state.repoStats,
    runs: readLines(RUNS_FILE, MAX_RUNS_SHOWN).reverse(),
  };
}

// ── set, freigeben, run (root, über den Executor) ──────────────────────────

function requireRoot() {
  if (process.getuid?.() !== 0 && !TEST_MODE) throw new Stop(67, "this verb runs as root (sudo through the executor)");
}

function setRetention(args) {
  requireRoot();
  const approved = args[args.length - 1] === "--freigabe";
  const values = parseRetentionArgs(approved ? args.slice(0, -1) : args);
  if (!values) throw new Stop(64, "usage: set <keep_daily> <keep_weekly> <keep_monthly> <HH:MM> [--freigabe]");
  const verdict = classifyRetention(values);
  if (!verdict.ok) throw new Stop(65, verdict.errors.join("; "));
  if (verdict.belowMinimum.length > 0 && !approved) throw new Stop(77, `needs Jochen's approval: ${verdict.belowMinimum.join("; ")}`);
  let before = null;
  try { before = loadSettings().settings; } catch { before = readJson(SETTINGS_FILE); }
  const record = { ...verdict.settings, freigabe: verdict.belowMinimum.length > 0, geaendert: now() };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 });
  writeJsonAtomic(SETTINGS_FILE, record, 0o644);
  mkdirSync(TIMER_DROPIN_DIR, { recursive: true, mode: 0o755 });
  writeFileSync(TIMER_DROPIN, [
    "# Verwaltet von cockpit-borg-retention set (Cockpit, Backup-Aufbewahrung) — nicht von Hand ändern.",
    "[Timer]",
    "OnCalendar=",
    `OnCalendar=*-*-* ${verdict.settings.time}:00`,
    "",
  ].join("\n"), { mode: 0o644 });
  const reload = systemctl(["daemon-reload"]);
  if (reload.code !== 0) throw new Stop(69, `systemctl daemon-reload failed: ${clip(reload.err)}`);
  // try-restart: rechnet die neue Uhrzeit ein, startet aber keinen gestoppten Timer.
  systemctl(["try-restart", TIMER]);
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o750 });
  const entry = { at: record.geaendert, vorher: before, nachher: verdict.settings, freigabe: record.freigabe, unterUntergrenze: verdict.belowMinimum };
  appendLine(SETTINGS_LOG, entry);
  return entry;
}

function approveResume(args) {
  requireRoot();
  if (args.length !== 1 || !/^[a-f0-9]{16}$/.test(args[0])) throw new Stop(64, "usage: freigeben <anomaly-id>");
  if (BUSY.has(unitState(SERVICE) || "")) throw new Stop(3, "the service is running right now; approve after it has ended");
  const state = loadState();
  if (state.status !== "angehalten" || !state.anomaly) throw new Stop(3, "the service is not halted; nothing to approve");
  if (state.anomaly.id !== args[0]) throw new Stop(77, `the approval names anomaly ${args[0]}, the service halted for ${state.anomaly.id}; look again`);
  state.approval = { anomalyId: state.anomaly.id, at: now() };
  writeJsonAtomic(STATE_FILE, state, 0o640);
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o750 });
  appendLine(SETTINGS_LOG, { at: state.approval.at, freigegeben: state.anomaly });
  const start = systemctl(["start", "--no-block", SERVICE]);
  return { approved: state.anomaly.id, missing: state.anomaly.count, started: start.code === 0 };
}

function startRun() {
  requireRoot();
  const start = systemctl(["start", "--no-block", SERVICE]);
  if (start.code !== 0) throw new Stop(69, `systemctl start ${SERVICE} failed: ${clip(start.err)}`);
  return { started: SERVICE };
}

// ── der Lauf (User=borg, aus der Unit) ─────────────────────────────────────

function borgEnv() {
  const credentials = env.CREDENTIALS_DIRECTORY;
  const passphrase = credentials ? `${credentials}/passphrase` : "";
  if (!passphrase || !existsSync(passphrase)) throw new Stop(78, "no passphrase credential (LoadCredential=passphrase:/etc/cockpit-borg-retention/passphrase)");
  return {
    PATH,
    HOME: STATE_DIR,
    LANG: "C.UTF-8",
    // Die Passphrase liest borg selbst aus der Credential-Datei; sie steht in
    // keiner Umgebung und in keinem Argument.
    BORG_PASSCOMMAND: `cat ${passphrase}`,
    BORG_CONFIG_DIR: `${STATE_DIR}/borg/config`,
    BORG_CACHE_DIR: `${STATE_DIR}/borg/cache`,
    BORG_RELOCATED_REPO_ACCESS_IS_OK: "no",
    BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: "no",
    BORG_CHECK_I_KNOW_WHAT_I_AM_DOING: "NO",
    BORG_DELETE_I_KNOW_WHAT_I_AM_DOING: "NO",
  };
}

function borg(args, borgEnvironment) {
  const result = spawnSync(BORG, args, { encoding: "utf8", env: borgEnvironment, maxBuffer: 64 * 1024 * 1024 });
  // borg 1.x: 0 ok, 1 Warnung, ab 2 Fehler.
  if (result.error || result.status === null || result.status > 1) {
    throw new Stop(1, `borg ${args[0]} failed (rc ${result.status ?? "?"}): ${clip(result.stderr || result.error?.message)}`);
  }
  return { out: result.stdout || "", err: result.stderr || "" };
}

function listArchives(borgEnvironment) {
  const { out } = borg(["list", "--json", "--lock-wait", LOCK_WAIT, REPO], borgEnvironment);
  const parsed = JSON.parse(out);
  const archives = Array.isArray(parsed?.archives) ? parsed.archives : null;
  if (!archives) throw new Stop(1, "borg list --json returned no archive list");
  return archives.map((item) => {
    if (!ARCHIVE_ID.test(String(item.id)) || typeof item.name !== "string") throw new Stop(1, "borg list --json returned an archive without id or name");
    return { id: item.id, name: item.name, time: typeof item.start === "string" ? item.start : typeof item.time === "string" ? item.time : null };
  });
}

function anomalyOf(missing, phase) {
  const ids = missing.map((item) => item.id).sort();
  return {
    id: createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16),
    detectedAt: now(),
    phase,
    count: missing.length,
    missing: missing.slice(0, MAX_NAMES).map((item) => ({ id: item.id, name: item.name })),
    missingIds: ids,
  };
}

export function runService() {
  if (env.COCKPIT_BORG_RETENTION_IN_UNIT !== "1") throw new Stop(67, "--im-dienst runs only from cockpit-borg-retention.service");
  if (process.getuid?.() === 0 && !TEST_MODE) throw new Stop(67, "the service runs as the repository owner (User=borg), never as root");
  const record = { start: now(), end: null, result: null, before: null, after: null, pruned: 0, prunedNames: [], compacted: false, compactSkipped: null, settings: null, note: null };
  const state = loadState();
  try {
    const { settings } = loadSettings();
    record.settings = settings;
    // Neue Dateien im Repo müssen dem Besitzer gehören, sonst schreibt der VPS
    // morgen nicht mehr hinein.
    const owner = statSync(REPO);
    if (owner.uid !== process.getuid?.()) throw new Stop(78, `the repository belongs to uid ${owner.uid}, this run is uid ${process.getuid?.()}`);

    // Angehalten: nur mit einer Freigabe genau für diese Anomalie weiter.
    let accepted = new Set();
    if (state.status === "angehalten") {
      if (!state.anomaly || !state.approval || state.approval.anomalyId !== state.anomaly.id) {
        record.result = "angehalten";
        record.note = `halted since ${state.anomaly?.detectedAt || "?"}: ${state.anomaly?.count ?? "?"} archive(s) missing that this service did not remove; waiting for Jochen's approval`;
        throw new Stop(3, record.note);
      }
      accepted = new Set(state.anomaly.missingIds || []);
    }

    const borgEnvironment = borgEnv();
    const before = listArchives(borgEnvironment);
    record.before = before.length;
    const firstRun = !Array.isArray(state.baseline);
    if (!firstRun) {
      const foreign = missingArchives(state.baseline, before).filter((item) => !accepted.has(item.id));
      if (foreign.length > 0) halt(state, record, anomalyOf(foreign, "before-prune"));
    }

    const pruneArgs = ["prune", "--list", "--lock-wait", LOCK_WAIT, "--glob-archives", PRUNE_ARCHIVE_GLOB, "--keep-daily", String(settings.keepDaily), "--keep-weekly", String(settings.keepWeekly)];
    if (settings.keepMonthly > 0) pruneArgs.push("--keep-monthly", String(settings.keepMonthly));
    const prune = borg([...pruneArgs, REPO], borgEnvironment);
    const pruned = parsePrunedArchives(`${prune.err}\n${prune.out}`);
    record.pruned = pruned.length;
    record.prunedNames = pruned.slice(0, 20).map((item) => item.name);

    const after = listArchives(borgEnvironment);
    record.after = after.length;
    const unexplained = unexplainedLoss(before, after, pruned);
    if (unexplained.length > 0) halt(state, record, anomalyOf(unexplained, "after-prune"));

    // Der neue Vergleichsstand gilt ab jetzt, auch wenn compact unten scheitert:
    // was prune entfernt hat, hat dieser Dienst entfernt.
    state.status = "ok";
    state.baseline = after;
    state.baselineAt = now();
    state.anomaly = null;
    state.approval = null;
    writeJsonAtomic(STATE_FILE, state, 0o640);

    if (firstRun) {
      record.compactSkipped = "first run: no earlier inventory to compare with, compact follows on the next run";
    } else {
      borg(["compact", "--lock-wait", LOCK_WAIT, REPO], borgEnvironment);
      record.compacted = true;
    }
    try {
      const info = JSON.parse(borg(["info", "--json", "--lock-wait", LOCK_WAIT, REPO], borgEnvironment).out);
      const stats = info?.cache?.stats || {};
      state.repoStats = {
        at: now(),
        uniqueCompressedBytes: Number.isSafeInteger(stats.unique_csize) ? stats.unique_csize : null,
        totalSizeBytes: Number.isSafeInteger(stats.total_size) ? stats.total_size : null,
      };
      writeJsonAtomic(STATE_FILE, state, 0o640);
    } catch (error) {
      record.note = clip(`repository statistics unavailable: ${error.message}`);
    }
    record.result = "ok";
    return 0;
  } catch (error) {
    if (!record.result) record.result = error.code === 65 || error.code === 77 ? "abgelehnt" : "fehler";
    record.note = record.note || clip(error.message);
    throw error;
  } finally {
    record.end = now();
    appendLine(RUNS_FILE, record);
    trimRuns();
  }
}

function halt(state, record, anomaly) {
  state.status = "angehalten";
  state.anomaly = anomaly;
  state.approval = null;
  writeJsonAtomic(STATE_FILE, state, 0o640);
  record.result = "anomalie";
  record.note = `${anomaly.count} archive(s) missing that this service did not remove (${anomaly.phase}): no compact, halted until Jochen approves`;
  throw new Stop(3, record.note);
}

// ── Einstieg ───────────────────────────────────────────────────────────────

export const STATUS_MARKER = "== DATEN (cockpit-borg-retention/v1) ==";

export function main(argv) {
  const [verb, ...args] = argv;
  try {
    if (verb === "status" && args.length === 0) {
      process.stdout.write(`${STATUS_MARKER}\n${JSON.stringify(statusReport())}\n`);
      return 0;
    }
    if (verb === "run" && args.length === 0) { process.stdout.write(`${JSON.stringify(startRun())}\n`); return 0; }
    if (verb === "set") { process.stdout.write(`${JSON.stringify(setRetention(args))}\n`); return 0; }
    if (verb === "freigeben") { process.stdout.write(`${JSON.stringify(approveResume(args))}\n`); return 0; }
    if (verb === "--im-dienst" && args.length === 0) return runService();
    throw new Stop(64, "usage: cockpit-borg-retention status | run | set <d> <w> <m> <HH:MM> [--freigabe] | freigeben <anomaly-id>");
  } catch (error) {
    const code = error instanceof Stop ? error.code : 1;
    process.stderr.write(`cockpit-borg-retention: ${clip(error.message, 600)}\n`);
    return code;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}

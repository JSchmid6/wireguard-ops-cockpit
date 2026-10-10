// Überwachter Lauf eines Antriebs (CLI-Betrieb nach LifeOS, Abschnitte 1, 6, 8):
// eigene Prozessgruppe, Abbruch immer an die ganze Gruppe (SIGTERM → 5 s →
// SIGKILL), jede Ausgabezeile sofort nach events.jsonl, am Ende ein Urteil
// (lauf.json), nicht-erfolgreiche Urteile zusätzlich nach abbrueche.jsonl,
// verwaiste Läufe beim Start abräumen.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const KILL_GRACE_MS = 5000;
export const RUN_MARKER_ENV = "COCKPIT_AGENT_RUN_ID";
const RUN_ID = /^[A-Za-z0-9-]{8,96}$/;
const keptRunAgeMs = 14 * 24 * 60 * 60 * 1000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// SIGTERM an die Gruppe, nach der Gnadenfrist SIGKILL, falls noch jemand lebt.
// Liefert ein Promise, das nach dem Ende der Eskalation erfüllt ist.
export function killGroup(pid, graceMs = KILL_GRACE_MS) {
  return new Promise((resolve) => {
    try { process.kill(-pid, "SIGTERM"); } catch { resolve("gone"); return; }
    const until = Date.now() + graceMs;
    const poll = setInterval(() => {
      if (!groupAlive(pid)) { clearInterval(poll); resolve("term"); return; }
      if (Date.now() < until) return;
      clearInterval(poll);
      try { process.kill(-pid, "SIGKILL"); } catch { /* inzwischen weg */ }
      resolve("kill");
    }, Math.min(100, graceMs));
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function appendLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function createRunDir(runsRoot, runId) {
  if (!RUN_ID.test(runId)) throw new Error("run id is invalid");
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const dir = path.join(runsRoot, runId);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

// Schreibt das Urteil eines Laufs und protokolliert jeden Nicht-Erfolg.
export function writeVerdict(runsRoot, runDir, verdict, lastEvents = []) {
  writeJson(path.join(runDir, "lauf.json"), verdict);
  if (verdict.status !== "erfolg") {
    appendLine(path.join(runsRoot, "abbrueche.jsonl"), {
      zeit: verdict.ende, lauf: verdict.lauf, rolle: verdict.rolle, antrieb: verdict.antrieb,
      status: verdict.status, grund: verdict.grund, letzteEreignisse: lastEvents.slice(-3),
    });
  }
  try { fs.rmSync(path.join(runDir, "engine.pid"), { force: true }); } catch { /* best effort */ }
}

// Prüft über /proc, ob die PID noch der eigene Antrieb dieses Laufs ist:
// die Kommandozeile enthält den Antrieb UND die Laufmarke steht im environ.
// Schützt gegen PID-Wiederverwendung.
export function isOwnEngineProcess(pid, runId, engineNames, procRoot = "/proc") {
  try {
    const argv = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean);
    const matchesEngine = argv.slice(0, 2).some((arg) => engineNames.includes(path.basename(arg)));
    if (!matchesEngine) return false;
    const environ = fs.readFileSync(path.join(procRoot, String(pid), "environ"), "utf8").split("\0");
    return environ.includes(`${RUN_MARKER_ENV}=${runId}`);
  } catch {
    return false;
  }
}

// Beim Start: Läufe mit engine.pid, aber ohne lauf.json, gehören einem toten
// Broker. Lebt die Gruppe noch und ist die PID nachweislich der eigene
// Antrieb, wird die Gruppe beendet; jedes Mal entsteht ein Urteil.
// Alte, abgeschlossene Laufordner werden nach 14 Tagen entfernt.
export async function reapOrphanedRuns(runsRoot, { engineNames = ["claude", "codex", "opencode"], procRoot = "/proc", graceMs = KILL_GRACE_MS, now = Date.now() } = {}) {
  const reaped = [];
  if (!fs.existsSync(runsRoot)) return reaped;
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const runDir = path.join(runsRoot, entry.name);
    const pidFile = path.join(runDir, "engine.pid");
    const verdictFile = path.join(runDir, "lauf.json");
    if (fs.existsSync(verdictFile)) {
      if (now - fs.statSync(verdictFile).mtimeMs > keptRunAgeMs) fs.rmSync(runDir, { recursive: true, force: true });
      continue;
    }
    if (!fs.existsSync(pidFile)) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(pidFile, "utf8")); } catch { info = {}; }
    const pid = Number.isInteger(info.pid) && info.pid > 1 ? info.pid : null;
    let action = "nicht_mehr_aktiv";
    if (pid && alive(pid)) {
      if (isOwnEngineProcess(pid, entry.name, engineNames, procRoot)) {
        await killGroup(pid, graceMs);
        action = "gruppe_beendet";
      } else {
        action = "pid_fremd_nicht_angefasst";
      }
    }
    const ende = new Date(now).toISOString();
    writeVerdict(runsRoot, runDir, {
      lauf: entry.name, rolle: info.rolle || null, antrieb: info.antrieb || null, modell: info.modell || null,
      status: "fehler", grund: `verwaister Lauf beim Start abgeräumt (${action})`, exitCode: null, signal: null,
      start: info.start || null, ende, dauerMs: info.start ? Math.max(0, now - Date.parse(info.start)) : null, cliVersion: info.cliVersion || null,
    });
    reaped.push({ lauf: entry.name, action });
  }
  return reaped;
}

// Startet einen Antrieb unter Aufsicht. `engine` liefert executable, args,
// env, stdin und einen Ereignis-Leser (onLine/finish). Liefert das Urteil
// plus die Ausgabe für die API.
export function superviseRun({ runsRoot, runDir, runId, role, engine, cwd, deadline, graceMs = KILL_GRACE_MS, started = Date.now() }) {
  return new Promise((resolve) => {
    const eventsFile = path.join(runDir, "events.jsonl");
    const eventsFd = fs.openSync(eventsFile, "a", 0o600);
    const lastEvents = [];
    const startIso = new Date(started).toISOString();
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let earlyStop = null;
    let settled = false;
    let killDone = Promise.resolve();

    const child = spawn(engine.executable, engine.args, {
      cwd,
      env: { ...engine.env, [RUN_MARKER_ENV]: runId },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    // Empty lines are kept: opencode's plain-text answer needs its paragraphs.
    const recordLine = (line) => {
      try { fs.writeSync(eventsFd, `${line}\n`); }
      catch (error) { stopEarly({ status: "fehler", grund: `events.jsonl nicht schreibbar (${error.code || error.message})` }); }
      if (!line) { engine.onLine(line); return; }
      lastEvents.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
      if (lastEvents.length > 3) lastEvents.shift();
      const stop = engine.onLine(line);
      if (stop) stopEarly(stop);
    };
    function stopEarly(stop) {
      if (earlyStop) return;
      earlyStop = stop;
      killDone = killGroup(child.pid, graceMs);
    }

    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      timedOut = true;
      killDone = killGroup(child.pid, graceMs);
    }, remaining);
    if (child.pid) {
      try {
        writeJson(path.join(runDir, "engine.pid"), {
          brokerPid: process.pid, pid: child.pid, antrieb: engine.name, modell: engine.model, rolle: role, start: startIso, cliVersion: engine.cliVersion,
        });
      } catch (error) {
        stopEarly({ status: "fehler", grund: `engine.pid nicht schreibbar (${error.code || error.message})` });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        recordLine(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
      if (pending.length > 4_000_000) { recordLine(pending); pending = ""; }
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    child.stdin.on("error", () => { /* Antrieb hat stdin geschlossen; das Urteil folgt aus dem Ende */ });
    child.stdin.end(engine.stdin ?? "");

    const finish = async (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending) recordLine(pending);
      await killDone;
      // Auch bei regulärem Ende darf aus der Gruppe nichts weiterrechnen.
      if (child.pid && groupAlive(child.pid)) await killGroup(child.pid, graceMs);
      fs.closeSync(eventsFd);
      const ende = Date.now();
      const read = engine.finish({ exitCode, stderr });
      let status; let grund;
      if (spawnError) { status = "nicht_verfuegbar"; grund = `Antrieb nicht startbar: ${spawnError.message}`; }
      else if (timedOut) { status = "zeit"; grund = `Zeitlimit von ${Math.round((deadline - started) / 1000)} s überschritten`; }
      else if (earlyStop) { status = earlyStop.status; grund = earlyStop.grund; }
      else { status = read.status; grund = read.grund; }
      const verdict = {
        lauf: runId, rolle: role, antrieb: engine.name, modell: read.model || engine.model, etikett: engine.label || null,
        status, grund, exitCode, signal, start: startIso, ende: new Date(ende).toISOString(), dauerMs: ende - started,
        cliVersion: engine.cliVersion, cliVersionNeu: Boolean(engine.cliVersionNew), werkzeuge: read.tools ?? null,
        ereignisse: eventsFile,
      };
      writeVerdict(runsRoot, runDir, verdict, lastEvents);
      resolve({ verdict, output: status === "erfolg" ? read.output : null, stderr: stderr.slice(-4000) });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

import { createHash } from "node:crypto";

/**
 * Der Borg-Zustand für die Cockpit-Anzeige — nur lesend, ohne jeden Eingriff.
 *
 * Woher die Werte kommen: `deploy/helpers/cockpit-borg-action status` (typisierte
 * Aktion `borg.status`, allowlistetes Ziel `state`) endet mit einem
 * maschinenlesbaren Block `== DATEN (cockpit-borg-status/v1) ==`. Genau diesen
 * Block liest diese Datei — nichts sonst aus der Helfer-Ausgabe (dort steht Prosa
 * für Menschen, inklusive Repo-Kennzahlen).
 *
 * Warum so streng: der Block ist eine Grenze. Er darf nur ISO-Zeit mit Zone,
 * ganze Zahlen, Einheitenname oder feste Aufzählung enthalten, und jede Zeile,
 * die nicht in dieses Muster passt, wird hier verworfen. Damit kann weder ein
 * Pfad noch ein Zugangsdatum aus /etc/borgmatic/config.yaml in die Anzeige oder
 * ins Log geraten — und ohne Block bleibt die Anzeige ehrlich bei "unknown",
 * statt Werte zu erfinden.
 *
 * Zwei Dinge bleiben getrennt, weil sie verschiedene Dinge sind:
 *   * `check` — der letzte Check, den dieses Cockpit wirklich gestartet hat
 *     (Unit `cockpit-borg-check-*`, Ergebnis aus ihrem Journal). Grün gibt es nur
 *     mit rc=0.
 *   * `scheduledCheck` — was der nächtliche borgmatic-Lauf über seine
 *     Konsistenzprüfung sagt. Das ist meist "skipped": borgmatic fährt den Check
 *     nur nach seiner konfigurierten Frequenz und überspringt ihn sonst, was in
 *     einer Anzeige wie ein grüner Zustand aussieht. Deshalb steht es hier
 *     getrennt und nie als "ok".
 */

/** Markierungszeile, die der Helfer vor seinen Datenblock schreibt. */
export const BORG_STATUS_MARKER = "== DATEN (cockpit-borg-status/v1) ==";

/** Einheiten dieses Helfers dürfen nur aus diesem Namensraum kommen. */
export const BORG_UNIT_PREFIX = "cockpit-borg-";

const FIELD_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const INTEGER_PATTERN = /^\d{1,6}$/;
const UNIT_PATTERN = /^[a-zA-Z0-9@._-]{1,120}$/;
const HOST_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const RESULT_PATTERN = /^[a-z][a-z-]{0,19}$/;
const MAX_FIELD_CHARS = 120;

export type BorgCheckState = "ok" | "failed" | "running" | "skipped" | "unknown";
export type BorgMaintenanceKind = "check" | "repair";
export type BorgRole = "vps" | "kiste";

export interface BorgTimerState {
  unit: string | null;
  active: string | null;
  next: string | null;
  source: string;
}

export interface BorgLastRunState {
  start: string | null;
  end: string | null;
  result: string | null;
  exitStatus: number | null;
  source: string;
}

export interface BorgCheckStateView {
  state: BorgCheckState;
  rc: number | null;
  at: string | null;
  unit: string | null;
  kind: BorgMaintenanceKind | null;
  source: string;
}

export interface BorgScheduledCheckView {
  state: "skipped" | "failed" | "unknown";
  at: string | null;
  source: string;
}

export interface BorgSnapshot {
  generatedAt: string | null;
  host: string | null;
  role: BorgRole | null;
  timer: BorgTimerState;
  lastRun: BorgLastRunState;
  check: BorgCheckStateView;
  scheduledCheck: BorgScheduledCheckView;
}

export type BorgViewState = "unknown" | "measuring" | "fresh" | "stale" | "failed";

export interface BorgStatusView {
  /** Zustand der Anzeige selbst: gemessen, in Messung, veraltet, fehlgeschlagen. */
  state: BorgViewState;
  /** Läuft gerade eine Messung? (Der angezeigte Stand kann älter sein.) */
  measuring: boolean;
  /** Wann die Cockpit-API die Werte geholt hat (ISO, UTC). */
  measuredAt: string | null;
  ageSeconds: number | null;
  /** Kurzer, gesäuberter Grund, wenn die letzte Messung nicht ging. */
  note: string | null;
  borg: BorgSnapshot | null;
}

const SOURCE_TIMER = "systemctl list-timers <timer> --output=json";
const SOURCE_LAST_RUN = "journalctl -u borgmatic + systemctl show borgmatic.service";
const SOURCE_JOURNAL_CHECK = "journalctl -u borgmatic (Konsistenzprüfung)";
const SOURCE_NO_REPORT = "kein Datenblock in der Helfer-Ausgabe";

/** Der Bericht ist eine Zeilenliste; alles Unbekannte wird fallengelassen. */
function readFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("==")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!FIELD_PATTERN.test(key)) continue;
    const value = line.slice(separator + 1).trim();
    // Überlange Werte werden verworfen, nicht abgeschnitten: ein abgeschnittener
    // Wert (z. B. ein Pfad) könnte sonst zufällig wie ein gültiger aussehen.
    if (value.length > MAX_FIELD_CHARS) continue;
    fields.set(key, value);
  }
  return fields;
}

/**
 * Liest den Datenblock aus der Ausgabe von `cockpit-borg-action status`.
 * `null`, wenn kein Block da ist (Helfer nicht ausgeliefert oder älter) — die
 * Anzeige meldet dann "unknown", sie rät nicht.
 */
export function parseBorgStatusReport(text: string): BorgSnapshot | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const markerAt = text.lastIndexOf(BORG_STATUS_MARKER);
  if (markerAt < 0) return null;
  const fields = readFields(text.slice(markerAt + BORG_STATUS_MARKER.length));

  const iso = (key: string): string | null => {
    const value = fields.get(key);
    return value !== undefined && ISO_PATTERN.test(value) ? value : null;
  };
  const integer = (key: string): number | null => {
    const value = fields.get(key);
    if (value === undefined || !INTEGER_PATTERN.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const unitName = (key: string): string | null => {
    const value = fields.get(key);
    return value !== undefined && UNIT_PATTERN.test(value) && value.startsWith(BORG_UNIT_PREFIX) ? value : null;
  };

  const host = fields.get("host");
  const roleValue = fields.get("role");
  const timerActive = fields.get("timer_active");
  const timerUnit = fields.get("timer_unit");
  const lastRunResult = fields.get("last_run_result");
  const maintenanceKindValue = fields.get("maintenance_kind");
  const scheduledValue = fields.get("scheduled_check");

  const maintenanceUnit = unitName("maintenance_unit");
  const maintenanceKind: BorgMaintenanceKind | null =
    maintenanceKindValue === "check" || maintenanceKindValue === "repair" ? maintenanceKindValue : null;
  const maintenanceRc = integer("maintenance_rc");
  const maintenanceEnd = iso("maintenance_end");
  const maintenanceRunning = fields.get("maintenance_running") === "yes";

  const scheduledCheck: BorgScheduledCheckView = {
    state: scheduledValue === "skipped" || scheduledValue === "failed" ? scheduledValue : "unknown",
    at: iso("scheduled_check_at"),
    source: SOURCE_JOURNAL_CHECK,
  };

  let check: BorgCheckStateView;
  if (maintenanceRunning) {
    check = {
      state: "running", rc: null, at: maintenanceEnd, unit: maintenanceUnit, kind: maintenanceKind,
      source: maintenanceUnit ? `systemctl is-active ${maintenanceUnit}` : SOURCE_NO_REPORT,
    };
  } else if (maintenanceRc !== null) {
    check = {
      state: maintenanceRc === 0 ? "ok" : "failed", rc: maintenanceRc, at: maintenanceEnd,
      unit: maintenanceUnit, kind: maintenanceKind,
      source: maintenanceUnit ? `journalctl -u ${maintenanceUnit}` : SOURCE_NO_REPORT,
    };
  } else if (scheduledCheck.state !== "unknown") {
    // Kein Cockpit-Check, aber eine Aussage des nächtlichen Laufs: übersprungen
    // oder fehlgeschlagen. Ein "ok" kommt aus dieser Quelle nie — der
    // übersprungene Check ist kein grüner Check.
    check = { state: scheduledCheck.state, rc: null, at: scheduledCheck.at, unit: null, kind: null, source: SOURCE_JOURNAL_CHECK };
  } else {
    check = { state: "unknown", rc: null, at: null, unit: null, kind: null, source: SOURCE_NO_REPORT };
  }

  return {
    generatedAt: iso("measured_at"),
    host: host !== undefined && HOST_PATTERN.test(host) ? host : null,
    role: roleValue === "vps" || roleValue === "kiste" ? roleValue : null,
    timer: {
      unit: timerUnit !== undefined && UNIT_PATTERN.test(timerUnit) ? timerUnit : null,
      active: timerActive !== undefined && RESULT_PATTERN.test(timerActive) ? timerActive : null,
      next: iso("timer_next"),
      source: SOURCE_TIMER,
    },
    lastRun: {
      start: iso("last_run_start"),
      end: iso("last_run_end"),
      result: lastRunResult !== undefined && RESULT_PATTERN.test(lastRunResult) ? lastRunResult : null,
      exitStatus: integer("last_run_exit"),
      source: SOURCE_LAST_RUN,
    },
    check,
    scheduledCheck,
  };
}

/**
 * Die Bindung der Leseabfrage an ihre Parameter. Das ist kein Freigabe-Envelope:
 * `borg.status` ist lesend und braucht keine Operator-Freigabe; der Broker prüft
 * nur, dass das Feld die Form eines Digests hat.
 */
export function borgStatusRequestDigest(payload: { action: string; target: string; expiresAt: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ action: payload.action, target: payload.target, expiresAt: payload.expiresAt }))
    .digest("hex");
}

/**
 * Eine Zeile, gedeckelt — Fehlertexte sind Belege, keine Datenhalden.
 *
 * Auf dem Fehlerpfad liefert der Executor-Broker die rohe Helfer-Ausgabe mit
 * (apps/executor-broker/src/index.mjs: `error: [stderr, stdout].join("\n")`).
 * Darin stehen auch Pfade, URLs und Adressen (z. B. `ssh://borg@10.0.0.5/…`,
 * `/media/RAID/backup_VServer/borg`). Sie dürfen genauso wenig in die Anzeige
 * wie Zugangsdaten — deshalb wird hier nicht nur geschwärzt, sondern jedes
 * Token mit einem Pfadtrenner, jede URL und jede IPv4-Adresse ersetzt.
 */
export function sanitizeReason(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(passphrase|password|secret|token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[pfad]")
    .replace(/\S*\/\S*/g, "[pfad]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[adresse]")
    // IPv6: verlangt mindestens einen Hex-Buchstaben bzw. die ::-Kurzform —
    // eine Uhrzeit (02:56:06) ist keine Adresse und bleibt lesbar.
    .replace(/\b(?=[0-9a-f:]*[a-f])[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,}\b/gi, "[adresse]")
    .replace(/\b(?:[0-9a-f]{1,4}:)*[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi, "[adresse]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface BorgStatusServiceOptions {
  /** Führt `borg.status` aus und liefert die Helfer-Ausgabe (typisierter Weg). */
  readReport: () => Promise<string>;
  now?: () => number;
  /** Wie lange ein gemessener Zustand als frisch gilt. */
  ttlMs?: number;
  /** Obergrenze für das Warten in einer Anfrage. */
  maxWaitMs?: number;
}

export interface BorgStatusService {
  view: () => BorgStatusView;
  /** Misst bei Bedarf (oder erzwingend) und wartet höchstens `waitMs`. */
  measure: (options?: { waitMs?: number; force?: boolean }) => Promise<BorgStatusView>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_WAIT_MS = 25_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Ein Hintergrund-Takt darf den Prozess nicht offen halten.
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  });
}

/**
 * Eine Messung gleichzeitig, Werte im Speicher, Anfragen warten nur begrenzt:
 * `borg.status` läuft als eigene systemd-Unit und kann ein paar Sekunden
 * brauchen. Die Anzeige bekommt deshalb immer sofort eine Antwort — frisch,
 * "läuft noch" oder mit dem letzten Stand plus Grund.
 */
export function createBorgStatusService(options: BorgStatusServiceOptions): BorgStatusService {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let snapshot: BorgSnapshot | null = null;
  let measuredAt: number | null = null;
  let failure: string | null = null;
  let inFlight: Promise<void> | null = null;

  async function runMeasurement(): Promise<void> {
    try {
      const report = await options.readReport();
      const parsed = parseBorgStatusReport(report);
      if (!parsed) {
        failure = "Helfer-Ausgabe ohne Datenblock cockpit-borg-status/v1 — Helfer fehlt auf dem Host oder ist älter als dieser Stand.";
        return;
      }
      snapshot = parsed;
      measuredAt = now();
      failure = null;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const note = sanitizeReason(raw);
      // Bei einem Befund-Exitcode (z. B. rc=2 "Repo nicht erreichbar") schreibt
      // der Helfer den Datenblock trotzdem; der Broker reicht die Ausgabe im
      // Fehlertext durch. Ein gültiger Block darin sind echte Messwerte —
      // verwerfen hieße, genau dann nichts zu zeigen, wenn es darauf ankommt.
      // Der Grund bleibt daneben stehen, die Anzeige behauptet nichts.
      const recovered = parseBorgStatusReport(raw);
      if (recovered) {
        snapshot = recovered;
        measuredAt = now();
        failure = sanitizeReason(`Messung mit Befund: ${raw}`);
      } else {
        failure = note;
      }
    }
  }

  function startMeasurement(): Promise<void> {
    if (inFlight) return inFlight;
    const pending = runMeasurement().finally(() => {
      inFlight = null;
    });
    inFlight = pending;
    return pending;
  }

  function isStale(): boolean {
    return measuredAt === null || now() - measuredAt > ttlMs;
  }

  function view(): BorgStatusView {
    let state: BorgViewState;
    if (snapshot !== null && !isStale()) state = "fresh";
    else if (snapshot !== null) state = "stale";
    else if (inFlight !== null) state = "measuring";
    else if (failure !== null) state = "failed";
    else state = "unknown";
    return {
      state,
      measuring: inFlight !== null,
      measuredAt: measuredAt === null ? null : new Date(measuredAt).toISOString(),
      ageSeconds: measuredAt === null ? null : Math.max(0, Math.round((now() - measuredAt) / 1000)),
      note: failure,
      borg: snapshot,
    };
  }

  async function measure(opts: { waitMs?: number; force?: boolean } = {}): Promise<BorgStatusView> {
    if (opts.force === true || isStale()) {
      const pending = startMeasurement();
      const waitMs = Math.min(Math.max(opts.waitMs ?? 0, 0), maxWaitMs);
      if (waitMs > 0) await Promise.race([pending, delay(waitMs)]);
    }
    return view();
  }

  return { view, measure };
}

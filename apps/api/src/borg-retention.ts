import { createHash } from "node:crypto";

import {
  RETENTION_BOUNDS,
  RETENTION_TIME_WINDOW,
  classifyRetention,
  type RetentionSettings,
} from "../../../deploy/helpers/cockpit-borg-retention-rules.mjs";
import { sanitizeReason } from "./borg-status.js";

/**
 * Backup-Aufbewahrung — der Aufräum-Dienst auf Lab0 im Cockpit
 * (doc/setup/borg-retention.md).
 *
 * Der Dienst selbst (deploy/helpers/cockpit-borg-retention.mjs) läuft auf dem
 * Host als borg und löscht nach der Einstellung; hier liest die API seinen
 * Zustand und gibt Änderungen weiter — beides über den Executor
 * (`borg.retention.*`), nie direkt.
 *
 * Die Grenzen stehen fest im Code (cockpit-borg-retention-rules.mjs):
 *   * innerhalb der Grenzen: frei, wird protokolliert (Audit),
 *   * über der Obergrenze, unter dem Boden, Uhrzeit außerhalb des Fensters: nie,
 *   * unter der Untergrenze und Fortsetzen nach einer Anomalie: nur mit Jochens
 *     Freigabe — einer Admin-Sitzung mit ausdrücklicher Bestätigung und Grund.
 *     Ein Automation-Token (James) kann das nicht, auch nicht für sich selbst.
 */

export const RETENTION_MARKER = "== DATEN (cockpit-borg-retention/v1) ==";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/;
const ARCHIVE_NAME = /^[A-Za-z0-9._:+@-]{1,160}$/;
const ARCHIVE_ID = /^[a-f0-9]{64}$/;
const ANOMALY_ID = /^[a-f0-9]{16}$/;
const UNIT_STATE = /^[a-z-]{1,20}$/;
const HOST = /^[a-zA-Z0-9._-]{1,120}$/;
const RUN_RESULTS = new Set(["ok", "anomalie", "angehalten", "fehler", "abgelehnt"]);
const STATUSES = new Set(["neu", "ok", "angehalten"]);

export type RetentionStatus = "neu" | "ok" | "angehalten";

export interface RetentionRun {
  start: string | null;
  end: string | null;
  result: string;
  before: number | null;
  after: number | null;
  pruned: number | null;
  prunedNames: string[];
  compacted: boolean;
  compactSkipped: string | null;
  settings: RetentionSettings | null;
  note: string | null;
}

export interface RetentionAnomaly {
  id: string;
  detectedAt: string | null;
  phase: string | null;
  count: number;
  missing: Array<{ id: string; name: string }>;
}

export interface RetentionReport {
  measuredAt: string | null;
  host: string | null;
  installed: { service: boolean; timer: boolean; passphrase: "ok" | "missing" | "unsafe" | "unknown" };
  settings: (RetentionSettings & { approved: boolean; changedAt: string | null; source: "cockpit" | "default" }) | null;
  settingsError: string | null;
  timer: { active: string | null; next: string | null };
  service: { active: string | null };
  state: { status: RetentionStatus | null; anomaly: RetentionAnomaly | null; approval: { anomalyId: string; at: string | null } | null; baselineAt: string | null };
  inventory: { at: string | null; count: number; archives: Array<{ name: string; time: string | null }> };
  space: { totalBytes: number; freeBytes: number; usedPercent: number | null } | null;
  repoStats: { at: string | null; uniqueCompressedBytes: number | null; totalSizeBytes: number | null } | null;
  runs: RetentionRun[];
}

export interface RetentionView {
  available: boolean;
  note: string | null;
  bounds: typeof RETENTION_BOUNDS;
  window: typeof RETENTION_TIME_WINDOW;
  report: RetentionReport | null;
}

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const iso = (value: unknown): string | null => (typeof value === "string" && ISO.test(value) ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const text = (value: unknown, pattern: RegExp): string | null => (typeof value === "string" && pattern.test(value) ? value : null);
const note = (value: unknown): string | null => (typeof value === "string" && value ? sanitizeReason(value) : null);

function settingsOf(value: unknown): RetentionSettings | null {
  const raw = record(value);
  const verdict = classifyRetention(raw);
  // Auch Werte unter der Untergrenze (freigegeben) sind ein gültiger Stand.
  return verdict.ok ? verdict.settings : null;
}

function archiveName(value: unknown): string {
  return typeof value === "string" && ARCHIVE_NAME.test(value) ? value : "[unlesbarer Name]";
}

/**
 * Liest den Datenblock aus `cockpit-borg-retention status`. Jeder Wert wird
 * gegen seine Form geprüft und neu aufgebaut; was nicht passt, fällt weg. Ohne
 * Block: `null` — die Anzeige sagt dann ehrlich "nicht verfügbar".
 */
export function parseRetentionReport(output: string): RetentionReport | null {
  if (typeof output !== "string") return null;
  const at = output.lastIndexOf(RETENTION_MARKER);
  if (at < 0) return null;
  const line = output.slice(at + RETENTION_MARKER.length).trim().split("\n")[0] || "";
  let parsed: Raw;
  try { parsed = record(JSON.parse(line)); } catch { return null; }
  if (parsed.version !== "cockpit-borg-retention/v1") return null;

  const installed = record(parsed.installed);
  const settingsRaw = record(parsed.settings);
  const settings = settingsOf(settingsRaw);
  const state = record(parsed.state);
  const anomalyRaw = record(state.anomaly);
  const approvalRaw = record(state.approval);
  const inventory = record(parsed.inventory);
  const spaceRaw = record(parsed.space);
  const stats = record(parsed.repoStats);
  const passphrase = installed.passphrase;

  const anomalyId = text(anomalyRaw.id, ANOMALY_ID);
  const totalBytes = count(spaceRaw.totalBytes);
  const freeBytes = count(spaceRaw.freeBytes);

  return {
    measuredAt: iso(parsed.measuredAt),
    host: text(parsed.host, HOST),
    installed: {
      service: installed.service === true,
      timer: installed.timer === true,
      passphrase: passphrase === "ok" || passphrase === "missing" || passphrase === "unsafe" ? passphrase : "unknown",
    },
    settings: settings ? {
      ...settings,
      approved: settingsRaw.approved === true,
      changedAt: iso(settingsRaw.changedAt),
      source: settingsRaw.source === "cockpit" ? "cockpit" : "default",
    } : null,
    settingsError: note(parsed.settingsError),
    timer: { active: text(record(parsed.timer).active, UNIT_STATE), next: iso(record(parsed.timer).next) },
    service: { active: text(record(parsed.service).active, UNIT_STATE) },
    state: {
      status: typeof state.status === "string" && STATUSES.has(state.status) ? state.status as RetentionStatus : null,
      anomaly: anomalyId ? {
        id: anomalyId,
        detectedAt: iso(anomalyRaw.detectedAt),
        phase: anomalyRaw.phase === "before-prune" || anomalyRaw.phase === "after-prune" ? anomalyRaw.phase : null,
        count: count(anomalyRaw.count) ?? 0,
        missing: (Array.isArray(anomalyRaw.missing) ? anomalyRaw.missing : []).slice(0, 50).flatMap((item) => {
          const entry = record(item);
          const id = text(entry.id, ARCHIVE_ID);
          return id ? [{ id, name: archiveName(entry.name) }] : [];
        }),
      } : null,
      approval: text(approvalRaw.anomalyId, ANOMALY_ID) ? { anomalyId: approvalRaw.anomalyId as string, at: iso(approvalRaw.at) } : null,
      baselineAt: iso(state.baselineAt),
    },
    inventory: {
      at: iso(inventory.at),
      count: count(inventory.count) ?? 0,
      archives: (Array.isArray(inventory.archives) ? inventory.archives : []).slice(0, 60).map((item) => {
        const entry = record(item);
        return { name: archiveName(entry.name), time: iso(entry.time) };
      }),
    },
    space: totalBytes !== null && freeBytes !== null ? {
      totalBytes,
      freeBytes,
      usedPercent: count(spaceRaw.usedPercent),
    } : null,
    repoStats: Object.keys(stats).length > 0 ? {
      at: iso(stats.at),
      uniqueCompressedBytes: count(stats.uniqueCompressedBytes),
      totalSizeBytes: count(stats.totalSizeBytes),
    } : null,
    runs: (Array.isArray(parsed.runs) ? parsed.runs : []).slice(0, 10).map((item) => {
      const run = record(item);
      return {
        start: iso(run.start),
        end: iso(run.end),
        result: typeof run.result === "string" && RUN_RESULTS.has(run.result) ? run.result : "unbekannt",
        before: count(run.before),
        after: count(run.after),
        pruned: count(run.pruned),
        prunedNames: (Array.isArray(run.prunedNames) ? run.prunedNames : []).slice(0, 20).map(archiveName),
        compacted: run.compacted === true,
        compactSkipped: note(run.compactSkipped),
        settings: settingsOf(run.settings),
        note: note(run.note),
      };
    }),
  };
}

/** Die Einstellung als Executor-Ziel: `<d>-<w>-<m>-<HH:MM>` (der Broker pinnt genau diese Form). */
export function retentionTarget(settings: RetentionSettings): string {
  return `${settings.keepDaily}-${settings.keepWeekly}-${settings.keepMonthly}-${settings.time}`;
}

/** Wie bei borg.status: kein Freigabe-Envelope, nur ein Digest über die Parameter. */
export function retentionRequestDigest(payload: { action: string; target: string; expiresAt: string }): string {
  return createHash("sha256").update(JSON.stringify({ action: payload.action, target: payload.target, expiresAt: payload.expiresAt })).digest("hex");
}

export type RetentionDecision =
  | { kind: "refused"; status: 400; errors: string[] }
  | { kind: "needs-approval"; status: 409; reasons: string[] }
  | { kind: "apply"; settings: RetentionSettings; approved: boolean; belowMinimum: string[] };

/**
 * Was mit einer gewünschten Einstellung geschieht. `approval` ist nur gültig aus
 * einer Admin-Sitzung, mit `confirmed: true` und einem Grund — die Prüfung der
 * Rolle macht der Aufrufer, hier zählt nur, ob eine gültige Freigabe vorliegt.
 */
export function decideRetentionChange(input: unknown, approval: { valid: boolean }): RetentionDecision {
  const verdict = classifyRetention(input);
  if (!verdict.ok) return { kind: "refused", status: 400, errors: verdict.errors };
  if (verdict.belowMinimum.length > 0 && !approval.valid) return { kind: "needs-approval", status: 409, reasons: verdict.belowMinimum };
  return { kind: "apply", settings: verdict.settings, approved: verdict.belowMinimum.length > 0, belowMinimum: verdict.belowMinimum };
}

/** Freigabe aus dem Anfragekörper: nur Admin, ausdrücklich bestätigt, mit Grund. */
export function readApproval(role: string, body: unknown): { valid: boolean; reason: string | null; problem: string | null } {
  const raw = record(record(body).approval);
  if (Object.keys(raw).length === 0) return { valid: false, reason: null, problem: null };
  if (role !== "admin") return { valid: false, reason: null, problem: "only Jochen's cockpit session can approve; an automation token cannot" };
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  if (raw.confirmed !== true) return { valid: false, reason: null, problem: "the approval must be confirmed explicitly" };
  if (reason.length < 10) return { valid: false, reason: null, problem: "the approval needs a reason (at least 10 characters)" };
  return { valid: true, reason, problem: null };
}

export interface RetentionServiceOptions {
  /** Führt eine Executor-Aktion `borg.retention.*` aus und liefert die Helfer-Ausgabe. */
  run: (action: string, target: string) => Promise<string>;
  now?: () => number;
  /** So lange gilt ein gelesener Zustand (die Anzeige fragt öfter). */
  ttlMs?: number;
}

export function createRetentionService(options: RetentionServiceOptions) {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 15_000;
  let cached: { at: number; view: RetentionView } | null = null;
  let inFlight: Promise<RetentionView> | null = null;

  const base = { bounds: RETENTION_BOUNDS, window: RETENTION_TIME_WINDOW };

  async function read(): Promise<RetentionView> {
    try {
      const report = parseRetentionReport(await options.run("borg.retention.status", "state"));
      return report
        ? { ...base, available: true, note: null, report }
        : { ...base, available: false, note: "Helfer-Ausgabe ohne Datenblock cockpit-borg-retention/v1 — der Aufräum-Dienst ist auf diesem Host nicht eingerichtet oder älter als dieser Stand.", report: null };
    } catch (error) {
      return { ...base, available: false, note: sanitizeReason(error instanceof Error ? error.message : String(error)), report: null };
    }
  }

  async function view(force = false): Promise<RetentionView> {
    if (!force && cached && now() - cached.at < ttlMs) return cached.view;
    if (!inFlight) {
      inFlight = read().then((result) => { cached = { at: now(), view: result }; return result; }).finally(() => { inFlight = null; });
    }
    return await inFlight;
  }

  async function change(action: string, target: string): Promise<string> {
    try {
      return await options.run(action, target);
    } finally {
      cached = null;
    }
  }

  return { view, change };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./lib";

/**
 * Der Borg-Zustand im Cockpit: letzter borgmatic-Lauf (Zeitstempel, Ergebnis,
 * Exit-Status) und das Ergebnis des letzten Repo-Checks — je Wert mit Quelle.
 *
 * Die Werte kommen aus `/api/borg/status` (read-only, gemessen über die
 * typisierte Leseaktion `borg.status`). Dieses Panel zeigt an und löst höchstens
 * eine Messung aus; es repariert nichts. Fehlt der Helfer auf dem Host oder ist
 * gerade keine Messung möglich, steht hier "unknown" samt Grund — nie ein
 * geratener Wert, und nie ein grüner Check, den es nicht gab.
 */

interface BorgTimerState {
  unit: string | null;
  active: string | null;
  next: string | null;
  source: string;
}

interface BorgLastRunState {
  start: string | null;
  end: string | null;
  result: string | null;
  exitStatus: number | null;
  source: string;
}

interface BorgCheckState {
  state: "ok" | "failed" | "running" | "skipped" | "unknown";
  rc: number | null;
  at: string | null;
  unit: string | null;
  kind: string | null;
  source: string;
}

interface BorgScheduledCheckState {
  state: "skipped" | "failed" | "unknown";
  at: string | null;
  source: string;
}

interface BorgStatusView {
  state: "unknown" | "measuring" | "fresh" | "stale" | "failed";
  measuring: boolean;
  measuredAt: string | null;
  ageSeconds: number | null;
  note: string | null;
  borg: {
    generatedAt: string | null;
    host: string | null;
    role: string | null;
    timer: BorgTimerState;
    lastRun: BorgLastRunState;
    check: BorgCheckState;
    scheduledCheck: BorgScheduledCheckState;
  } | null;
}

const CHECK_LABELS: Record<BorgCheckState["state"], string> = {
  ok: "ok",
  failed: "failed",
  running: "running",
  skipped: "skipped (no check ran)",
  unknown: "unknown",
};

function formatIso(value: string | null): string {
  if (!value) return "unknown";
  return value.replace("T", " ");
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "not measured yet";
  if (seconds < 90) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

export default function BorgPanel() {
  const [view, setView] = useState<BorgStatusView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current = [];
  }, []);

  const load = useCallback(async (refresh: boolean): Promise<BorgStatusView | null> => {
    setBusy(true);
    try {
      const next = await request<BorgStatusView>(refresh ? "/borg/status/refresh" : "/borg/status", refresh ? { method: "POST" } : undefined);
      setView(next);
      setError("");
      return next;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Borg status unavailable");
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      const next = await load(false);
      if (cancelled || !next) return;
      // Eine Messung läuft in einer eigenen Unit und braucht ein paar Sekunden;
      // bis dahin bleibt der letzte Stand stehen.
      if (next.measuring && attempts < 20) {
        attempts += 1;
        timers.current.push(setTimeout(() => { void tick(); }, 2000));
      }
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [clearTimers, load]);

  const measureNow = useCallback(async () => {
    clearTimers();
    await load(true);
  }, [clearTimers, load]);

  const borg = view?.borg ?? null;

  return (
    <article className="panel borg-panel">
      <div className="borg-panel-head">
        <h2>Borg backup</h2>
        <button onClick={() => { void measureNow(); }} disabled={busy}>
          {busy ? "Measuring…" : "Measure now"}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {!borg ? (
        <p className="borg-note" data-testid="borg-unavailable">
          No measurement yet{view?.state === "measuring" ? " — a measurement is running" : ""}.
          {view?.note ? ` ${view.note}` : ""}
        </p>
      ) : (
        <ul className="list borg-list">
          <li data-testid="borg-last-run">
            <strong>Last borgmatic run</strong>
            <span className="borg-value">
              {formatIso(borg.lastRun.end)} · {borg.lastRun.result ?? "unknown"}
              {borg.lastRun.exitStatus === null ? "" : ` · exit ${borg.lastRun.exitStatus}`}
            </span>
            <span className="borg-meta">
              started {formatIso(borg.lastRun.start)} · source: {borg.lastRun.source}
            </span>
          </li>
          <li data-testid="borg-check">
            <strong>Repository check{borg.check.kind ? ` (${borg.check.kind})` : ""}</strong>
            <span className={`borg-value borg-state-${borg.check.state}`}>
              {CHECK_LABELS[borg.check.state]}
              {borg.check.rc === null ? "" : ` · rc ${borg.check.rc}`}
              {borg.check.at === null ? "" : ` · ${formatIso(borg.check.at)}`}
            </span>
            <span className="borg-meta">
              {borg.check.unit ? `${borg.check.unit} · ` : ""}source: {borg.check.source || "none"}
            </span>
          </li>
          <li data-testid="borg-scheduled-check">
            <strong>Nightly run&apos;s consistency check</strong>
            <span className="borg-value">
              {borg.scheduledCheck.state === "unknown" ? "unknown" : borg.scheduledCheck.state}
              {borg.scheduledCheck.at === null ? "" : ` · ${formatIso(borg.scheduledCheck.at)}`}
            </span>
            <span className="borg-meta">
              source: {borg.scheduledCheck.source} — borgmatic only checks after its configured frequency, so
              &quot;skipped&quot; is not a passed check.
            </span>
          </li>
          <li data-testid="borg-timer">
            <strong>Backup timer</strong>
            <span className="borg-value">
              {borg.timer.unit ?? "unknown"} · {borg.timer.active ?? "unknown"} · next {formatIso(borg.timer.next)}
            </span>
            <span className="borg-meta">
              source: {borg.timer.source} · host {borg.host ?? "unknown"} ({borg.role ?? "unknown"})
            </span>
          </li>
        </ul>
      )}

      <p className="borg-meta" data-testid="borg-freshness">
        state {view?.state ?? "unknown"} · measured {formatAge(view?.ageSeconds ?? null)} ({formatIso(view?.measuredAt ?? null)})
        {view?.measuring ? " · measuring now" : ""}
      </p>
      {view?.note && borg ? <p className="borg-note">{view.note}</p> : null}
    </article>
  );
}

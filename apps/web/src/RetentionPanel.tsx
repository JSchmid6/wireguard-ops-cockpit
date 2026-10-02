import { useCallback, useEffect, useState, type FormEvent } from "react";
import { request } from "./lib";

/**
 * Backup-Aufbewahrung: der Aufräum-Dienst auf Lab0 (doc/setup/borg-retention.md).
 *
 * Zeigt Einstellung, feste Grenzen, Status, letzte Läufe, Bestand und Platz aus
 * `/api/borg/retention` und ändert die Einstellung. Die Grenzen prüfen API und
 * Helfer; dieses Panel zeigt sie nur an. Unter der Untergrenze und nach einer
 * Anomalie fragt es nach Jochens Freigabe (bestätigt, mit Grund) — ob sie gilt,
 * entscheidet der Server.
 */

interface Settings {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  time: string;
}

interface Bound { floor: number; min: number; max: number }

interface Run {
  start: string | null;
  end: string | null;
  result: string;
  before: number | null;
  after: number | null;
  pruned: number | null;
  compacted: boolean;
  compactSkipped: string | null;
  note: string | null;
}

interface Report {
  measuredAt: string | null;
  host: string | null;
  installed: { service: boolean; timer: boolean; passphrase: string };
  settings: (Settings & { approved: boolean; changedAt: string | null; source: string }) | null;
  settingsError: string | null;
  timer: { active: string | null; next: string | null };
  service: { active: string | null };
  state: {
    status: "neu" | "ok" | "angehalten" | null;
    anomaly: { id: string; detectedAt: string | null; count: number; missing: Array<{ id: string; name: string }> } | null;
    approval: { anomalyId: string; at: string | null } | null;
    baselineAt: string | null;
  };
  inventory: { at: string | null; count: number; archives: Array<{ name: string; time: string | null }> };
  space: { totalBytes: number; freeBytes: number; usedPercent: number | null } | null;
  repoStats: { uniqueCompressedBytes: number | null } | null;
  runs: Run[];
}

interface RetentionView {
  available: boolean;
  note: string | null;
  bounds: { keepDaily: Bound; keepWeekly: Bound; keepMonthly: Bound };
  window: { earliest: string; latest: string };
  report: Report | null;
}

const FIELDS: Array<{ key: "keepDaily" | "keepWeekly" | "keepMonthly"; label: string }> = [
  { key: "keepDaily", label: "keep daily" },
  { key: "keepWeekly", label: "keep weekly" },
  { key: "keepMonthly", label: "keep monthly" },
];

const STATUS_LABELS: Record<string, string> = {
  ok: "ok",
  neu: "new — no run yet",
  angehalten: "halted — waiting for Jochen's approval",
};

function formatIso(value: string | null): string {
  return value ? value.replace("T", " ").replace(/\.\d+/, "") : "unknown";
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default function RetentionPanel() {
  const [view, setView] = useState<RetentionView | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsApproval, setNeedsApproval] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");

  const show = useCallback((next: RetentionView) => {
    setView(next);
    if (next.report?.settings) {
      const { keepDaily, keepWeekly, keepMonthly, time } = next.report.settings;
      setForm({ keepDaily, keepWeekly, keepMonthly, time });
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      show(await request<RetentionView>("/borg/retention"));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Backup retention unavailable");
    } finally {
      setBusy(false);
    }
  }, [show]);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (path: string, init: RequestInit) => {
    setBusy(true);
    try {
      show(await request<RetentionView>(path, init));
      setError("");
      setNeedsApproval(null);
      setConfirmed(false);
      setReason("");
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }, [show]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const below = view ? FIELDS.filter(({ key }) => form[key] < view.bounds[key].min) : [];
    if (below.length > 0 && !needsApproval) {
      // Unter der Untergrenze: erst die Freigabe einholen, dann senden.
      setNeedsApproval(below.map(({ key, label }) => `${label} ${form[key]} is below the minimum ${view!.bounds[key].min}`).join("; "));
      return;
    }
    await send("/borg/retention", { method: "PUT", body: JSON.stringify({ ...form, ...(needsApproval ? { approval: { confirmed, reason } } : {}) }) });
  };

  const report = view?.report ?? null;
  const anomaly = report?.state.status === "angehalten" ? report.state.anomaly : null;

  return (
    <article className="panel borg-panel retention-panel">
      <div className="borg-panel-head">
        <h2>Backup retention (Lab0)</h2>
        <button onClick={() => { void send("/borg/retention/run", { method: "POST" }); }} disabled={busy || !report}>
          Run now
        </button>
      </div>

      {error ? <p className="error" data-testid="retention-error">{error}</p> : null}

      {!view ? null : !report ? (
        <p className="borg-note" data-testid="retention-unavailable">
          The cleanup service is not available on this host. {view.note ?? ""}
        </p>
      ) : (
        <>
          <ul className="list borg-list">
            <li data-testid="retention-status">
              <strong>Status</strong>
              <span className={`borg-value retention-status-${report.state.status ?? "unknown"}`}>
                {STATUS_LABELS[report.state.status ?? ""] ?? "unknown"}
              </span>
              <span className="borg-meta">
                service {report.service.active ?? "unknown"} · timer {report.timer.active ?? "unknown"}, next {formatIso(report.timer.next)} · host {report.host ?? "unknown"}
                {report.installed.passphrase !== "ok" ? ` · passphrase file: ${report.installed.passphrase}` : ""}
              </span>
            </li>
            <li data-testid="retention-space">
              <strong>Space</strong>
              <span className="borg-value">
                {report.space ? `${formatBytes(report.space.freeBytes)} free of ${formatBytes(report.space.totalBytes)} (${report.space.usedPercent ?? "?"} % used)` : "unknown"}
              </span>
              <span className="borg-meta">repository size (deduplicated): {formatBytes(report.repoStats?.uniqueCompressedBytes)}</span>
            </li>
            <li data-testid="retention-inventory">
              <strong>Inventory</strong>
              <span className="borg-value">{report.inventory.count} archive(s) at the last run ({formatIso(report.inventory.at)})</span>
              <details>
                <summary className="borg-meta">archives</summary>
                <ul className="retention-archives">
                  {report.inventory.archives.map((item) => <li key={item.name}>{item.name}</li>)}
                </ul>
              </details>
            </li>
          </ul>

          {anomaly ? (
            <section className="retention-anomaly" data-testid="retention-anomaly">
              <p className="error">
                Halted: {anomaly.count} archive(s) are missing that this service did not remove (detected {formatIso(anomaly.detectedAt)}).
                Nothing was compacted — the archives can still be recovered.
              </p>
              <ul className="retention-archives">
                {anomaly.missing.map((item) => <li key={item.id}>{item.name}</li>)}
              </ul>
              {report.state.approval?.anomalyId === anomaly.id ? (
                <p className="borg-meta">Approved {formatIso(report.state.approval.at)} — the next run continues and compacts.</p>
              ) : (
                <div className="retention-approval">
                  <label>
                    <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                    I approve: these archives are gone for good once the service compacts.
                  </label>
                  <input value={reason} placeholder="reason (at least 10 characters)" onChange={(event) => setReason(event.target.value)} />
                  <button
                    disabled={busy || !confirmed || reason.trim().length < 10}
                    onClick={() => { void send("/borg/retention/resume", { method: "POST", body: JSON.stringify({ anomalyId: anomaly.id, approval: { confirmed, reason } }) }); }}
                  >
                    Approve and resume
                  </button>
                </div>
              )}
            </section>
          ) : null}

          {form ? (
            <form className="retention-form" onSubmit={(event) => { void save(event); }}>
              {FIELDS.map(({ key, label }) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={view!.bounds[key].floor}
                    max={view!.bounds[key].max}
                    value={form[key]}
                    onChange={(event) => { setNeedsApproval(null); setForm({ ...form, [key]: Number(event.target.value) }); }}
                  />
                  <span className="borg-meta">min {view!.bounds[key].min}, max {view!.bounds[key].max}</span>
                </label>
              ))}
              <label>
                time
                <input type="time" value={form.time} min={view!.window.earliest} max={view!.window.latest} onChange={(event) => setForm({ ...form, time: event.target.value })} />
                <span className="borg-meta">{view!.window.earliest}–{view!.window.latest}</span>
              </label>
              {needsApproval ? (
                <div className="retention-approval" data-testid="retention-needs-approval">
                  <p className="error">{needsApproval} — this needs Jochen&apos;s approval.</p>
                  <label>
                    <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                    I approve keeping fewer backups than the minimum.
                  </label>
                  <input value={reason} placeholder="reason (at least 10 characters)" onChange={(event) => setReason(event.target.value)} />
                </div>
              ) : null}
              <button type="submit" disabled={busy || (needsApproval !== null && (!confirmed || reason.trim().length < 10))}>
                {needsApproval ? "Approve and save" : "Save retention"}
              </button>
              <span className="borg-meta">
                {report.settings?.source === "cockpit" ? `set ${formatIso(report.settings.changedAt)}${report.settings.approved ? " (below the minimum, approved)" : ""}` : "default retention"}
              </span>
            </form>
          ) : <p className="borg-note">{report.settingsError ?? "No valid retention setting."}</p>}

          <table className="retention-runs" data-testid="retention-runs">
            <thead>
              <tr><th>run</th><th>result</th><th>archives</th><th>pruned</th><th>compacted</th></tr>
            </thead>
            <tbody>
              {report.runs.map((run) => (
                <tr key={`${run.start}-${run.end}`}>
                  <td>{formatIso(run.start)}</td>
                  <td title={run.note ?? ""}>{run.result}</td>
                  <td>{run.before ?? "?"} → {run.after ?? "?"}</td>
                  <td>{run.pruned ?? "?"}</td>
                  <td title={run.compactSkipped ?? ""}>{run.compacted ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </article>
  );
}

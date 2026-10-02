import { useCallback, useEffect, useState } from "react";
import { request } from "./lib";

/**
 * "Wartet auf dich": die Startseite nach dem Login (doc/setup/wartet-auf-dich.md).
 *
 * Zeigt alles, was Jochen entscheiden muss, als Karte — Absicht in einem Satz,
 * Grund des Stopps, die Befunde des Prüfers (ausklappbar), die Frist bis zum
 * Ablauf des Envelopes und die Knöpfe mit Pflichtfeld Grund. Gebaut für das
 * Handy: schmale Breite zuerst, große Knöpfe. Ob eine Entscheidung gilt,
 * entscheidet der Server; diese Seite ruft nur die bestehenden Wege auf.
 */

interface Finding {
  source: "doorkeeper" | "update-review" | "backup-bolt";
  title: string;
  guarantee: string;
  location: string;
  severity: string;
  detail: string;
}

export interface InboxCard {
  id: string;
  kind: "hermes-change" | "backup-bolt" | "approval" | "retention-anomaly";
  title: string;
  reason: string;
  findings: Finding[];
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  link: string;
  jobId?: string;
  approvalId?: string;
  anomalyId?: string;
}

interface InboxStatus {
  lastRuns: Array<{ id: string; status: string; at: string }>;
  backup: { lastRunEnd: string | null; lastRunResult: string | null; measuredAt: string | null } | null;
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
}

interface InboxView {
  generatedAt: string;
  cards: InboxCard[];
  status: InboxStatus;
}

const KIND_LABELS: Record<InboxCard["kind"], string> = {
  "hermes-change": "Änderung von James",
  "backup-bolt": "Backup-Riegel",
  approval: "Freigabe",
  "retention-anomaly": "Aufräum-Dienst",
};

const SOURCE_LABELS: Record<Finding["source"], string> = {
  doorkeeper: "Türsteher",
  "update-review": "Update-Prüfer",
  "backup-bolt": "Backup-Riegel",
};

const POLL_MS = 30_000;

/** Countdown "mm:ss" bzw. "h:mm:ss"; null, wenn die Frist vorbei ist. */
export function countdown(expiresAt: string, now: number): string | null {
  const left = Math.floor((Date.parse(expiresAt) - now) / 1000);
  if (Number.isNaN(left) || left <= 0) return null;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function age(iso: string | null, now: number): string {
  if (!iso) return "unbekannt";
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return "unbekannt";
  if (minutes < 60) return `vor ${Math.max(minutes, 0)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `vor ${hours} h` : `vor ${Math.round(hours / 24)} Tagen`;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB`;
}

export function statusLine(status: InboxStatus, now: number): string {
  const parts: string[] = [];
  const last = status.lastRuns[0];
  parts.push(last ? `Letzter Lauf ${age(last.at, now)} (${last.status})` : "Noch keine Läufe");
  parts.push(status.backup?.lastRunEnd
    ? `Backup ${age(status.backup.lastRunEnd, now)}${status.backup.lastRunResult ? ` (${status.backup.lastRunResult})` : ""}`
    : "Backup-Alter unbekannt");
  parts.push(status.disk ? `Platte ${status.disk.path}: ${gigabytes(status.disk.freeBytes)} frei von ${gigabytes(status.disk.totalBytes)}` : "Plattenplatz unbekannt");
  return parts.join(" · ");
}

function FindingItem({ finding }: { finding: Finding }) {
  return (
    <li className="inbox-finding">
      <details>
        <summary>
          <strong>{finding.title}</strong>
          <span className="inbox-finding-meta">
            {SOURCE_LABELS[finding.source]}
            {finding.guarantee ? ` · ${finding.guarantee}` : ""}
            {finding.location ? ` · ${finding.location}` : ""}
            {finding.severity ? ` · ${finding.severity}` : ""}
          </span>
        </summary>
        {finding.detail ? <pre>{finding.detail}</pre> : <p>Keine Begründung gespeichert.</p>}
      </details>
    </li>
  );
}

function Card({ card, now, highlighted, onDone }: { card: InboxCard; now: number; highlighted: boolean; onDone: (message: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Kam die Freigabe knapp zu spät (Handyuhr, letzte Sekunden), lehnt der
  // Server sie ab; die Karte bleibt und bietet dann "Neu bestellen lassen".
  const [refusedAsExpired, setRefusedAsExpired] = useState(false);
  const left = card.expiresAt ? countdown(card.expiresAt, now) : null;
  const expired = card.expired || refusedAsExpired || (card.expiresAt !== null && left === null);
  const trimmed = reason.trim();
  // Der Aufräum-Dienst verlangt für die Freigabe mindestens 10 Zeichen (borg-retention.ts).
  const minLength = card.kind === "retention-anomaly" ? 10 : 1;
  const reasonOk = trimmed.length >= minLength;

  async function act(kind: "approve" | "reject" | "reorder") {
    setBusy(true);
    setError("");
    try {
      if (card.jobId && card.kind !== "approval") {
        if (kind === "reorder") {
          await request(`/inbox/jobs/${card.jobId}/reorder`, { method: "POST", body: JSON.stringify({ note: trimmed || null }) });
        } else {
          await request(`/hermes/jobs/${card.jobId}/approval`, { method: "POST", body: JSON.stringify({ decision: kind === "approve" ? "approved" : "rejected", reason: trimmed }) });
        }
      } else if (card.approvalId) {
        await request(`/approvals/${card.approvalId}/decision`, { method: "POST", body: JSON.stringify({ decision: kind === "approve" ? "approved" : "rejected", reason: trimmed }) });
      } else if (card.anomalyId) {
        if (kind === "approve") {
          await request("/borg/retention/resume", { method: "POST", body: JSON.stringify({ anomalyId: card.anomalyId, approval: { confirmed: true, reason: trimmed } }) });
        } else {
          await request(`/inbox/retention/${card.anomalyId}/keep`, { method: "POST", body: JSON.stringify({ reason: trimmed }) });
        }
      }
      const labels = { approve: "Freigegeben", reject: "Abgelehnt", reorder: "Neu bestellt" };
      await onDone(`${labels[kind]}: ${card.title}`);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Die Entscheidung ging nicht durch.";
      if (kind === "approve" && /expired|envelope validation failed/i.test(message)) setRefusedAsExpired(true);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article id={`karte-${card.id}`} className={`inbox-card${highlighted ? " inbox-card-highlight" : ""}${expired ? " inbox-card-expired" : ""}`} data-testid="inbox-card">
      <div className="inbox-card-head">
        <span className="step-badge">{KIND_LABELS[card.kind]}</span>
        {card.expiresAt ? (
          expired
            ? <span className="inbox-deadline inbox-deadline-expired">Abgelaufen</span>
            : <span className="inbox-deadline" aria-label="Frist">läuft ab in {left}</span>
        ) : null}
      </div>
      <h3 className="inbox-title">{card.title}</h3>
      <p className="inbox-reason"><strong>Warum gestoppt:</strong> {card.reason}</p>
      {card.findings.length > 0 ? (
        <div>
          <strong>Befunde ({card.findings.length})</strong>
          <ul className="inbox-findings">
            {card.findings.map((finding, index) => <FindingItem key={index} finding={finding} />)}
          </ul>
        </div>
      ) : null}
      {expired ? (
        <p className="inbox-expired-note">
          {card.kind === "approval"
            ? "Die Frist ist abgelaufen: Diese Freigabe gilt nicht mehr. Plane den Lauf unter „Mehr“ neu; hier kannst du sie nur noch ablehnen."
            : "Die Frist ist abgelaufen: Diese Freigabe gilt nicht mehr. Lass James die Änderung neu bestellen — dann wird sie frisch geprüft."}
        </p>
      ) : null}
      <label className="inbox-reason-field">
        {expired && card.kind !== "approval" ? "Notiz an James (optional)" : `Grund (Pflicht${minLength > 1 ? `, mind. ${minLength} Zeichen` : ""})`}
        <textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="inbox-actions">
        {expired && card.jobId && card.kind !== "approval" ? (
          <button className="inbox-button inbox-button-primary" disabled={busy} onClick={() => act("reorder")}>
            Neu bestellen lassen
          </button>
        ) : !expired ? (
          <button className="inbox-button inbox-button-primary" disabled={busy || !reasonOk} onClick={() => act("approve")}>
            Freigeben
          </button>
        ) : null}
        <button className="inbox-button inbox-button-danger" disabled={busy || !trimmed} onClick={() => act("reject")}>
          {card.kind === "retention-anomaly" ? "Ablehnen (angehalten lassen)" : "Ablehnen"}
        </button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </article>
  );
}

export default function Inbox({ refreshKey = 0, onDecided }: { refreshKey?: number; onDecided?: () => void | Promise<void> }) {
  const [view, setView] = useState<InboxView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));

  const load = useCallback(async () => {
    try {
      setView(await request<InboxView>("/inbox"));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Die Liste konnte nicht geladen werden.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener("hashchange", onHash);
    };
  }, [load]);

  // Direktlink aus Telegram (#karte-<id>): zur Karte springen, sobald sie da ist.
  const target = hash.startsWith("#karte-") ? hash.slice("#karte-".length) : "";
  useEffect(() => {
    if (!target || !view) return;
    const element = document.getElementById(`karte-${target}`);
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [target, view]);

  async function done(message: string) {
    setNotice(message);
    await load();
    if (onDecided) await onDecided();
  }

  const cards = view?.cards ?? [];
  const missingTarget = Boolean(target && view && !cards.some((card) => card.id === target));

  return (
    <section className="inbox" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading" className="inbox-heading">
        Wartet auf dich{cards.length > 0 ? <span className="inbox-count"> ({cards.length})</span> : null}
      </h2>
      {notice ? <p className="inbox-notice" role="status">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {missingTarget ? <p className="inbox-notice">Die verlinkte Karte wartet nicht mehr — schon entschieden oder neu bestellt.</p> : null}
      {!view && !error ? <p>Lade …</p> : null}
      {view && cards.length === 0 ? (
        <div className="inbox-empty">
          <p className="inbox-empty-title">Nichts wartet auf dich</p>
          <p className="inbox-empty-status" data-testid="inbox-status">{statusLine(view.status, now)}</p>
        </div>
      ) : null}
      {cards.map((card) => (
        <Card key={card.id} card={card} now={now} highlighted={card.id === target} onDone={done} />
      ))}
    </section>
  );
}

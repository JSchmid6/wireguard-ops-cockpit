// "Wartet auf dich": alles, was Jochen entscheiden muss, als Karten.
//
// Reine Funktionen — sie lesen nur, was der Job oder die Freigabe ohnehin
// gespeichert hat, und bauen daraus die Karte für die Startseite. Entschieden
// wird weiter über die bestehenden Wege (POST /api/hermes/jobs/:id/approval,
// POST /api/approvals/:id/decision, POST /api/borg/retention/resume); die
// Karten ändern an Schloss, Türsteher und Riegel nichts.
import type { ApprovalRecord, JobRecord } from "@wireguard-ops-cockpit/domain";

export type InboxKind = "hermes-change" | "backup-bolt" | "approval" | "retention-anomaly";

export interface InboxFinding {
  // Woher der Befund stammt: Türsteher (host-run), Update-Prüfer, Backup-Riegel.
  source: "doorkeeper" | "update-review" | "backup-bolt";
  title: string;
  // Garantie oder Klasse, gegen die der Befund steht (G1, X4, prune, ...).
  guarantee: string;
  // Datei und Zeile (Update-Prüfer) bzw. Schritt und Zeile (host-run, S2:L3).
  location: string;
  severity: string;
  // Begründung, ausklappbar: der Pfad zum Schaden und der zitierte Code.
  detail: string;
}

export interface InboxCard {
  id: string;
  kind: InboxKind;
  // Die Absicht in einem Satz.
  title: string;
  // Warum gestoppt wurde.
  reason: string;
  findings: InboxFinding[];
  createdAt: string;
  // Ablauf des Envelopes bzw. der Freigabe; null, wo nichts abläuft.
  expiresAt: string | null;
  expired: boolean;
  // Direktlink auf die Karte (Hash-Anker der Startseite).
  link: string;
  jobId?: string;
  approvalId?: string;
  anomalyId?: string;
}

const clip = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Ein Satz: bis zum ersten Satzende oder Zeilenumbruch, höchstens 200 Zeichen. */
export function oneSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const match = flat.match(/^.+?[.!?](?=\s|$)/);
  return clip(match ? match[0] : flat, 200);
}

export function cardLink(cardId: string, webUrl: string | null): string {
  const base = webUrl ? webUrl.replace(/\/+$/, "") : "";
  return `${base}/#karte-${cardId}`;
}

function isExpired(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || now > at;
}

/** Befunde aus dem gespeicherten Prüfmaterial des Jobs, nur die belegten. */
export function jobFindings(output: Record<string, unknown>): InboxFinding[] {
  const findings: InboxFinding[] = [];
  const safetyDetails = record(record(output.safety).details);
  for (const finding of list(safetyDetails.findings)) {
    // Der Türsteher verwirft unbelegte Befunde selbst; sie stoppen nichts und
    // gehören nicht auf die Karte.
    if (finding.evidenced !== true) continue;
    findings.push({
      source: "doorkeeper",
      title: clip(str(finding.title) || "(ohne Titel)", 200),
      guarantee: clip(str(finding.class), 40),
      location: clip(str(finding.where), 60),
      severity: clip(str(finding.severity), 20),
      detail: clip([str(finding.path), str(finding.code) ? `Code:\n${str(finding.code)}` : ""].filter(Boolean).join("\n\n"), 4000),
    });
  }
  for (const hit of list(safetyDetails.backupGuard)) {
    findings.push({
      source: "backup-bolt",
      title: clip(str(hit.reason) || "Backup-Riegel", 200),
      guarantee: clip(str(hit.kind), 40),
      location: clip(str(hit.where), 60),
      severity: "",
      detail: clip(str(hit.code) ? `Code:\n${str(hit.code)}` : "", 1000),
    });
  }
  for (const finding of list(record(output.updateReview).findings)) {
    findings.push({
      source: "update-review",
      title: clip(str(finding.title) || "(ohne Titel)", 200),
      guarantee: clip(str(finding.guarantee), 40),
      location: clip(str(finding.file), 300),
      severity: clip(str(finding.severity), 20),
      detail: clip([str(finding.reason), str(finding.code) ? `Code:\n${str(finding.code)}` : ""].filter(Boolean).join("\n\n"), 4000),
    });
  }
  return findings;
}

export function hermesJobCard(job: JobRecord, now: number, webUrl: string | null): InboxCard {
  const output = record(job.output);
  const explanation = record(output.explanation);
  const policy = record(output.policy);
  const envelope = record(output.envelope);
  const findings = jobFindings(output);
  const expiresAt = str(envelope.expiresAt) || null;
  const id = `job-${job.id}`;
  return {
    id,
    kind: findings.some((finding) => finding.source === "backup-bolt") ? "backup-bolt" : "hermes-change",
    title: oneSentence(str(explanation.intent) || "Änderung von James"),
    reason: clip(str(policy.reason) || str(explanation.reason) || "Kein Grund gespeichert.", 1200),
    findings,
    createdAt: job.createdAt,
    // Ohne Envelope gibt es nichts freizugeben: die Karte gilt als abgelaufen.
    expiresAt,
    expired: expiresAt ? isExpired(expiresAt, now) : true,
    link: cardLink(id, webUrl),
    jobId: job.id,
  };
}

export function approvalCard(approval: ApprovalRecord, job: JobRecord | null, ttlMinutes: number, now: number, webUrl: string | null): InboxCard {
  const output = record(job?.output);
  const expiresAt = new Date(Date.parse(approval.createdAt) + ttlMinutes * 60_000).toISOString();
  const id = `approval-${approval.id}`;
  const summary = str(output.summary) || str(record(output.explanation).intent) || (job ? `${job.kind} ${job.subjectId ?? ""}`.trim() : "Freigabe");
  return {
    id,
    kind: "approval",
    title: oneSentence(summary),
    reason: clip(approval.reason || "Der Plan verlangt eine Freigabe.", 1200),
    findings: [],
    createdAt: approval.createdAt,
    expiresAt,
    expired: isExpired(expiresAt, now),
    link: cardLink(id, webUrl),
    jobId: approval.jobId,
    approvalId: approval.id,
  };
}

export interface RetentionAnomalyInput {
  id: string;
  detectedAt: string | null;
  phase: string | null;
  count: number;
  missing: Array<{ id: string; name: string }>;
}

export function retentionAnomalyCard(anomaly: RetentionAnomalyInput, now: number, webUrl: string | null): InboxCard {
  const id = `retention-${anomaly.id}`;
  const names = anomaly.missing.slice(0, 20).map((item) => item.name);
  return {
    id,
    kind: "retention-anomaly",
    title: `Der Aufräum-Dienst auf Lab0 ist angehalten: ${anomaly.count} Archiv(e) fehlen, die er nicht selbst entfernt hat.`,
    reason: "Bis zu deiner Freigabe räumt er nicht weiter auf und verdichtet nicht (compact). Prüfe zuerst, wer die Archive entfernt hat.",
    findings: names.length ? [{
      source: "backup-bolt",
      title: `${anomaly.count} fehlende(s) Archiv(e)${anomaly.phase ? ` (${anomaly.phase})` : ""}`,
      guarantee: "Anomalie",
      location: "Lab0 borg-Repo",
      severity: "",
      detail: names.join("\n") + (anomaly.missing.length > names.length ? `\n… ${anomaly.missing.length - names.length} weitere` : ""),
    }] : [],
    createdAt: anomaly.detectedAt || new Date(now).toISOString(),
    expiresAt: null,
    expired: false,
    link: cardLink(id, webUrl),
    anomalyId: anomaly.id,
  };
}

/** Älteste Frist zuerst, abgelaufene ans Ende. */
export function sortCards(cards: InboxCard[]): InboxCard[] {
  const key = (card: InboxCard) => (card.expired ? Number.MAX_SAFE_INTEGER : card.expiresAt ? Date.parse(card.expiresAt) : Number.MAX_SAFE_INTEGER - 1);
  return [...cards].sort((a, b) => key(a) - key(b) || a.createdAt.localeCompare(b.createdAt));
}

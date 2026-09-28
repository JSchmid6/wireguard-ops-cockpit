import type { JobRecord } from "@wireguard-ops-cockpit/domain";

/**
 * Ein Change-Job, der auf den Menschen wartet, ist keine Zeile in der
 * Approvals-Tabelle: er ist der Job selbst, angehalten bei
 * `blocked_user_approval` (Status `blocked_user_approval`, Betreff
 * `hermes-change`). Die Approvals-Ansicht im Web muss genau die Entscheidungen
 * zeigen, die der Operator treffen soll — also dieselben Fakten, die die CLI
 * aus `job.output` liest. Deshalb wird hier ausschließlich die Erklärung des
 * Jobs ausgewertet; es entsteht keine zweite Wahrheit und keine geratene Zeile.
 */
export interface ChangeApprovalSummary {
  jobId: string;
  /** Das geprüfte Vorhaben (trusted intent), sonst die erste Planzeile. */
  title: string;
  /** Eine Zeile des Plans; der ganze Vorschlag steht im Job. */
  planSummary: string;
  /** Warum der Plan beim Operator angehalten wurde. */
  reason: string;
  /** Befunde des Vorabchecks: Sicherheitsurteil und Policy-Belege. */
  findings: string[];
  /** Ablaufzeit der Freigabe (Signatur-Hülle); null, wenn keine existiert. */
  expiresAt: string | null;
}

const PLAN_LINE_LIMIT = 240;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => text(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/**
 * Die Liste zeigt eine Planzeile — Überschriften- und Listenzeichen des
 * Markdown-Plans gehören nicht dorthin, ebenso wenig eine Zaunzeile eines
 * Codeblocks; der volle Text bleibt im Job. Gekürzt wird sichtbar, nie durch
 * Abschneiden eines Satzes ins Nichts.
 */
export function planHeadline(plan: string): string {
  const line = plan
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("```"))
    .map((entry) => entry.replace(/^[#>*\-\s]+/, "").trim())
    .find((entry) => entry.length > 0);

  if (!line) {
    return "";
  }
  return line.length > PLAN_LINE_LIMIT ? `${line.slice(0, PLAN_LINE_LIMIT - 1)}…` : line;
}

export function summarizeChangeApproval(job: JobRecord): ChangeApprovalSummary {
  const output = record(job.output);
  const explanation = record(output.explanation);
  const planSummary = planHeadline(text(output.plan) || "");

  return {
    jobId: job.id,
    title: text(explanation.intent) || planSummary || "Hermes change awaiting operator approval",
    planSummary,
    reason: text(explanation.reason) || "The plan was stopped for operator approval.",
    findings: strings(explanation.evidence),
    expiresAt: text(record(output.envelope).expiresAt),
  };
}

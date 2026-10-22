import { createHash } from "node:crypto";

// Circuit Breaker der Änderungsjobs (Vorfall 22.10.2026, Karte t_dc5c96c6).
//
// - Es zählen nur echte Fehlläufe: Jobs, deren Ausführung auf dem Host begann
//   und die danach scheiterten (failed_execution/failed_verification nach dem
//   Start). Abweisungen vor der Ausführung (Manifest, Policy, Türsteher) zählen
//   nicht; sie tragen ihre eigene genaue Fehlermeldung.
// - Er gilt pro Vorgang: der Schlüssel kommt aus dem Auftrag (`operation`, etwa
//   die Kanban-Karte) oder, ohne ihn, aus dem Intent. Ein scheiternder Vorgang
//   sperrt keine unabhängige Änderung. Darüber liegt ein höherer globaler Deckel.
// - Seine Meldung nennt die zählenden Jobs und den Zeitpunkt, ab dem er schließt.

export const BREAKER_WINDOW_MS = 60 * 60_000;
export const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

// Der Vorgangsschlüssel: ein ausdrücklich genannter Vorgang, sonst der Intent.
export function breakerKeyFor(operation: string | null | undefined, intent: string): string {
  if (operation) return `operation:${operation}`;
  return `intent:${createHash("sha256").update(intent.trim()).digest("hex").slice(0, 16)}`;
}

export interface BreakerFailure {
  jobId: string;
  at: string;
  // Fehlläufe von vor dem Umbau tragen keinen Schlüssel: sie zählen nur global.
  key: string | null;
}

export interface BreakerState {
  scope: "operation" | "global";
  key: string | null;
  count: number;
  limit: number;
  jobIds: string[];
  windowStart: string;
  closesAt: string;
}

function openState(scope: BreakerState["scope"], key: string | null, failures: BreakerFailure[], limit: number, windowStart: string, windowMs: number): BreakerState | null {
  if (failures.length < limit) return null;
  const sorted = [...failures].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Er schließt, sobald nur noch limit-1 Fehlläufe im Fenster liegen: wenn der
  // (n-limit+1)-älteste aus dem Fenster fällt.
  const leaving = sorted[sorted.length - limit];
  return {
    scope, key, count: sorted.length, limit, jobIds: sorted.map((failure) => failure.jobId), windowStart,
    closesAt: new Date(Date.parse(leaving.at) + windowMs).toISOString(),
  };
}

export function evaluateBreaker(
  failures: BreakerFailure[], key: string, limits: { perOperation: number; global: number }, now: number, windowMs = BREAKER_WINDOW_MS,
): BreakerState | null {
  const windowStart = new Date(now - windowMs).toISOString();
  const recent = failures.filter((failure) => Date.parse(failure.at) >= now - windowMs);
  return openState("operation", key, recent.filter((failure) => failure.key === key), limits.perOperation, windowStart, windowMs)
    ?? openState("global", null, recent, limits.global, windowStart, windowMs);
}

export function breakerReason(state: BreakerState): string {
  const where = state.scope === "operation" ? `for this operation (${state.key})` : "for all change jobs (global cap)";
  return `Circuit breaker is open ${where}: ${state.count} failed change jobs in the last hour (limit ${state.limit}; jobs ${state.jobIds.join(", ")}). `
    + `It closes at ${state.closesAt}. The operator can let this one job through with the approval link.`;
}

import { describe, expect, it } from "vitest";
import type { JobRecord } from "@wireguard-ops-cockpit/domain";
import { planHeadline, summarizeChangeApproval } from "../src/change-approvals.js";

function makeJob(output: Record<string, unknown> | null): JobRecord {
  return {
    id: "job-2b24d99f",
    sessionId: "session-1",
    kind: "runbook",
    subjectId: "hermes-change",
    status: "blocked_user_approval",
    requiresApproval: false,
    approvalId: null,
    output,
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:04:00.000Z",
    completedAt: "2026-09-28T12:04:00.000Z"
  };
}

describe("change approvals", () => {
  it("baut aus einem angehaltenen Job die Zeile der Freigabe-Ansicht", () => {
    const summary = summarizeChangeApproval(
      makeJob({
        plan: "# Plan: Email-Archive-Image aktualisieren\n\n1. Image ziehen\n2. Container neu starten\n",
        explanation: {
          phase: "finished",
          intent: "Update the Email Archive image to the reviewed digest",
          reason: "The plan needs the operator: it replaces a running container image.",
          evidence: [
            "Safety review: no rollback for the image swap.",
            "policy: container image replacement needs operator approval"
          ],
          neededToContinue: ["Approve the plan or narrow it to a read-only check."]
        },
        envelope: { expiresAt: "2026-09-28T14:30:00.000Z" }
      })
    );

    expect(summary).toEqual({
      jobId: "job-2b24d99f",
      title: "Update the Email Archive image to the reviewed digest",
      planSummary: "Plan: Email-Archive-Image aktualisieren",
      reason: "The plan needs the operator: it replaces a running container image.",
      findings: [
        "Safety review: no rollback for the image swap.",
        "policy: container image replacement needs operator approval"
      ],
      expiresAt: "2026-09-28T14:30:00.000Z"
    });
  });

  it("nimmt eine Planzeile ohne Markdown-Zeichen, kürzt lange Zeilen und rät nichts", () => {
    expect(planHeadline("# Plan: Nextcloud neu starten")).toBe("Plan: Nextcloud neu starten");
    expect(planHeadline("   - `docker compose pull`")).toBe("`docker compose pull`");
    expect(planHeadline("* Schritt 1\n* Schritt 2")).toBe("Schritt 1");
    expect(planHeadline("   \n\n   ")).toBe("");
    // Eine Zaunzeile ist kein Plan: der Kopf der Liste soll den Schritt zeigen.
    expect(planHeadline("```yaml\nrestart: nextcloud\n```")).toBe("restart: nextcloud");
    expect(planHeadline("```yaml\n```")).toBe("");

    const long = planHeadline(`## ${"a".repeat(400)}`);
    expect(long.length).toBe(240);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("a")).toBe(true);
  });

  it("lässt Felder leer, wenn der Job keine Erklärung trägt", () => {
    expect(summarizeChangeApproval(makeJob(null))).toEqual({
      jobId: "job-2b24d99f",
      title: "Hermes change awaiting operator approval",
      planSummary: "",
      reason: "The plan was stopped for operator approval.",
      findings: [],
      expiresAt: null
    });

    // Ohne Betreff fällt der Titel auf die Planzeile zurück — erfunden wird nichts.
    expect(summarizeChangeApproval(makeJob({ plan: "# Plan ohne Betreff", explanation: {} }))).toMatchObject({
      title: "Plan ohne Betreff",
      planSummary: "Plan ohne Betreff",
      reason: "The plan was stopped for operator approval.",
      findings: [],
      expiresAt: null
    });
    expect(summarizeChangeApproval(makeJob({ explanation: { intent: "   " } })).title).toBe(
      "Hermes change awaiting operator approval"
    );

    // Nur Text zählt als Befund und als Ablaufzeit: Zahlen, leere Zeichenketten
    // und Fremdwerte werden nicht als Zeile ausgegeben.
    expect(
      summarizeChangeApproval(
        makeJob({
          explanation: { intent: "x", evidence: ["echter Befund", 42, "", null, { a: 1 }] },
          envelope: { expiresAt: 17 }
        })
      ).findings
    ).toEqual(["echter Befund"]);
    expect(
      summarizeChangeApproval(makeJob({ plan: "egal", envelope: { expiresAt: 17 } })).expiresAt
    ).toBeNull();
  });
});

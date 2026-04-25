import { describe, expect, it } from "vitest";
import { computeRunbookVersionHash, findRunbook } from "../src/registries.js";
import {
  buildRunbookSafetyPrompt,
  generateRunbookSafetyReview,
  parseRunbookSafetyOutput
} from "../src/safety-review.js";

describe("runbook safety review", () => {
  it("builds a bounded safety review prompt without session transcripts", () => {
    const runbook = findRunbook("disk-health-check");
    expect(runbook).toBeDefined();

    const prompt = buildRunbookSafetyPrompt({
      runbook: runbook!,
      runbookVersionHash: computeRunbookVersionHash(runbook!),
      riskClass: "low",
      sessionId: "session-1",
      trigger: "manual",
      scheduleId: null
    });

    expect(prompt).toContain("Return exactly these seven lines and nothing else");
    expect(prompt).toContain('"runbookId":"disk-health-check"');
    expect(prompt).not.toContain("sessionName");
    expect(prompt).not.toContain('"sessionId":"session-1"');
  });

  it("parses the strict safety review line format", () => {
    const parsed = parseRunbookSafetyOutput([
      "VERDICT: approval_required",
      "SUMMARY: The runbook is allowlisted but should stay behind human approval.",
      "HAZARDS: service interruption | rollback needs validation",
      "BLAST_RADIUS: single host web stack",
      "EXPECTED_IMPACT: bounded restart of approved services",
      "ROLLBACK_HINT: restore the previous service state before retrying",
      "OPERATOR_CHECKS: confirm maintenance window | verify current health checks"
    ].join("\n"));

    expect(parsed).toEqual({
      verdict: "approval_required",
      summary: "The runbook is allowlisted but should stay behind human approval.",
      hazards: ["service interruption", "rollback needs validation"],
      blastRadius: "single host web stack",
      expectedImpact: "bounded restart of approved services",
      rollbackHint: "restore the previous service state before retrying",
      operatorChecks: ["confirm maintenance window", "verify current health checks"]
    });
  });

  it("fails closed for high-risk runbooks when the Copilot runtime is unavailable", async () => {
    const runbook = findRunbook("nextcloud-update-plan");
    expect(runbook).toBeDefined();

    const review = await generateRunbookSafetyReview(
      {
        runbook: runbook!,
        runbookVersionHash: computeRunbookVersionHash(runbook!),
        riskClass: "high",
        sessionId: "session-2",
        trigger: "manual",
        scheduleId: null
      },
      {
        repoRoot: process.cwd(),
        plannerRuntime: "copilot-cli",
        copilotExecutable: "__missing_copilot_binary__",
        copilotModel: null
      }
    );

    expect(review.verdict).toBe("blocked");
    expect(review.summary).toContain("blocked");
    expect(review.details.parseStatus).toBe("error");
    expect(review.details.runbookVersionHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
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

    expect(prompt).toContain("Return EXACTLY these 7 lines");
    expect(prompt).toContain("Script:");
    expect(prompt).toContain("df -h /");
    expect(prompt).not.toContain("(script not available)");
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

  const REPORT = [
    "VERDICT: passed",
    "SUMMARY: Invokes the self-update helper.",
    "HAZARDS: none",
    "BLAST_RADIUS: none",
    "EXPECTED_IMPACT: none",
    "ROLLBACK_HINT: none needed",
    "OPERATOR_CHECKS: none"
  ];

  it("tolerates an additional note line (Lab0 d7031e14: 8 instead of 7 lines)", () => {
    const parsed = parseRunbookSafetyOutput([...REPORT, "Note: the bare-sha form is intentionally refused by the helper."].join("\n"));
    expect(parsed.verdict).toBe("passed");
    expect(parsed.summary).toBe("Invokes the self-update helper.");
    expect(parseRunbookSafetyOutput(["Here is the report:", "", ...REPORT].join("\n")).verdict).toBe("passed");
  });

  it("fails closed on a missing, unclear, duplicate or contradicted verdict", () => {
    const without = REPORT.filter((line) => !line.startsWith("VERDICT"));
    expect(() => parseRunbookSafetyOutput([...without, "Note: looks fine"].join("\n"))).toThrow(/missing/);
    expect(() => parseRunbookSafetyOutput(["VERDICT: passed?", ...REPORT.slice(1)].join("\n"))).toThrow(/invalid verdict/);
    expect(() => parseRunbookSafetyOutput(["VERDICT: passed or blocked", ...REPORT.slice(1)].join("\n"))).toThrow(/invalid verdict/);
    expect(() => parseRunbookSafetyOutput(["VERDICT:", ...REPORT.slice(1)].join("\n"))).toThrow();
    expect(() => parseRunbookSafetyOutput([...REPORT, "VERDICT: blocked"].join("\n"))).toThrow(/duplicate VERDICT/);
    expect(() => parseRunbookSafetyOutput([...REPORT, "**Verdict**: blocked"].join("\n"))).toThrow(/duplicate VERDICT/);
    expect(() => parseRunbookSafetyOutput([...REPORT, "Note: the real verdict would be blocked"].join("\n"))).toThrow(/ambiguous verdict/);
    expect(() => parseRunbookSafetyOutput([...REPORT, "SUMMARY: something else"].join("\n"))).toThrow(/duplicate SUMMARY/);
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
        copilotModel: null,
        opencodeExecutable: "opencode",
        opencodeModel: null
      }
    );

    expect(review.verdict).toBe("blocked");
    expect(review.summary).toContain("blocked");
    expect(review.details.parseStatus).toBe("error");
    expect(review.details.runbookVersionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for high-risk runbooks when the OpenCode runtime is unavailable", async () => {
    const runbook = findRunbook("nextcloud-update-plan");
    expect(runbook).toBeDefined();

    const review = await generateRunbookSafetyReview(
      {
        runbook: runbook!,
        runbookVersionHash: computeRunbookVersionHash(runbook!),
        riskClass: "high",
        sessionId: "session-3",
        trigger: "manual",
        scheduleId: null
      },
      {
        repoRoot: process.cwd(),
        plannerRuntime: "opencode",
        copilotExecutable: "copilot",
        copilotModel: null,
        opencodeExecutable: "__missing_opencode_binary__",
        opencodeModel: null
      }
    );

    expect(review.verdict).toBe("blocked");
    expect(review.summary).toContain("blocked");
    expect(review.details.parseStatus).toBe("error");
    expect(review.details.source).toBe("opencode");
    expect(review.details.runbookVersionHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

import { describe, expect, it } from "vitest";

import { breakerKeyFor, breakerReason, evaluateBreaker, OPERATION_PATTERN } from "../src/circuit-breaker.js";

const now = Date.parse("2026-10-22T06:30:00.000Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const limits = { perOperation: 3, global: 10 };

describe("circuit breaker evaluation", () => {
  it("opens per operation only, names the counting jobs and when it closes", () => {
    const failures = [
      { jobId: "a1", at: at(36), key: "operation:t_f3d18d16" },
      { jobId: "a2", at: at(34), key: "operation:t_f3d18d16" },
      { jobId: "b1", at: at(33), key: "operation:t_b31c5e70" },
      { jobId: "a3", at: at(30), key: "operation:t_f3d18d16" },
    ];
    const state = evaluateBreaker(failures, "operation:t_f3d18d16", limits, now)!;
    expect(state).toMatchObject({ scope: "operation", key: "operation:t_f3d18d16", count: 3, limit: 3, jobIds: ["a1", "a2", "a3"] });
    // With 3 of 3 it closes once the oldest leaves the window.
    expect(state.closesAt).toBe(new Date(Date.parse(at(36)) + 60 * 60_000).toISOString());
    expect(breakerReason(state)).toContain("jobs a1, a2, a3");
    expect(breakerReason(state)).toContain(`It closes at ${state.closesAt}`);
    // An independent operation stays free.
    expect(evaluateBreaker(failures, "operation:t_b31c5e70", limits, now)).toBeNull();
    expect(evaluateBreaker(failures, "operation:t_b90d7c5e", limits, now)).toBeNull();
  });

  it("closes only when enough failures left the window (more failures than the limit)", () => {
    const failures = [50, 40, 30, 20].map((minutes, index) => ({ jobId: `j${index}`, at: at(minutes), key: "operation:x" }));
    const state = evaluateBreaker(failures, "operation:x", limits, now)!;
    expect(state.count).toBe(4);
    // 4 failures at limit 3: only once the two oldest left (the one at 40 min).
    expect(state.closesAt).toBe(new Date(Date.parse(at(40)) + 60 * 60_000).toISOString());
  });

  it("ignores failures older than the window", () => {
    const failures = [61, 62, 10, 5].map((minutes, index) => ({ jobId: `j${index}`, at: at(minutes), key: "operation:x" }));
    expect(evaluateBreaker(failures, "operation:x", limits, now)).toBeNull();
  });

  it("has a higher global cap across operations; failures without a key count only there", () => {
    const failures = Array.from({ length: 10 }, (_, index) => ({ jobId: `g${index}`, at: at(50 - index), key: index < 4 ? null : `operation:o${index}` }));
    const state = evaluateBreaker(failures, "operation:fresh", limits, now)!;
    expect(state).toMatchObject({ scope: "global", key: null, count: 10, limit: 10 });
    expect(breakerReason(state)).toContain("global cap");
    expect(evaluateBreaker(failures.slice(1), "operation:fresh", limits, now)).toBeNull();
    // Keyless (old) entries do not count for an operation.
    const legacy = [1, 2, 3].map((minutes) => ({ jobId: `l${minutes}`, at: at(minutes), key: null }));
    expect(evaluateBreaker(legacy, "operation:fresh", limits, now)).toBeNull();
  });

  it("keys on the operation, else on the intent", () => {
    expect(breakerKeyFor("t_dc5c96c6", "anything")).toBe("operation:t_dc5c96c6");
    expect(breakerKeyFor(null, "Update packages")).toBe(breakerKeyFor(undefined, "  Update packages \n"));
    expect(breakerKeyFor(null, "Update packages")).not.toBe(breakerKeyFor(null, "Update frigate"));
    expect(breakerKeyFor(null, "x")).toMatch(/^intent:[a-f0-9]{16}$/);
    expect(OPERATION_PATTERN.test("t_dc5c96c6")).toBe(true);
    expect(OPERATION_PATTERN.test("karte:t_1.2-3")).toBe(true);
    for (const bad of ["", "-x", "a b", "x".repeat(81), "a/b", "\u00e4"]) expect(OPERATION_PATTERN.test(bad)).toBe(false);
  });
});

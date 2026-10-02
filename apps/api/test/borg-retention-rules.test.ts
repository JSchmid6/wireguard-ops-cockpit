import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION,
  RETENTION_BOUNDS,
  classifyRetention,
  missingArchives,
  parsePrunedArchives,
  parseRetentionArgs,
  unexplainedLoss,
} from "../../../deploy/helpers/cockpit-borg-retention-rules.mjs";

// Die festen Grenzen des Aufräum-Diensts (Jochen, 02.10.2026): mehr behalten
// geht bis zur Obergrenze, weniger als die Untergrenze nur mit Freigabe, nie
// unter den Boden.

const id = (n: number) => n.toString(16).padStart(64, "0");
const archive = (n: number, name = `vmd61162-2026-09-${String(n).padStart(2, "0")}T00:37:11`) => ({ id: id(n), name });

describe("retention bounds", () => {
  it("keeps today's retention as the default and the minimum", () => {
    expect(DEFAULT_RETENTION).toEqual({ keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time: "06:00" });
    expect(RETENTION_BOUNDS.keepDaily.min).toBe(3);
    expect(RETENTION_BOUNDS.keepWeekly.min).toBe(2);
    const verdict = classifyRetention(DEFAULT_RETENTION);
    expect(verdict).toEqual({ ok: true, settings: DEFAULT_RETENTION, belowMinimum: [] });
  });

  it("allows keeping more up to the upper limit without approval", () => {
    const verdict = classifyRetention({ keepDaily: 30, keepWeekly: 12, keepMonthly: 24, time: "22:00" });
    expect(verdict.ok && verdict.belowMinimum).toEqual([]);
  });

  it("refuses values above the upper limit, always", () => {
    for (const input of [
      { keepDaily: 31, keepWeekly: 2, keepMonthly: 0, time: "06:00" },
      { keepDaily: 3, keepWeekly: 13, keepMonthly: 0, time: "06:00" },
      { keepDaily: 3, keepWeekly: 2, keepMonthly: 25, time: "06:00" },
    ]) {
      const verdict = classifyRetention(input);
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.errors.join(" ")).toMatch(/above the upper limit/);
    }
  });

  it("marks values below the minimum as needing approval", () => {
    const verdict = classifyRetention({ keepDaily: 2, keepWeekly: 1, keepMonthly: 0, time: "06:00" });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.belowMinimum).toEqual(["keep_daily 2 is below the minimum 3", "keep_weekly 1 is below the minimum 2"]);
  });

  it("never allows less than one daily archive, not even with approval", () => {
    const verdict = classifyRetention({ keepDaily: 0, keepWeekly: 0, keepMonthly: 0, time: "06:00" });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.errors[0]).toMatch(/below the floor 1, even with approval/);
  });

  it("keeps the run after the nightly backup and in 24 h form", () => {
    for (const time of ["03:59", "22:01", "6:00", "06:0", "24:00", "06:60", "", "06:00:00"]) {
      expect(classifyRetention({ keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time }).ok, time).toBe(false);
    }
    for (const time of ["04:00", "06:00", "22:00"]) {
      expect(classifyRetention({ keepDaily: 3, keepWeekly: 2, keepMonthly: 0, time }).ok, time).toBe(true);
    }
  });

  it("accepts whole numbers only, from JSON or from the command line", () => {
    for (const keepDaily of [3.5, -3, "3x", "", null, "1e1", Number.NaN]) {
      expect(classifyRetention({ keepDaily, keepWeekly: 2, keepMonthly: 0, time: "06:00" }).ok, String(keepDaily)).toBe(false);
    }
    expect(classifyRetention(parseRetentionArgs(["7", "4", "6", "06:30"]))).toEqual({ ok: true, settings: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, time: "06:30" }, belowMinimum: [] });
    expect(parseRetentionArgs(["7", "4", "6"])).toBeNull();
    expect(classifyRetention(null).ok).toBe(false);
  });
});

describe("inventory comparison", () => {
  it("names archives of the last run that are missing now, by id", () => {
    const baseline = [archive(1), archive(2), archive(3)];
    expect(missingArchives(baseline, [archive(1), archive(3), archive(4)])).toEqual([archive(2)]);
    expect(missingArchives(baseline, [...baseline, archive(4)])).toEqual([]);
  });

  it("treats a recreated archive with the same name as missing", () => {
    const recreated = { id: id(99), name: archive(2).name };
    expect(missingArchives([archive(1), archive(2)], [archive(1), recreated])).toEqual([archive(2)]);
  });

  it("reads what prune says it removed, with and without the counter", () => {
    const output = [
      "Keeping archive (rule: daily #1):        vmd61162-2026-10-02T00:37:11     Fri, 2026-10-02 00:37:12 [" + id(5) + "]",
      "Pruning archive (1/2):                   vmd61162-2026-09-27T00:37:11     Sun, 2026-09-27 00:37:12 [" + id(1) + "]",
      "Pruning archive: vmd61162-2026-09-26T00:37:11 Sat, 2026-09-26 00:37:12",
    ].join("\n");
    expect(parsePrunedArchives(output)).toEqual([
      { name: "vmd61162-2026-09-27T00:37:11", id: id(1) },
      { name: "vmd61162-2026-09-26T00:37:11", id: null },
    ]);
  });

  it("finds a loss during prune that prune did not name", () => {
    const before = [archive(1), archive(2), archive(3), archive(4)];
    const after = [archive(3)];
    const pruned = [{ name: archive(1).name, id: id(1) }, { name: archive(2).name, id: null }];
    expect(unexplainedLoss(before, after, pruned)).toEqual([archive(4)]);
    expect(unexplainedLoss(before, [archive(3), archive(4)], pruned)).toEqual([]);
  });
});

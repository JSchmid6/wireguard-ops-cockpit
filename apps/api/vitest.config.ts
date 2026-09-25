import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.js", "test/**/*.d.ts", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      // Vitest 4 reports only files loaded during the test run unless
      // `coverage.include` is set. Pin the scope explicitly to all project
      // sources so a new untested file still shows up in the metric (same
      // scope the Vitest 3 defaults covered).
      include: ["src/**", "runtime/**"],
      // Regression floor, not an aspiration. The previous thresholds
      // (85/70/90/85) were never met on main -- CI was red from the start and
      // therefore flagged nothing. Measured level on main (2026-09-24, pinned
      // Node runtime, Vitest 3): statements/lines 73.94, branches 62.87,
      // functions 80.92. The values below sit ~1pp under that level so lost
      // tests fail the run while refactors can still move the needle; raise
      // them as the real coverage improves.
      //
      // Re-anchored 2026-09-25 with the Vitest 4 bump (task t_ff2b9b78):
      // Vitest 4 remaps V8 coverage with AST accuracy and the old
      // v8-to-istanbul numbers were inflated -- the migration guide expects
      // report changes. Same-commit A/B (main@59dc679): Vitest 3 measured
      // 74.18/65.05/81.31, Vitest 4 measures 60.47-60.89 / 54.36-54.95 /
      // 70.05-70.65 across 4 runs (a spawn-ENOENT close-event race in the
      // safety-review tests toggles ~8 statements between runs). Floors sit
      // >=1pp under the lowest observed value.
      thresholds: {
        statements: 59,
        branches: 53,
        functions: 69,
        lines: 62
      }
    }
  }
});

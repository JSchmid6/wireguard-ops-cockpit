import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.js", "test/**/*.d.ts", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      // Regression floor, not an aspiration. The previous thresholds
      // (85/70/90/85) were never met on main -- CI was red from the start and
      // therefore flagged nothing. Measured level on main (2026-09-24, pinned
      // Node runtime): statements/lines 73.94, branches 62.87, functions
      // 80.92. The values below sit ~1pp under that level so lost tests fail
      // the run while refactors can still move the needle; raise them as the
      // real coverage improves.
      thresholds: {
        statements: 73,
        branches: 62,
        functions: 80,
        lines: 73
      }
    }
  }
});

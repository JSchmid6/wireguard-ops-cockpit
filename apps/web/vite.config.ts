import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // The App integration test drives a full user journey through jsdom and
    // measured 3.2-5.2s on a loaded machine, tripping the 5s default. A 20s
    // bound (4x the measured worst case) keeps runs reliable on slower CI
    // runners without masking real hangs.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      // Vitest 4 reports only files loaded during the test run unless
      // `coverage.include` is set; pin the scope explicitly to all sources
      // (untested files stay visible in the metric).
      include: ["src/**"],
      // Thresholds re-anchored 2026-09-25 with the Vitest 4 bump (task
      // t_ff2b9b78). Vitest 4 remaps V8 coverage with AST accuracy; the old
      // numbers were inflated by v8-to-istanbul. Same-commit A/B
      // (main@59dc679): Vitest 3 measured 94.48/75.47/77.77, Vitest 4
      // measures 85.20/72.05/84.33 (stable across runs). Floors sit >=1pp
      // under the measured level.
      thresholds: {
        statements: 84,
        branches: 71,
        functions: 83,
        lines: 85
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3001"
    }
  }
});


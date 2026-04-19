import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.js", "test/**/*.d.ts", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 90,
        lines: 85
      }
    }
  }
});
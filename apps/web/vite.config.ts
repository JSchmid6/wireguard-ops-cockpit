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
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 75,
        lines: 90
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


import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "server/__tests__/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    // Integration tests (Testcontainers-backed, real Postgres) live in their
    // own config — vitest.integration.config.ts — and MUST NOT run in the
    // default unit-test suite (they need Docker; default suite must stay fast).
    exclude: [
      "**/node_modules/**",
      "**/*.integration.test.ts",
    ],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client/src"),
    },
  },
});

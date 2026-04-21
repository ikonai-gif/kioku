import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest config for integration tests (Testcontainers-backed, real Postgres).
 *
 * Run with: `npm run test:integration`
 *
 * Requires Docker on the host. Default `npm test` does NOT pick these up — the
 * default config excludes `*.integration.test.ts` from its include glob.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    // Testcontainers needs ~30s to pull + boot postgres:16-alpine on a cold
    // runner; per-test budget is generous because we do up to 50 concurrent
    // HTTP round-trips against a real pool.
    testTimeout: 90_000,
    hookTimeout: 120_000,
    retry: 1,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
});

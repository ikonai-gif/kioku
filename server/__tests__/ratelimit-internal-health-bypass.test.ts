/**
 * R347 — internal-health bypass for cron probes
 *
 * Covers:
 *  1. Valid X-Internal-Health header → bypass (next() called, no rate-limit hit)
 *  2. Invalid header value → normal middleware flow (rate-limit applies)
 *  3. INTERNAL_HEALTH_SECRET unset → header value ignored (fail-safe; rate-limit applies)
 *
 * Mount a minimal Express app that uses rateLimitMiddleware directly,
 * mirroring the rate-limit-beta.test.ts pattern.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Force in-memory path — no REDIS_URL set in test env.
vi.unstubAllEnvs?.();
delete process.env.REDIS_URL;

import { rateLimitMiddleware } from "../ratelimit";

function buildApp() {
  const app = express();
  app.use(rateLimitMiddleware);
  app.get("/api/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("R347 — X-Internal-Health bypass", () => {
  beforeEach(() => {
    delete process.env.INTERNAL_HEALTH_SECRET;
  });

  it("valid X-Internal-Health header bypasses rate limit", async () => {
    process.env.INTERNAL_HEALTH_SECRET = "test-secret-abc";
    const app = buildApp();

    const res = await request(app)
      .get("/api/test")
      .set("X-Internal-Health", "test-secret-abc");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Rate-limit headers should NOT be set when middleware is bypassed.
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["x-ratelimit-plan"]).toBeUndefined();
  });

  it("invalid X-Internal-Health header value falls through to normal flow", async () => {
    process.env.INTERNAL_HEALTH_SECRET = "real-secret";
    const app = buildApp();

    const res = await request(app)
      .get("/api/test")
      .set("X-Internal-Health", "wrong-secret");

    expect(res.status).toBe(200);
    // Normal flow applies — rate-limit headers must be present.
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-plan"]).toBeDefined();
  });

  it("missing INTERNAL_HEALTH_SECRET env var ignores header (fail-safe)", async () => {
    // INTERNAL_HEALTH_SECRET intentionally NOT set in beforeEach above.
    const app = buildApp();

    // Even an empty-string header must NOT bypass when env is unset.
    const res = await request(app)
      .get("/api/test")
      .set("X-Internal-Health", "");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-plan"]).toBeDefined();
  });

  it("missing env + matching empty string still does not bypass", async () => {
    // Defence-in-depth: if both env and header were '' the strict-equal would
    // be true. The `internalSecret &&` guard ensures we never accept that.
    delete process.env.INTERNAL_HEALTH_SECRET;
    const app = buildApp();

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
  });
});

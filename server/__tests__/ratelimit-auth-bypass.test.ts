/**
 * R410 — auth-endpoint bypass for global IP rate limit
 *
 * BLOCKER: Owners on shared NAT/proxy/VPN IPs were getting 429 from the global
 * unauthenticated IP limit (100/min) when other unauthenticated traffic from
 * the same IP exhausted the bucket. /api/auth/* has its own purpose-built
 * rate limits inside the route handlers (5/min IP for demo, 15/hour email
 * for magic-link), so the global layer is redundant on auth and harmful on
 * shared-IP environments.
 *
 * Covers:
 *  1. /api/auth/* paths bypass the global IP limit even after 100+ requests.
 *  2. Non-auth endpoints (/api/anything-else) STILL enforce the global limit
 *     (regression guard — bypass must be scoped, not blanket).
 *  3. /api/agent-auth/* (different threat model) is NOT affected.
 *  4. /api/authentication (no trailing slash, hypothetical) is NOT affected.
 *  5. Bypass works for typical magic-link routes (request, verify, me, logout).
 *
 * Mounts a minimal Express app and uses rateLimitMiddleware directly,
 * mirroring the rate-limit-internal-health-bypass.test.ts pattern.
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
  // A catch-all GET so any path returns 200 unless rate-limited to 429.
  app.get(/.*/, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("R410 — /api/auth/* bypasses global IP rate limit", () => {
  beforeEach(() => {
    delete process.env.INTERNAL_HEALTH_SECRET;
  });

  it("magic-link from a single IP can exceed the 100/min global limit", async () => {
    const app = buildApp();
    let last429 = 0;
    let last200 = 0;

    // Send 110 requests from the same IP (simulating shared-IP NAT/proxy
    // exhaustion). Without the bypass, request #101 would 429.
    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .get("/api/auth/request-magic-link")
        .set("X-Forwarded-For", "203.0.113.42");
      if (res.status === 429) last429 = i + 1;
      if (res.status === 200) last200 = i + 1;
    }

    expect(last429).toBe(0); // never rate-limited
    expect(last200).toBe(110); // last request was a 200
  });

  it.each([
    "/api/auth/request-magic-link",
    "/api/auth/verify-magic-link",
    "/api/auth/verify",
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/demo",
    "/api/auth/rotate-key",
  ])("typical auth route %s does not set rate-limit headers", async (path) => {
    const app = buildApp();
    const res = await request(app)
      .get(path)
      .set("X-Forwarded-For", "198.51.100.1");
    expect(res.status).toBe(200);
    // Bypassed requests must NOT carry the rate-limit response headers.
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["x-ratelimit-plan"]).toBeUndefined();
  });

  it("non-auth API path STILL enforces global IP limit (regression guard)", async () => {
    const app = buildApp();
    let firstFailure = 0;

    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .get("/api/some-other-endpoint")
        .set("X-Forwarded-For", "203.0.113.99");
      if (res.status === 429 && firstFailure === 0) firstFailure = i + 1;
    }

    // The 101st request from a single IP should be rate-limited.
    expect(firstFailure).toBeGreaterThan(0);
    expect(firstFailure).toBeLessThanOrEqual(101);
  });

  it("/api/agent-auth/* is NOT covered by the bypass (different threat model)", async () => {
    const app = buildApp();
    let firstFailure = 0;

    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .get("/api/agent-auth/verify")
        .set("X-Forwarded-For", "203.0.113.7");
      if (res.status === 429 && firstFailure === 0) firstFailure = i + 1;
    }

    expect(firstFailure).toBeGreaterThan(0);
    expect(firstFailure).toBeLessThanOrEqual(101);
  });

  it("/api/authentication/* (no trailing slash on /api/auth/) is NOT covered", async () => {
    const app = buildApp();
    let firstFailure = 0;

    // Hypothetical path that would match a startsWith('/api/auth') without
    // the trailing slash. Confirms that our '/api/auth/' prefix is exact.
    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .get("/api/authentication/foo")
        .set("X-Forwarded-For", "203.0.113.8");
      if (res.status === 429 && firstFailure === 0) firstFailure = i + 1;
    }

    expect(firstFailure).toBeGreaterThan(0);
    expect(firstFailure).toBeLessThanOrEqual(101);
  });

  it("bypass returns ok:true and does not set Retry-After", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/auth/me")
      .set("X-Forwarded-For", "192.0.2.5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});

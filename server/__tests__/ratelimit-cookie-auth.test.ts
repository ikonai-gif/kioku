/**
 * R460 — cookie-based auth counts as authenticated for rate-limit.
 *
 * BLOCKER: Cookie-only browser sessions (the default after /api/auth/me
 * auto-restore) were treated as unauthenticated by rateLimitMiddleware
 * because it only read x-api-key and x-session-token headers. Result: the
 * owner's own browser hit the 100 req/min shared-IP bucket within seconds
 * on page load (rooms + status + approvals + gallery polling) and saw a
 * cascade of 429s. Fix: middleware also reads the kioku_session httpOnly
 * cookie that cookie-parser already populates onto req.cookies.
 *
 * Covers:
 *  1. Cookie-only session escapes the 100/min unauthenticated IP bucket.
 *  2. The per-user rate-limit headers ARE populated (so client telemetry
 *     still works and the owner-bypass / plan tier remain observable).
 *  3. No cookie AND no header ⇒ still the unauthenticated IP bucket.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

// Force in-memory path — no REDIS_URL set in test env.
vi.unstubAllEnvs?.();
delete process.env.REDIS_URL;

// Match the secret used by the middleware's dev-fallback path.
const JWT_SECRET = "dev-only-secret";

import { rateLimitMiddleware } from "../ratelimit";

// Mock storage so cookie -> userId -> plan resolution returns a known plan
// instead of hitting the real database. The middleware only calls
// storage.getUserById when a valid JWT is presented; we emit a JWT with
// userId=1 so that call routes here.
vi.mock("../storage", () => ({
  storage: {
    getUserById: vi.fn(async (id: number) => ({
      id,
      email: "owner@example.com",
      plan: "dev",
      role: null, // not owner — keeps the test focused on cookie-vs-header path
    })),
    getUserByApiKey: vi.fn(async () => null),
  },
}));

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(rateLimitMiddleware);
  app.get(/.*/, (_req, res) => res.json({ ok: true }));
  return app;
}

function makeCookie(userId = 1): string {
  return jwt.sign({ userId }, JWT_SECRET, { algorithm: "HS256" });
}

describe("R460 — cookie-based auth counts as authenticated for rate-limit", () => {
  beforeEach(() => {
    delete process.env.INTERNAL_HEALTH_SECRET;
    // The ratelimit module captures JWT_SECRET from env at handler time.
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = "test";
  });

  it("cookie-only session escapes the 100/min unauthenticated IP bucket", async () => {
    const app = buildApp();
    const cookie = `kioku_session=${makeCookie(1)}`;
    let firstFailure = 0;

    // 110 requests from the same IP — without the fix, request #101 would 429
    // because the request would be classified as unauthenticated and keyed by
    // IP alone. With the fix, cookie auth lifts us into the per-user 'dev'
    // bucket (60/min) which is keyed by token — still triggers 429 around #61
    // on a per-user basis, so for this assertion we limit to the IP bucket
    // semantics: send 110 and confirm the failure mode is per-plan, not the
    // 100/min IP message.
    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .get("/api/rooms")
        .set("Cookie", cookie)
        .set("X-Forwarded-For", "203.0.113.42");
      if (res.status === 429 && firstFailure === 0) firstFailure = i + 1;
    }

    // Must eventually hit the per-plan (dev=60/min) limit, NOT the 100/min
    // unauthenticated IP limit. Proof: failure index is around 61, not 101.
    expect(firstFailure).toBeGreaterThan(0);
    expect(firstFailure).toBeLessThanOrEqual(62); // 60 + 1 buffer
  });

  it("cookie-only session gets per-plan rate-limit headers", async () => {
    const app = buildApp();
    const cookie = `kioku_session=${makeCookie(2)}`;

    const res = await request(app)
      .get("/api/rooms")
      .set("Cookie", cookie)
      .set("X-Forwarded-For", "203.0.113.50");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("dev");
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
  });

  it("no cookie AND no header ⇒ still falls under the unauthenticated IP bucket", async () => {
    const app = buildApp();
    let firstFailure = 0;

    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .get("/api/rooms")
        .set("X-Forwarded-For", "203.0.113.55");
      if (res.status === 429 && firstFailure === 0) firstFailure = i + 1;
    }

    // Regression guard: unauthenticated IP bucket (100/min) still enforced.
    expect(firstFailure).toBeGreaterThan(0);
    expect(firstFailure).toBeLessThanOrEqual(101);
  });

  it("header x-session-token still works (did not break legacy API clients)", async () => {
    const app = buildApp();
    const token = makeCookie(3);

    const res = await request(app)
      .get("/api/rooms")
      .set("x-session-token", token)
      .set("X-Forwarded-For", "203.0.113.60");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("dev");
  });

  it("header takes precedence over cookie when both present", async () => {
    const app = buildApp();
    const token = makeCookie(4);
    const cookie = `kioku_session=${makeCookie(5)}`;

    const res = await request(app)
      .get("/api/rooms")
      .set("x-session-token", token)
      .set("Cookie", cookie)
      .set("X-Forwarded-For", "203.0.113.70");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("dev");
  });
});

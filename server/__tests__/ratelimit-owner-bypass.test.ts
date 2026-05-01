/**
 * R415 — owner-role bypass for global rate limit
 *
 * BLOCKER: BOSS (role='owner') was on plan='dev' (60 req/min), and the
 * platform UI polls many endpoints in parallel (rooms, partner status,
 * gallery, luca approvals) plus WS reconnect storms. The 60/min ceiling
 * was hit instantly and the entire UI rendered with `data: undefined`.
 *
 * Fix: resolveUserPlan() returns 'owner' (effectively unlimited) when
 * the user's role is 'owner', regardless of their plan tier.
 *
 * Covers:
 *  1. Owner via session token → plan='owner', perMin=9999, never 429.
 *  2. Owner via API key → plan='owner'.
 *  3. Non-owner with plan='dev' → still rate-limited at 60/min.
 *  4. Non-owner with plan='enterprise' → still 'enterprise', not bumped.
 *  5. Owner on plan='dev' (the BOSS scenario) → 'owner', not 'dev'.
 *
 * Mounts a minimal Express app with rateLimitMiddleware directly,
 * mirroring rate-limit-beta.test.ts and ratelimit-auth-bypass.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Force in-memory path — no REDIS_URL set in test env.
vi.unstubAllEnvs?.();
delete process.env.REDIS_URL;

// Mock storage so we can plant arbitrary users. vi.mock factories are
// hoisted, so we must keep the factory self-contained and grab the mock
// after import.
vi.mock("../storage", () => ({
  storage: {
    getUserByApiKey: vi.fn(),
    getUserById: vi.fn(),
  },
}));

import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-jwt-secret-r415";
process.env.JWT_SECRET = TEST_JWT_SECRET;

import { rateLimitMiddleware } from "../ratelimit";
import { storage as mockStorage } from "../storage";

function buildApp() {
  const app = express();
  app.use(rateLimitMiddleware);
  app.get("/api/protected", (_req, res) => res.json({ ok: true }));
  return app;
}

function ownerSessionToken(userId: number): string {
  return jwt.sign({ userId }, TEST_JWT_SECRET, { algorithm: "HS256" });
}

// Cast helpers — we know these are vi.fn() mocks via vi.mock above.
const getUserByApiKeyMock = mockStorage.getUserByApiKey as unknown as ReturnType<typeof vi.fn>;
const getUserByIdMock = mockStorage.getUserById as unknown as ReturnType<typeof vi.fn>;

describe("R415 — owner-role bypass for plan rate limits", () => {
  beforeEach(() => {
    getUserByApiKeyMock.mockReset();
    getUserByIdMock.mockReset();
  });

  it("owner with session token gets 'owner' plan — never 429 on a typical UI burst", async () => {
    getUserByIdMock.mockResolvedValue({
      id: 10,
      plan: "dev", // BOSS scenario — dev plan but owner role
      role: "owner",
    });

    const token = ownerSessionToken(10);
    const app = buildApp();
    let last429 = 0;

    // Burst 200 requests — well above dev (60) and even above starter (300).
    // 'owner' tier perMin = 9999 → never trips.
    for (let i = 0; i < 200; i++) {
      const res = await request(app)
        .get("/api/protected")
        .set("X-Session-Token", token);
      if (res.status === 429) {
        last429 = i + 1;
        break;
      }
    }

    expect(last429).toBe(0);
  });

  it("owner via session token receives X-RateLimit-Plan: owner header", async () => {
    getUserByIdMock.mockResolvedValue({
      id: 10,
      plan: "dev",
      role: "owner",
    });

    const token = ownerSessionToken(10);
    const app = buildApp();
    const res = await request(app)
      .get("/api/protected")
      .set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("owner");
  });

  it("owner via API key gets 'owner' plan", async () => {
    getUserByApiKeyMock.mockResolvedValue({
      id: 10,
      apiKey: "kk_owner_test",
      plan: "free",
      role: "owner",
    });

    const app = buildApp();
    const res = await request(app)
      .get("/api/protected")
      .set("X-API-Key", "kk_owner_test");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("owner");
  });

  it("non-owner with plan='dev' is STILL rate-limited at 60/min (regression guard)", async () => {
    getUserByIdMock.mockResolvedValue({
      id: 42,
      plan: "dev",
      role: "user",
    });

    const token = ownerSessionToken(42); // technically just a session token; userId 42
    const app = buildApp();
    let firstFailure = 0;

    for (let i = 0; i < 80; i++) {
      const res = await request(app)
        .get("/api/protected")
        .set("X-Session-Token", token);
      if (res.status === 429 && firstFailure === 0) firstFailure = i + 1;
    }

    expect(firstFailure).toBeGreaterThan(0);
    expect(firstFailure).toBeLessThanOrEqual(61);
  });

  it("non-owner with plan='enterprise' stays on 'enterprise' (not bumped to 'owner')", async () => {
    getUserByIdMock.mockResolvedValue({
      id: 7,
      plan: "enterprise",
      role: "user",
    });

    const token = ownerSessionToken(7);
    const app = buildApp();
    const res = await request(app)
      .get("/api/protected")
      .set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("enterprise");
  });

  it("user with role='blocked' or other non-owner role does NOT get the bypass", async () => {
    getUserByIdMock.mockResolvedValue({
      id: 99,
      plan: "free",
      role: "admin", // hypothetical role; not 'owner'
    });

    const token = ownerSessionToken(99);
    const app = buildApp();
    const res = await request(app)
      .get("/api/protected")
      .set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("free");
  });

  it("missing user (storage returns null) defaults to 'dev'", async () => {
    getUserByIdMock.mockResolvedValue(null);

    const token = ownerSessionToken(1234);
    const app = buildApp();
    const res = await request(app)
      .get("/api/protected")
      .set("X-Session-Token", token);

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-plan"]).toBe("dev");
  });
});

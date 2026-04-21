/**
 * Tests for initDb startup guard + sync health registration (Item 3, R2).
 *
 * Tests the readiness gate middleware and __setDbReadyForTest helper.
 * Creates a minimal Express app that replicates the middleware logic from
 * server/index.ts without starting the full server.
 *
 * Covers 8 cases per plan:
 * 1. _dbReady=false → GET /api/agents → 503 + Retry-After: 2
 * 2. _dbReady=false → GET /health → 200 (whitelisted)
 * 3. _dbReady=false → GET /health/detailed → 200 (whitelisted)
 * 4. _dbReady=false → GET /ready → not 503-initializing (whitelisted)
 * 5. _dbReady=false → GET /mcp/something → 503 (gated, Q2)
 * 6. _dbReady=false → GET /v1/something → 503 (gated, Q2)
 * 7. _dbReady=true  → GET /api/agents → passes through (not 503-initializing)
 * 8. __setDbReadyForTest throws if NODE_ENV !== "test"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoist shared mock state ────────────────────────────────────────────────────
const { poolMock } = vi.hoisted(() => {
  const poolMock = {
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
  };
  return { poolMock };
});

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = (...args: any[]) => poolMock.query(...args);
    this.on = (...args: any[]) => poolMock.on(...args);
    this.end = (...args: any[]) => poolMock.end(...args);
    this.connect = (...args: any[]) => poolMock.connect(...args);
  }
  return { Pool: MockPool };
});

vi.mock("../embeddings", () => ({ embedText: vi.fn() }));
vi.mock("../memory-decay", () => ({
  computeDecayedStrength: vi.fn(),
  computeDecayedConfidence: vi.fn(),
}));
vi.mock("../emotion-scorer", () => ({ scoreEmotion: vi.fn() }));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({})),
}));
vi.mock("../lib/redis", () => ({
  getRedisClient: vi.fn(() => null),
  closeRedisClient: vi.fn(),
}));
vi.mock("../index", () => ({
  safeCompare: (a: string, b: string) => a === b,
}));

import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { registerHealthRoutes } from "../health";
import { isDbReady, __setDbReadyForTest } from "../storage";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal app that replicates the relevant section of index.ts:
 * 1. Register health routes synchronously
 * 2. Add readiness gate middleware
 * 3. Add a dummy /api/agents endpoint that returns 200 when it passes through
 * 4. Add a dummy /mcp/something and /v1/something endpoint
 */
function makeApp() {
  const app = express();
  app.use(express.json());

  // Sync health routes (R2)
  registerHealthRoutes(app);
  app.get("/api/health", (_req, res) => res.redirect(307, "/health"));

  // Readiness gate (Item 3)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (/^\/(health|ready|metrics)/.test(req.path)) return next();
    if (!/^\/(api|mcp|v1)/.test(req.path)) return next();
    if (isDbReady()) return next();
    res.setHeader("Retry-After", "2");
    return res.status(503).json({ error: "server initializing", retry_after_s: 2 });
  });

  // Dummy route that succeeds if it gets through the gate
  app.get("/api/agents", (_req, res) => res.json({ agents: [] }));
  app.get("/mcp/something", (_req, res) => res.json({ ok: true }));
  app.get("/v1/something", (_req, res) => res.json({ ok: true }));

  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Start each test with DB not ready
  process.env.NODE_ENV = "test";
  __setDbReadyForTest(false);
  // DB connect: default success for /health routes
  poolMock.connect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  });
  poolMock.query.mockResolvedValue({ rows: [{ stale: "0", latest_applied_at: null }] });
  delete process.env.REDIS_URL;
});

afterEach(() => {
  __setDbReadyForTest(false);
});

describe("readiness gate middleware", () => {
  it("case 1: _dbReady=false → GET /api/agents → 503 with Retry-After: 2", async () => {
    __setDbReadyForTest(false);
    const app = makeApp();

    const res = await request(app).get("/api/agents");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.body.error).toBe("server initializing");
    expect(res.body.retry_after_s).toBe(2);
  });

  it("case 2: _dbReady=false → GET /health → 200 (whitelisted)", async () => {
    __setDbReadyForTest(false);
    const app = makeApp();

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
  });

  it("case 3: _dbReady=false → GET /health/detailed → 200 (whitelisted)", async () => {
    __setDbReadyForTest(false);
    const app = makeApp();

    const res = await request(app).get("/health/detailed");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("checks");
  });

  it("case 4: _dbReady=false → GET /ready → not 503-initializing (whitelisted)", async () => {
    __setDbReadyForTest(false);
    const app = makeApp();

    const res = await request(app).get("/ready");

    // Should NOT be our 503 "server initializing" response
    // (may be 200 or 503 from DB check itself, but NOT our gate)
    expect(res.body.error).not.toBe("server initializing");
    // The /ready route is served by registerHealthRoutes which returns ready status
    // The gate should not block it
  });

  it("case 5: _dbReady=false → GET /mcp/something → 503 (gated, Q2)", async () => {
    __setDbReadyForTest(false);
    const app = makeApp();

    const res = await request(app).get("/mcp/something");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("server initializing");
  });

  it("case 6: _dbReady=false → GET /v1/something → 503 (gated, Q2)", async () => {
    __setDbReadyForTest(false);
    const app = makeApp();

    const res = await request(app).get("/v1/something");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("server initializing");
  });

  it("case 7: _dbReady=true → GET /api/agents → passes through (not 503)", async () => {
    __setDbReadyForTest(true);
    const app = makeApp();

    const res = await request(app).get("/api/agents");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("agents");
  });
});

describe("__setDbReadyForTest guard", () => {
  it("case 8: throws if NODE_ENV !== 'test'", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => __setDbReadyForTest(true)).toThrow("__setDbReadyForTest is test-only");
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("does not throw in test environment", () => {
    process.env.NODE_ENV = "test";
    expect(() => __setDbReadyForTest(true)).not.toThrow();
    expect(() => __setDbReadyForTest(false)).not.toThrow();
  });
});

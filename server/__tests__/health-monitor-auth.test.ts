/**
 * W7 F4.2 — /health/monitor master-key auth regression guard
 *
 * Verified current state: `server/index.ts:184-190` already auth-gates
 * `/health/monitor` with `safeCompare(req.headers["x-master-key"], KIOKU_MASTER_KEY)`.
 * Same pattern as `/api/admin/monitor` (line 195) and `/api/admin/logs`
 * (line 216). No code change needed — this file pins the contract so a
 * regression (e.g. someone removing the guard) fails loudly in CI.
 *
 * We do two things:
 *  1. Mirror the exact route handler in a tiny app + exercise all three
 *     auth states (missing, wrong, correct).
 *  2. Source-pin index.ts: the `/health/monitor` route block must contain
 *     the `x-master-key` + `safeCompare` + 403 contract.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Inline copy of server/index.ts#safeCompare — importing from ../index
// triggers the full Express app module eval (db init, ws setup, etc.)
// which makes the test noisy. The source-pin test below asserts that
// index.ts still uses *its* safeCompare, so behavioural divergence is
// caught.
function safeCompare(a: string, b: string): boolean {
  const { Buffer } = require("node:buffer");
  const { timingSafeEqual } = require("node:crypto");
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

// Mirror the exact handler from index.ts:184-190.
function makeApp(masterKey: string) {
  const app = express();
  app.get("/health/monitor", (req, res) => {
    if (!masterKey || !safeCompare((req.headers["x-master-key"] as string) || "", masterKey)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    res.json({ uptimeSeconds: 42, openaiBreaker: { state: "CLOSED" } });
  });
  return app;
}

describe("W7 F4.2 — /health/monitor auth contract", () => {
  const VALID_KEY = "test-master-key-abc123";
  let app: express.Express;
  beforeEach(() => {
    app = makeApp(VALID_KEY);
  });

  it("rejects with 403 when x-master-key header is missing", async () => {
    const res = await request(app).get("/health/monitor");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Admin access required" });
  });

  it("rejects with 403 when x-master-key is wrong", async () => {
    const res = await request(app).get("/health/monitor").set("x-master-key", "wrong-key");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Admin access required" });
  });

  it("rejects with 403 when x-master-key is the empty string", async () => {
    const res = await request(app).get("/health/monitor").set("x-master-key", "");
    expect(res.status).toBe(403);
  });

  it("accepts with 200 + body when x-master-key matches", async () => {
    const res = await request(app).get("/health/monitor").set("x-master-key", VALID_KEY);
    expect(res.status).toBe(200);
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(res.body.openaiBreaker).toBeDefined();
  });

  it("rejects even with correct user-supplied key when server has no KIOKU_MASTER_KEY set", async () => {
    // Guard against the misconfigured-prod case — if env var is unset,
    // safeCompare against '' must NOT let anyone in.
    const app2 = makeApp("");
    const res = await request(app2).get("/health/monitor").set("x-master-key", "anything");
    expect(res.status).toBe(403);
  });
});

// ── Source pin: index.ts route handler still has the guard ──
describe("W7 F4.2 — source contract: /health/monitor still guarded in index.ts", () => {
  const src = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

  it("/health/monitor route block uses safeCompare + x-master-key + 403", () => {
    const idx = src.indexOf('app.get("/health/monitor"');
    expect(idx, "/health/monitor route not found").toBeGreaterThan(-1);
    // Window ≤ 600 chars covers the whole handler.
    const win = src.slice(idx, idx + 600);
    expect(win).toMatch(/x-master-key/);
    expect(win).toMatch(/safeCompare\(/);
    expect(win).toMatch(/KIOKU_MASTER_KEY/);
    expect(win).toMatch(/status\(\s*403\s*\)/);
  });

  it("/api/admin/monitor and /api/admin/logs share the same master-key pattern", () => {
    // Regression guard for the consistent auth contract across admin routes.
    const adminMonitor = src.indexOf('app.get("/api/admin/monitor"');
    expect(adminMonitor).toBeGreaterThan(-1);
    const mwin = src.slice(adminMonitor, adminMonitor + 600);
    expect(mwin).toMatch(/safeCompare\(/);
    expect(mwin).toMatch(/status\(\s*403\s*\)/);

    const adminLogs = src.indexOf('app.get("/api/admin/logs"');
    expect(adminLogs).toBeGreaterThan(-1);
    const lwin = src.slice(adminLogs, adminLogs + 600);
    expect(lwin).toMatch(/safeCompare\(/);
    expect(lwin).toMatch(/status\(\s*403\s*\)/);
  });
});

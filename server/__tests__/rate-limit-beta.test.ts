/**
 * W7 F4.1 — beta-open layered rate limits
 *
 * Covers:
 *  1. `checkDemoRateLimit` unit — allowed/denied transition and Retry-After.
 *  2. `/api/demo/chat` 11th request in the 60s window → 429 + Retry-After.
 *  3. `/api/auth/magic-link` 6th request in 60s from same IP → 429 while
 *     email bucket still has room (validates layering).
 *
 * Mount a minimal Express app that mirrors just the rate-limit blocks
 * from routes.ts. Avoids pulling the full registerRoutes() graph.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Force in-memory path — no REDIS_URL set in test env by default.
vi.unstubAllEnvs?.();
delete process.env.REDIS_URL;

import { checkDemoRateLimit, checkAuthRateLimit } from "../ratelimit";

describe("W7 F4.1 — checkDemoRateLimit unit", () => {
  let counter = 0;
  // Unique prefix each suite run so we don't share state across describes.
  const uniq = () => `test-${Date.now()}-${counter++}`;

  it("allows up to `limit` calls then denies the next one, with Retry-After ≤ window seconds", async () => {
    const ip = uniq();
    const limit = 3;
    const windowMs = 60_000;

    for (let i = 0; i < limit; i++) {
      const r = await checkDemoRateLimit(ip, limit, windowMs, "unit");
      expect(r.allowed).toBe(true);
      expect(r.retryAfterSec).toBe(0);
    }
    const denied = await checkDemoRateLimit(ip, limit, windowMs, "unit");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("different IPs don't share counters", async () => {
    const ip1 = uniq();
    const ip2 = uniq();
    for (let i = 0; i < 3; i++) {
      await checkDemoRateLimit(ip1, 3, 60_000, "unit2");
    }
    const denied = await checkDemoRateLimit(ip1, 3, 60_000, "unit2");
    expect(denied.allowed).toBe(false);
    // ip2 still at count=0 → allowed
    const ok = await checkDemoRateLimit(ip2, 3, 60_000, "unit2");
    expect(ok.allowed).toBe(true);
  });

  it("different prefixes don't share counters (isolates min vs hour buckets)", async () => {
    const ip = uniq();
    for (let i = 0; i < 3; i++) {
      await checkDemoRateLimit(ip, 3, 60_000, "pA");
    }
    const deniedA = await checkDemoRateLimit(ip, 3, 60_000, "pA");
    expect(deniedA.allowed).toBe(false);
    // Same IP, different prefix → independent window
    const okB = await checkDemoRateLimit(ip, 3, 60_000, "pB");
    expect(okB.allowed).toBe(true);
  });
});

// ── Contract app mirroring the demo-chat rate-limit block ──
function makeDemoApp() {
  const app = express();
  app.use(express.json());
  app.post("/demo", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] as string) || "test-ip";
    const minLimit = await checkDemoRateLimit(ip, 10, 60_000, "demo:min:contract");
    if (!minLimit.allowed) {
      res.setHeader("Retry-After", String(minLimit.retryAfterSec));
      return res.status(429).json({ error: "rate_limited", retry_after_s: minLimit.retryAfterSec });
    }
    const hourLimit = await checkDemoRateLimit(ip, 50, 3_600_000, "demo:hour:contract");
    if (!hourLimit.allowed) {
      res.setHeader("Retry-After", String(hourLimit.retryAfterSec));
      return res.status(429).json({ error: "rate_limited", retry_after_s: hourLimit.retryAfterSec });
    }
    res.json({ ok: true });
  });
  return app;
}

describe("W7 F4.1 — /api/demo/chat contract: 11th request in 60s → 429", () => {
  let app: express.Express;
  let ip: string;
  beforeEach(() => {
    app = makeDemoApp();
    ip = `demo-test-${Date.now()}-${Math.random()}`;
  });

  it("first 10 requests succeed, 11th returns 429 + Retry-After + {error, retry_after_s}", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/demo").set("x-forwarded-for", ip).send({});
      expect(r.status, `req ${i + 1}`).toBe(200);
    }
    const r11 = await request(app).post("/demo").set("x-forwarded-for", ip).send({});
    expect(r11.status).toBe(429);
    expect(r11.headers["retry-after"]).toBeDefined();
    expect(parseInt(r11.headers["retry-after"])).toBeGreaterThan(0);
    expect(r11.body.error).toBe("rate_limited");
    expect(typeof r11.body.retry_after_s).toBe("number");
    expect(r11.body.retry_after_s).toBeGreaterThan(0);
  });
});

// ── Contract app mirroring the magic-link IP+email layering ──
function makeMagicApp() {
  const app = express();
  app.use(express.json());
  app.post("/magic", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] as string) || "test-ip";
    const email = (req.body?.email as string) || "test@example.com";
    // Layer 1 — IP (5/min)
    const ipLimit = await checkDemoRateLimit(ip, 5, 60_000, "magic:ip:contract");
    if (!ipLimit.allowed) {
      res.setHeader("Retry-After", String(ipLimit.retryAfterSec));
      return res.status(429).json({ error: "rate_limited", retry_after_s: ipLimit.retryAfterSec });
    }
    // Layer 2 — email (15/hour)
    if (!checkAuthRateLimit(`magic:${email}:contract`, 15, 3_600_000)) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    res.json({ ok: true });
  });
  return app;
}

describe("W7 F4.1 — magic-link IP layer fires BEFORE email exhaustion", () => {
  it("6th request in 60s from same IP → 429, even with fresh emails (email bucket still has room)", async () => {
    const app = makeMagicApp();
    const ip = `magic-test-${Date.now()}-${Math.random()}`;
    // Each request uses a NEW email, so the email bucket is always at count=1.
    // If IP layer were missing, every request would succeed.
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/magic")
        .set("x-forwarded-for", ip)
        .send({ email: `user${i}-${Date.now()}@ex.com` });
      expect(r.status, `magic req ${i + 1}`).toBe(200);
    }
    const r6 = await request(app)
      .post("/magic")
      .set("x-forwarded-for", ip)
      .send({ email: `sixth-${Date.now()}@ex.com` });
    expect(r6.status).toBe(429);
    expect(r6.body.error).toBe("rate_limited");
    expect(r6.body.retry_after_s).toBeGreaterThan(0);
  });
});

// ── Source pin: routes.ts actually uses checkDemoRateLimit at both sites ──
describe("W7 F4.1 — source contract: routes.ts imports + uses checkDemoRateLimit", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const src = readFileSync(join(__dirname, "..", "routes.ts"), "utf8");

  it("imports checkDemoRateLimit from ./ratelimit", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bcheckDemoRateLimit\b[^}]*\}\s*from\s*["']\.\/ratelimit["']/,
    );
  });

  it("demo-chat endpoint uses checkDemoRateLimit at both min and hour windows", () => {
    const idx = src.indexOf('"/api/demo/chat"');
    expect(idx).toBeGreaterThan(-1);
    const nextPost = src.indexOf("app.post(", idx + 1);
    const win = src.slice(idx, nextPost > -1 ? nextPost : idx + 6000);
    expect(win).toMatch(/checkDemoRateLimit\([^)]+10[^)]+60_?000[^)]+"demo:min"/);
    expect(win).toMatch(/checkDemoRateLimit\([^)]+50[^)]+3_?600_?000[^)]+"demo:hour"/);
  });

  it("magic-link endpoint has IP layer via checkDemoRateLimit before email layer", () => {
    const idx = src.indexOf('"/api/auth/magic-link"');
    expect(idx).toBeGreaterThan(-1);
    const nextPost = src.indexOf("app.post(", idx + 1);
    const win = src.slice(idx, nextPost > -1 ? nextPost : idx + 3000);
    const ipLayerIdx = win.search(/checkDemoRateLimit\([^)]+5[^)]+60_?000[^)]+"magic:ip"/);
    const emailLayerIdx = win.search(/checkAuthRateLimit\(`magic:\$\{email\}`/);
    expect(ipLayerIdx, "IP layer (checkDemoRateLimit) missing in magic-link").toBeGreaterThan(-1);
    expect(emailLayerIdx, "email layer (checkAuthRateLimit) missing").toBeGreaterThan(-1);
    expect(ipLayerIdx).toBeLessThan(emailLayerIdx);
  });

  it("demoIpHourly Map is gone from production code", () => {
    // Only allow the one comment that documents the removal.
    const hits = [...src.matchAll(/demoIpHourly/g)];
    // Up to 1 hit is permitted (the removal comment); anything more means
    // the old Map resurfaced.
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});

/**
 * KIOKU™ Rate Limiting Middleware
 * Sliding window in-memory rate limiter per plan
 *
 * Plans:
 *   dev       — 1,000 req/day
 *   starter   — 10,000 req/day
 *   growth    — 100,000 req/day
 *   enterprise — unlimited
 */

import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";

const PLANS: Record<string, { daily: number; perMin: number }> = {
  dev:        { daily:      1_000, perMin: 30 },
  starter:    { daily:     10_000, perMin: 60 },
  growth:     { daily:    100_000, perMin: 300 },
  enterprise: { daily: 99_999_999, perMin: 9_999 },
};

// In-memory store: key → { count, windowStart }
const minuteWindows = new Map<string, { count: number; windowStart: number }>();
const dayWindows    = new Map<string, { count: number; windowStart: number }>();

function getWindow(
  map: Map<string, { count: number; windowStart: number }>,
  key: string,
  windowMs: number
): { count: number; windowStart: number } {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    const fresh = { count: 0, windowStart: now };
    map.set(key, fresh);
    return fresh;
  }
  return entry;
}

function incrementWindow(
  map: Map<string, { count: number; windowStart: number }>,
  key: string,
  windowMs: number
): { count: number; resetAt: number; limit: number; remaining: number } {
  const win = getWindow(map, key, windowMs);
  win.count += 1;
  return {
    count: win.count,
    resetAt: Math.ceil((win.windowStart + windowMs) / 1000),
    limit: 0,   // filled by caller
    remaining: 0,
  };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const minuteMs = 60_000;
  const dayMs = 86_400_000;
  for (const [k, v] of minuteWindows) {
    if (now - v.windowStart > minuteMs * 2) minuteWindows.delete(k);
  }
  for (const [k, v] of dayWindows) {
    if (now - v.windowStart > dayMs * 2) dayWindows.delete(k);
  }
}, 300_000);

/**
 * Rate limit middleware — attach after auth resolution
 * Resolves user plan from session token or X-API-Key header
 * Applies per-minute AND per-day limits
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip non-API routes and health
  if (!req.path.startsWith("/api") || req.path === "/health") return next();

  // Skip waitlist and auth endpoints — they're public
  if (
    req.path.startsWith("/api/auth") ||
    req.path === "/api/waitlist" ||
    req.path.startsWith("/api/billing/webhook")
  ) {
    return next();
  }

  // Resolve identity key (API key or session token)
  const apiKey = req.headers["x-api-key"] as string | undefined;
  const sessionToken = req.headers["x-session-token"] as string | undefined;

  // Demo session — dev plan limits apply but be generous
  const isDemoSession = sessionToken === "demo-session";

  const identityKey = apiKey || sessionToken || req.ip || "anonymous";

  // Async plan resolution — we optimistically use resolved plan
  resolveUserPlan(apiKey, sessionToken).then((plan) => {
    const limits = PLANS[plan] || PLANS["dev"];

    const minKey = `min:${identityKey}`;
    const dayKey = `day:${identityKey}`;

    const minResult = incrementWindow(minuteWindows, minKey, 60_000);
    const dayResult = incrementWindow(dayWindows, dayKey, 86_400_000);

    minResult.limit = limits.perMin;
    minResult.remaining = Math.max(0, limits.perMin - minResult.count);

    dayResult.limit = limits.daily;
    dayResult.remaining = Math.max(0, limits.daily - dayResult.count);

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", limits.daily);
    res.setHeader("X-RateLimit-Remaining", dayResult.remaining);
    res.setHeader("X-RateLimit-Reset", dayResult.resetAt);
    res.setHeader("X-RateLimit-Plan", plan);

    // Check per-minute limit first
    if (minResult.count > limits.perMin) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({
        error: "Rate limit exceeded",
        detail: `Plan '${plan}' allows ${limits.perMin} requests/min. Retry after ${60 - Math.floor((Date.now() - minuteWindows.get(minKey)!.windowStart) / 1000)}s`,
        plan,
        upgradeUrl: "https://usekioku.com/#pricing",
      });
    }

    // Check daily limit
    if (dayResult.count > limits.daily) {
      const resetAt = dayResult.resetAt;
      res.setHeader("Retry-After", String(resetAt - Math.floor(Date.now() / 1000)));
      return res.status(429).json({
        error: "Daily rate limit exceeded",
        detail: `Plan '${plan}' allows ${limits.daily.toLocaleString()} requests/day. Resets at ${new Date(resetAt * 1000).toISOString()}`,
        plan,
        upgradeUrl: "https://usekioku.com/#pricing",
      });
    }

    next();
  }).catch(() => {
    // On error, allow through (fail open)
    next();
  });
}

async function resolveUserPlan(apiKey?: string, sessionToken?: string): Promise<string> {
  if (sessionToken === "demo-session") return "dev";

  // Try API key lookup
  if (apiKey && apiKey.startsWith("kk_")) {
    try {
      const user = await storage.getUserByApiKey(apiKey);
      if (user) return user.plan || "dev";
    } catch {}
  }

  // Try JWT session
  if (sessionToken && sessionToken !== "demo-session") {
    try {
      const jwt = await import("jsonwebtoken");
      const JWT_SECRET = process.env.JWT_SECRET || "kioku_jwt_secret_ikonbai_2026";
      const payload = jwt.default.verify(sessionToken, JWT_SECRET) as { userId: number };
      if (payload.userId) {
        const user = await storage.getUserById(payload.userId);
        if (user) return user.plan || "dev";
      }
    } catch {}
  }

  return "dev";
}

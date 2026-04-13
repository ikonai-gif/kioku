/**
 * KIOKU™ Rate Limiting Middleware
 * Sliding window in-memory rate limiter per plan
 *
 * Plans (per-minute):
 *   free (dev)    — 60 req/min
 *   starter       — 300 req/min
 *   pro (growth)  — 1,000 req/min
 *   team (enterprise) — 5,000 req/min
 *
 * Unauthenticated (per IP): 100 req/min
 */

import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";

const PLANS: Record<string, { daily: number; perMin: number }> = {
  dev:        { daily:     5_000, perMin: 60 },
  free:       { daily:     5_000, perMin: 60 },
  starter:    { daily:    50_000, perMin: 300 },
  growth:     { daily:   200_000, perMin: 1_000 },
  pro:        { daily:   200_000, perMin: 1_000 },
  team:       { daily: 1_000_000, perMin: 5_000 },
  business:   { daily: 1_000_000, perMin: 5_000 },
  enterprise: { daily: 99_999_999, perMin: 9_999 },
};

const UNAUTHENTICATED_PER_MIN = 100;

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

  // Skip only billing webhooks (Stripe signature verification handles auth)
  if (req.path.startsWith("/api/billing/webhook")) {
    return next();
  }

  // Resolve identity key (API key or session token)
  const apiKey = req.headers["x-api-key"] as string | undefined;
  const sessionToken = req.headers["x-session-token"] as string | undefined;
  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";

  const isAuthenticated = !!(apiKey || sessionToken);
  const identityKey = apiKey || sessionToken || clientIp;

  // Global IP-based rate limit for unauthenticated requests
  if (!isAuthenticated) {
    const ipKey = `ip:${clientIp}`;
    const ipResult = incrementWindow(minuteWindows, ipKey, 60_000);
    if (ipResult.count > UNAUTHENTICATED_PER_MIN) {
      const retryAfter = Math.max(1, 60 - Math.floor((Date.now() - minuteWindows.get(ipKey)!.windowStart) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Rate limit exceeded",
        code: "RATE_LIMITED",
        status: 429,
        detail: `Unauthenticated limit: ${UNAUTHENTICATED_PER_MIN} requests/min. Retry after ${retryAfter}s`,
      });
    }
  }

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
    res.setHeader("X-RateLimit-Limit", limits.perMin);
    res.setHeader("X-RateLimit-Remaining", minResult.remaining);
    res.setHeader("X-RateLimit-Reset", minResult.resetAt);
    res.setHeader("X-RateLimit-Plan", plan);

    // Check per-minute limit first
    if (minResult.count > limits.perMin) {
      const retryAfter = Math.max(1, 60 - Math.floor((Date.now() - minuteWindows.get(minKey)!.windowStart) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Rate limit exceeded",
        code: "RATE_LIMITED",
        status: 429,
        detail: `Plan '${plan}' allows ${limits.perMin} requests/min. Retry after ${retryAfter}s`,
        plan,
        upgradeUrl: "https://usekioku.com/#pricing",
      });
    }

    // Check daily limit
    if (dayResult.count > limits.daily) {
      const resetAt = dayResult.resetAt;
      const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Daily rate limit exceeded",
        code: "DAILY_RATE_LIMITED",
        status: 429,
        detail: `Plan '${plan}' allows ${limits.daily.toLocaleString()} requests/day. Resets at ${new Date(resetAt * 1000).toISOString()}`,
        plan,
        upgradeUrl: "https://usekioku.com/#pricing",
      });
    }

    next();
  }).catch((err) => {
    // Fail closed — reject request on rate limit resolution error
    console.error('Rate limit resolution error:', err);
    res.status(429).json({ error: 'Rate limit error, please retry' });
  });
}

// Auth-specific rate limiting (per-endpoint, keyed by email or IP)
const authRateLimits = new Map<string, { count: number; resetAt: number }>();

export function checkAuthRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = authRateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    authRateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

// Clean up auth rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Array.from(authRateLimits.entries())) {
    if (now > v.resetAt) authRateLimits.delete(k);
  }
}, 300_000);

// Registration rate limiter: 3 per hour per IP
const registrationWindows = new Map<string, { count: number; windowStart: number }>();

export function checkRegistrationLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const key = `reg:${ip}`;
  const hourMs = 3_600_000;
  const win = getWindow(registrationWindows, key, hourMs);
  win.count += 1;
  if (win.count > 3) {
    const retryAfter = Math.max(1, Math.ceil((win.windowStart + hourMs - Date.now()) / 1000));
    return { allowed: false, retryAfter };
  }
  return { allowed: true, retryAfter: 0 };
}

// Clean up registration windows too
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of registrationWindows) {
    if (now - v.windowStart > 7_200_000) registrationWindows.delete(k);
  }
}, 300_000);

async function resolveUserPlan(apiKey?: string, sessionToken?: string): Promise<string> {
  // Try API key lookup
  if (apiKey && apiKey.startsWith("kk_")) {
    try {
      const user = await storage.getUserByApiKey(apiKey);
      if (user) return user.plan || "dev";
    } catch {}
  }

  // Try JWT session
  if (sessionToken) {
    try {
      const jwt = await import("jsonwebtoken");
      const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');
      const payload = jwt.default.verify(sessionToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      if (payload.userId) {
        const user = await storage.getUserById(payload.userId);
        if (user) return user.plan || "dev";
      }
    } catch {}
  }

  return "dev";
}

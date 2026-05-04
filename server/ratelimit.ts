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
import Redis from "ioredis";
import logger from "./logger";

// ── Redis connection (primary rate-limit store) ──────────────────────────────
let redis: Redis | null = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.connect().catch((err) => {
    logger.error({ source: "ratelimit", err: err.message }, "Redis connection failed, falling back to in-memory");
    redis = null;
  });
  redis.on("error", (err) => {
    logger.error({ source: "ratelimit", err: err.message }, "Redis error");
  });
}

const PLANS: Record<string, { daily: number; perMin: number }> = {
  dev:        { daily:     5_000, perMin: 60 },
  free:       { daily:     5_000, perMin: 60 },
  starter:    { daily:    50_000, perMin: 300 },
  growth:     { daily:   200_000, perMin: 1_000 },
  pro:        { daily:   200_000, perMin: 1_000 },
  team:       { daily: 1_000_000, perMin: 5_000 },
  business:   { daily: 1_000_000, perMin: 5_000 },
  enterprise: { daily: 99_999_999, perMin: 9_999 },
  // R415 — owner role bypass tier. Owners run the platform UI which polls
  // many endpoints in parallel (rooms, status, gallery, approvals, WS
  // reconnect). Effective "unlimited" so the owner is never locked out of
  // their own product. Telemetry headers are still emitted so behaviour
  // stays observable.
  owner:      { daily: 99_999_999, perMin: 9_999 },
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

// ── Redis-backed sliding window ──────────────────────────────────────────────
async function incrementWindowRedis(
  key: string,
  windowMs: number
): Promise<{ count: number; resetAt: number }> {
  const windowSec = Math.ceil(windowMs / 1000);
  const windowId = Math.floor(Date.now() / windowMs);
  const redisKey = `rl:${key}:${windowId}`;

  const count = await redis!.incr(redisKey);
  if (count === 1) {
    await redis!.expire(redisKey, windowSec);
  }

  return {
    count,
    resetAt: Math.ceil(((windowId + 1) * windowMs) / 1000),
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
export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip non-API routes and health
  if (!req.path.startsWith("/api") || req.path === "/health") return next();

  // Skip only billing webhooks (Stripe signature verification handles auth)
  if (req.path.startsWith("/api/billing/webhook")) {
    return next();
  }

  // Skip auth endpoints — they have their own purpose-built rate limits
  // (checkDemoRateLimit: 5/min IP bucket; checkAuthRateLimit: 15/hour email bucket).
  // The global IP limit was causing legitimate owners to be locked out of /auth
  // when other unauthenticated traffic from the same NAT/proxy IP exhausted the
  // shared-IP quota. Endpoint-specific limits remain enforced inside the route
  // handlers in server/auth/*. Note the trailing slash: /api/agent-auth/* and any
  // hypothetical /api/authentication path do NOT match this prefix.
  if (req.path.startsWith("/api/auth/")) {
    return next();
  }

  // Internal probes (health-check, lockout-prevention worker) bypass via
  // shared secret in X-Internal-Health header. Fail-safe: if env unset, the
  // header is ignored — never accept a missing/empty secret as valid.
  const internalSecret = process.env.INTERNAL_HEALTH_SECRET;
  if (internalSecret && req.headers["x-internal-health"] === internalSecret) {
    return next();
  }

  // Resolve identity key (API key, session token, or httpOnly cookie).
  // R460 — previously only x-api-key and x-session-token headers counted as
  // "authenticated". Cookie-only browser sessions (the default after
  // /api/auth/me auto-restore) were treated as unauthenticated and hit the
  // shared-IP 100 req/min bucket, instantly locking the owner out of their
  // own product with 429s on /api/rooms, /api/luca/status, /api/luca/approvals,
  // /api/gallery, etc. cookieParser runs earlier in the middleware chain
  // (server/index.ts:81) so req.cookies is always populated when the cookie
  // is present.
  const apiKey = req.headers["x-api-key"] as string | undefined;
  const headerSessionToken = req.headers["x-session-token"] as string | undefined;
  const cookieSessionToken = (req as any).cookies?.["kioku_session"] as string | undefined;
  const sessionToken = headerSessionToken || cookieSessionToken;
  const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";

  const isAuthenticated = !!(apiKey || sessionToken);
  const identityKey = apiKey || sessionToken || clientIp;

  // Global IP-based rate limit for unauthenticated requests
  if (!isAuthenticated) {
    const ipKey = `ip:${clientIp}`;

    if (redis) {
      try {
        const r = await incrementWindowRedis(ipKey, 60_000);
        if (r.count > UNAUTHENTICATED_PER_MIN) {
          const retryAfter = Math.max(1, r.resetAt - Math.floor(Date.now() / 1000));
          res.setHeader("Retry-After", String(retryAfter));
          return res.status(429).json({
            error: "Rate limit exceeded",
            code: "RATE_LIMITED",
            status: 429,
            detail: `Unauthenticated limit: ${UNAUTHENTICATED_PER_MIN} requests/min. Retry after ${retryAfter}s`,
          });
        }
      } catch {
        // Redis failed — fall through to in-memory
      }
    }

    // In-memory fallback (or primary when no Redis)
    if (!redis) {
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
  }

  try {
    const plan = await resolveUserPlan(apiKey, sessionToken);
    const limits = PLANS[plan] || PLANS["dev"];

    const minKey = `min:${identityKey}`;
    const dayKey = `day:${identityKey}`;

    let minCount: number;
    let minRemaining: number;
    let minResetAt: number;
    let dayCount: number;
    let dayRemaining: number;
    let dayResetAt: number;

    let usedRedis = false;
    if (redis) {
      try {
        const minR = await incrementWindowRedis(minKey, 60_000);
        const dayR = await incrementWindowRedis(dayKey, 86_400_000);
        minCount = minR.count;
        minResetAt = minR.resetAt;
        minRemaining = Math.max(0, limits.perMin - minCount);
        dayCount = dayR.count;
        dayResetAt = dayR.resetAt;
        dayRemaining = Math.max(0, limits.daily - dayCount);
        usedRedis = true;
      } catch {
        // Redis failed — fall through to in-memory
        usedRedis = false;
      }
    }

    if (!usedRedis) {
      const minResult = incrementWindow(minuteWindows, minKey, 60_000);
      const dayResult = incrementWindow(dayWindows, dayKey, 86_400_000);
      minCount = minResult.count;
      minResetAt = minResult.resetAt;
      minRemaining = Math.max(0, limits.perMin - minCount);
      dayCount = dayResult.count;
      dayResetAt = dayResult.resetAt;
      dayRemaining = Math.max(0, limits.daily - dayCount);
    }

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", limits.perMin);
    res.setHeader("X-RateLimit-Remaining", minRemaining!);
    res.setHeader("X-RateLimit-Reset", minResetAt!);
    res.setHeader("X-RateLimit-Plan", plan);

    // Check per-minute limit first
    if (minCount! > limits.perMin) {
      const retryAfter = usedRedis
        ? Math.max(1, minResetAt! - Math.floor(Date.now() / 1000))
        : Math.max(1, 60 - Math.floor((Date.now() - minuteWindows.get(minKey)!.windowStart) / 1000));
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
    if (dayCount! > limits.daily) {
      const retryAfter = Math.max(1, dayResetAt! - Math.floor(Date.now() / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Daily rate limit exceeded",
        code: "DAILY_RATE_LIMITED",
        status: 429,
        detail: `Plan '${plan}' allows ${limits.daily.toLocaleString()} requests/day. Resets at ${new Date(dayResetAt! * 1000).toISOString()}`,
        plan,
        upgradeUrl: "https://usekioku.com/#pricing",
      });
    }

    next();
  } catch (err) {
    // Fail closed — reject request on rate limit resolution error
    logger.error({ source: "ratelimit", err }, "rate limit resolution error");
    res.status(429).json({ error: 'Rate limit error, please retry' });
  }
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

// ── W7 F4.1 beta-open layered rate limits ────────────────────────────────────
// Thin wrapper around the existing sliding-window machinery. Each call keys
// {prefix:key}:{windowId} and is enforced with the same Redis-primary /
// in-memory-fallback strategy as the main middleware — so multi-instance
// Railway deploys get correct behaviour for free.
//
// Returns `{allowed, count, retryAfterSec}`. Retry-After is only meaningful
// when `allowed=false`; otherwise 0.
export async function checkDemoRateLimit(
  ipOrKey: string,
  limit: number,
  windowMs: number,
  prefix = "demo",
): Promise<{ allowed: boolean; count: number; retryAfterSec: number }> {
  const key = `${prefix}:${ipOrKey}`;

  if (redis) {
    try {
      const r = await incrementWindowRedis(key, windowMs);
      if (r.count > limit) {
        const retryAfterSec = Math.max(1, r.resetAt - Math.floor(Date.now() / 1000));
        return { allowed: false, count: r.count, retryAfterSec };
      }
      return { allowed: true, count: r.count, retryAfterSec: 0 };
    } catch {
      // fall through to in-memory
    }
  }

  const res = incrementWindow(minuteWindows, key, windowMs);
  if (res.count > limit) {
    const entry = minuteWindows.get(key)!;
    const retryAfterSec = Math.max(1, Math.ceil((entry.windowStart + windowMs - Date.now()) / 1000));
    return { allowed: false, count: res.count, retryAfterSec };
  }
  return { allowed: true, count: res.count, retryAfterSec: 0 };
}

// SECURITY: export Redis status for admin health check — avoids unhandled import error in boss-board
export async function getRedisStatus(): Promise<string> {
  if (!redis) return "not configured";
  try {
    await redis.ping();
    return "connected";
  } catch {
    return "disconnected";
  }
}

async function resolveUserPlan(apiKey?: string, sessionToken?: string): Promise<string> {
  // Try API key lookup
  if (apiKey && apiKey.startsWith("kk_")) {
    try {
      const user = await storage.getUserByApiKey(apiKey);
      if (user) {
        // R415 — owner role overrides plan tier. An owner on a 'dev' or 'free'
        // plan would otherwise be locked out of the product UI by their own
        // rate limits.
        if ((user as any).role === 'owner') return "owner";
        return user.plan || "dev";
      }
    } catch {}
  }

  // Try JWT session
  if (sessionToken) {
    try {
      const jwt = await import("jsonwebtoken");
      // SECURITY: must match routes.ts — empty secret in production would allow forged tokens
      const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');
      const payload = jwt.default.verify(sessionToken, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
      if (payload.userId) {
        const user = await storage.getUserById(payload.userId);
        if (user) {
          // R415 — owner role overrides plan tier (see api-key branch above).
          if ((user as any).role === 'owner') return "owner";
          return user.plan || "dev";
        }
      }
    } catch {}
  }

  return "dev";
}

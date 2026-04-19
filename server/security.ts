/**
 * KIOKU™ Security Middleware
 * Helmet headers · CORS · Body size limits · IP brute-force protection
 */

import helmet from "helmet";
import cors from "cors";
import type { Request, Response, NextFunction, Express } from "express";
import logger from "./logger";

// ── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://kioku-production.up.railway.app',
  'https://usekioku.com',
  'https://www.usekioku.com',
  // Development
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5000'] : []),
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-Key",
    "X-Session-Token",
    "x-session-token",
    "x-api-key",
    "Stripe-Signature",
  ],
  credentials: true,
  maxAge: 86400, // preflight cache 24h
});

// ── HELMET — Security Headers ─────────────────────────────────────────────────
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // NOTE: 'unsafe-inline' is required for Stripe.js and Vite dev mode
      // TODO: Replace with nonce-based CSP when migrating off inline scripts
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://fonts.googleapis.com"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:", "https:"],
      connectSrc:     ["'self'", "https://usekioku.com", "https://api.openai.com", "https://js.stripe.com"],
      mediaSrc:       ["'self'", "blob:", "data:", "https:"],
      frameSrc:       ["https://js.stripe.com"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // allow embedding Stripe
  frameguard: { action: "deny" }, // X-Frame-Options: DENY (matches CSP frame-ancestors: 'none')
  hsts: {
    maxAge: 31536000,       // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xPoweredBy: false, // remove X-Powered-By: Express fingerprint
});

// ── IP BRUTE-FORCE PROTECTION ────────────────────────────────────────────────
// Tracks failed auth attempts per IP — blocks after threshold
interface BruteEntry {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const bruteMap = new Map<string, BruteEntry>();

const BRUTE_WINDOW_MS  = 15 * 60 * 1000; // 15 min window
const BRUTE_MAX_FAILS  = 10;              // max failures before block
const BRUTE_BLOCK_MS   = 30 * 60 * 1000; // block for 30 min

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of bruteMap) {
    if (now > entry.blockedUntil && now - entry.firstAt > BRUTE_WINDOW_MS) {
      bruteMap.delete(ip);
    }
  }
}, 10 * 60 * 1000);

export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = bruteMap.get(ip);
  if (!entry || now - entry.firstAt > BRUTE_WINDOW_MS) {
    bruteMap.set(ip, { count: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= BRUTE_MAX_FAILS) {
    entry.blockedUntil = now + BRUTE_BLOCK_MS;
    logger.warn({ source: "security", ip, failures: entry.count }, "IP blocked — auth failures in window");
  }
}

export function recordAuthSuccess(ip: string): void {
  bruteMap.delete(ip);
}

export function bruteForceMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only apply to auth endpoints
  if (!req.path.startsWith("/api/auth")) return next();

  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || "unknown";

  const entry = bruteMap.get(ip);
  if (entry && Date.now() < entry.blockedUntil) {
    const retryAfter = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    res.setHeader("Retry-After", retryAfter);
    res.status(429).json({
      error: "Too many failed attempts",
      detail: `IP blocked for ${Math.ceil(retryAfter / 60)} more minutes`,
      retryAfter,
    });
    return;
  }

  next();
}

// ── REQUEST SIZE LIMITS ───────────────────────────────────────────────────────
// Stripe webhook needs raw body — handled separately in billing.ts
// All other JSON routes: 512KB max
export const REQUEST_SIZE_LIMIT = "512kb";

// ── SECURITY SUMMARY HEADER ───────────────────────────────────────────────────
// Adds X-KIOKU-Security header to all API responses for observability
export function securityAuditHeader(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-KIOKU-Security", "helmet+cors+brute-protection+rate-limited");
  next();
}

// ── APPLY ALL SECURITY MIDDLEWARE ─────────────────────────────────────────────
export function applySecurityMiddleware(app: Express): void {
  // Explicitly disable X-Powered-By before helmet (belt & suspenders)
  app.disable('x-powered-by');
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.options("/{*path}", corsMiddleware); // preflight
  app.use(bruteForceMiddleware);
  app.use("/api", securityAuditHeader);
}

import * as Sentry from "@sentry/node";

// Initialize Sentry EARLY — before Express app creation
Sentry.init({
  dsn: process.env.SENTRY_DSN || "",
  enabled: !!process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV || "development",
});

import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import crypto from "crypto";
import { initDb, initDemoUser, storage } from "./storage";
import { rateLimitMiddleware } from "./ratelimit";
import { applySecurityMiddleware } from "./security";
import { registerHealthRoutes } from "./health";
import { startMonitor, getMonitorSummary } from "./monitor";
import { startScheduler } from "./scheduler";
import logger, { generateRequestId } from "./logger";

// SECURITY: Constant-time string comparison to prevent timing attacks on secrets
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return bufA.length === bufB.length && crypto.timingSafeEqual(paddedA, paddedB);
}

// SECURITY: Require JWT_SECRET in production — prevents JWT forgery with fallback secrets
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  logger.fatal('JWT_SECRET env var is required in production');
  process.exit(1);
}

const app = express();
// Trust Railway's proxy to get real client IPs
app.set('trust proxy', 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── Security first (helmet, CORS, brute-force) ───────────────────────────────
applySecurityMiddleware(app);

app.use(
  express.json({
    limit: "10mb", // Large limit needed for base64 image uploads (camera photos → vision API)
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "128kb" }));
app.use(cookieParser());

// Prevent CDN caching of API routes
app.use(["/api", "/api/v1", "/v1", "/mcp", "/health", "/ready"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

// Rate limiting — per plan, per user
app.use(rateLimitMiddleware);

// ── API Versioning ─────────────────────────────────────────────────────────
// Rewrite /api/v1/* → /api/* so existing handlers work, add version header
app.use((req, res, next) => {
  // Add version header to all API responses
  if (req.path.startsWith("/api")) {
    res.setHeader("X-API-Version", "v1");
  }
  // Rewrite /api/v1/* to /api/*
  if (req.path.startsWith("/api/v1/")) {
    req.url = req.url.replace("/api/v1/", "/api/");
  }
  next();
});

export function log(message: string, source = "express") {
  logger.info({ source }, message);
}

// Redact sensitive fields before logging
const redactBody = (body: any): any => {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) {
    return `[Array(${body.length})]`;
  }
  const redacted = { ...body };
  const sensitiveKeys = ['apiKey', 'api_key', 'token', 'jwt', 'secret', 'password', 'key', 'embedding', 'webhookSecret'];
  for (const k of sensitiveKeys) {
    if (k in redacted) redacted[k] = '[REDACTED]';
  }
  return redacted;
};

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;
  let capturedError: string | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    if (bodyJson?.error) capturedError = bodyJson.error;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api") || path.startsWith("/mcp")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(redactBody(capturedJsonResponse))}`;
      }
      log(logLine);

      // Persist to kioku_request_logs (non-blocking, no-fail)
      const apiKey = (req.headers["x-api-key"] as string) ||
                     ((req.headers["authorization"] as string)?.startsWith("Bearer kk_")
                       ? (req.headers["authorization"] as string).slice(7) : undefined);
      storage.logRequest({
        method: req.method,
        path,
        apiKeyId: apiKey ? apiKey.slice(0, 12) + "…" : undefined,
        statusCode: res.statusCode,
        latencyMs: duration,
        errorMessage: capturedError,
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip,
        userAgent: (req.headers["user-agent"] as string)?.slice(0, 200),
      }).catch(() => {}); // never fail the request

      // Usage metering: increment API calls for authenticated users (non-blocking)
      if (apiKey && apiKey.startsWith("kk_")) {
        storage.getUserByApiKey(apiKey).then(user => {
          if (user) storage.incrementUsage(user.id, 'api_calls').catch(() => {});
        }).catch(() => {});
      } else if (req.headers["x-session-token"]) {
        // Resolve userId from session token for metering
        import("jsonwebtoken").then(jwt => {
          const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');
          const payload = jwt.default.verify(req.headers["x-session-token"] as string, JWT_SECRET, { algorithms: ['HS256'] }) as { userId: number };
          if (payload.userId) storage.incrementUsage(payload.userId, 'api_calls').catch(() => {});
        }).catch(() => {});
      }
    }
  });

  next();
});

(async () => {
  // Init DB — non-fatal: server starts even if DB is unreachable
  try {
    await initDb();
    await initDemoUser();
    logger.info({ source: "db" }, "initialized");
  } catch (err) {
    logger.error({ source: "db", err }, "init failed (will retry on first request)");
  }

  // Health routes (registered before main routes so /health is never rate-limited)
  registerHealthRoutes(app);

  // Alias: /api/health → same as /health (monitoring tools expect /api prefix)
  app.get("/api/health", (_req: Request, res: Response) => {
    res.redirect(307, "/health");
  });

  // Monitor status endpoint — master key protected
  app.get("/health/monitor", (req: Request, res: Response) => {
    const masterKey = process.env.KIOKU_MASTER_KEY;
    if (!masterKey || !safeCompare(req.headers["x-master-key"] as string || '', masterKey)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    res.json(getMonitorSummary());
  });

  // Admin request logs endpoint — master key protected
  app.get("/api/admin/logs", async (req: Request, res: Response) => {
    const masterKey = process.env.KIOKU_MASTER_KEY;
    if (!masterKey || !safeCompare(req.headers["x-master-key"] as string || '', masterKey)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const startDate = req.query.start ? parseInt(req.query.start as string) : undefined;
    const endDate = req.query.end ? parseInt(req.query.end as string) : undefined;
    const apiKeyId = req.query.key as string | undefined;
    const statusCode = req.query.status ? parseInt(req.query.status as string) : undefined;
    const result = await storage.getRequestLogs({ limit, offset, startDate, endDate, apiKeyId, statusCode });
    res.json(result);
  });

  await registerRoutes(httpServer, app);

  // Sentry error handler — must be AFTER all routes, BEFORE custom error handler
  Sentry.setupExpressErrorHandler(app);

  // ── Global Error Handler — structured JSON, no stack traces in prod ────
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    const isProd = process.env.NODE_ENV === "production";
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Log full error internally
    logger.error({ source: "error-handler", err: isProd ? message : err }, message);

    // Detect Supabase/DB timeout
    if (err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED" || err.message?.includes("timeout")) {
      return res.status(503).json({
        error: "Service temporarily unavailable. Please retry shortly.",
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
    }

    // Structured JSON — never expose stack traces in production
    return res.status(status).json({
      error: isProd && status === 500 ? "Internal server error" : message,
      code: err.code || (status === 400 ? "BAD_REQUEST" : status === 401 ? "UNAUTHORIZED" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR"),
      status,
    });
  });

  // ── API 404 catch-all — return JSON for unknown /api/* routes ──────
  app.all('/api/{*path}', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', status: 404 });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Start internal watchdog monitor
  startMonitor();

  // Start task scheduler (Phase 4: Scheduling & Automation)
  startScheduler();

  // Auto-purge old request logs every 24 hours (GDPR compliance)
  setInterval(async () => {
    try {
      const purged = await storage.purgeOldRequestLogs(90);
      if (purged > 0) logger.info({ source: "gc", purged }, "purged request logs older than 90 days");
    } catch (err) {
      logger.error({ source: "gc", err }, "request log purge error");
    }
  }, 24 * 60 * 60 * 1000);

  // Also run once on startup (with delay)
  setTimeout(async () => {
    try {
      const purged = await storage.purgeOldRequestLogs(90);
      if (purged > 0) logger.info({ source: "gc", purged }, "startup purge: old request logs removed");
    } catch { /* ignore startup errors */ }
  }, 60000);

  // Retention policy — daily cleanup
  setInterval(async () => {
    try {
      const masterKey = process.env.KIOKU_MASTER_KEY;
      if (masterKey) {
        await fetch(`http://localhost:${port}/api/privacy/retention-cleanup`, {
          method: "POST",
          headers: { "x-api-key": masterKey, "Content-Type": "application/json" },
        });
      }
    } catch { /* retention cleanup failure is non-fatal */ }
  }, 24 * 60 * 60 * 1000);

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  // Process-level error handlers for production stability
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, "uncaught exception");
    // Give time for logs to flush, then exit
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason }, "unhandled rejection");
  });

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();

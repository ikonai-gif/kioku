import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initDb, initDemoUser, storage } from "./storage";
import { rateLimitMiddleware } from "./ratelimit";
import { applySecurityMiddleware } from "./security";
import { registerHealthRoutes } from "./health";
import { startMonitor, getMonitorSummary } from "./monitor";

// SECURITY: Require JWT_SECRET in production — prevents JWT forgery with fallback secrets
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required in production');
  process.exit(1);
}

const app = express();
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
    limit: "512kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "128kb" }));
app.use(cookieParser());

// Prevent CDN caching of API routes
app.use(["/api", "/api/v1", "/v1", "/mcp", "/health"], (_req, res, next) => {
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
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

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
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
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
    }
  });

  next();
});

(async () => {
  // Init DB — non-fatal: server starts even if DB is unreachable
  try {
    await initDb();
    await initDemoUser();
    console.log("[db] initialized");
  } catch (err) {
    console.error("[db] init failed (will retry on first request):", err);
  }

  // Health routes (registered before main routes so /health is never rate-limited)
  registerHealthRoutes(app);

  // Monitor status endpoint — master key protected
  app.get("/health/monitor", (req: Request, res: Response) => {
    const masterKey = process.env.KIOKU_MASTER_KEY;
    if (masterKey) {
      const auth = req.headers["x-master-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (auth !== masterKey) return res.status(401).json({ error: "Unauthorized" });
    }
    res.json(getMonitorSummary());
  });

  // Admin request logs endpoint — master key protected
  app.get("/api/admin/logs", async (req: Request, res: Response) => {
    const masterKey = process.env.KIOKU_MASTER_KEY;
    if (masterKey) {
      const auth = req.headers["x-master-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (auth !== masterKey) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED", status: 401 });
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

  // ── Global Error Handler — structured JSON, no stack traces in prod ────
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    const isProd = process.env.NODE_ENV === "production";
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Log full error internally
    console.error("[error-handler]", isProd ? message : err);

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

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
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

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initDb, initDemoUser } from "./storage";
import { rateLimitMiddleware } from "./ratelimit";
import { applySecurityMiddleware } from "./security";
import { registerHealthRoutes } from "./health";
import { startMonitor, getMonitorSummary } from "./monitor";

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

// Prevent CDN caching of API routes
app.use(["/api", "/v1", "/mcp", "/health"], (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

// Rate limiting — per plan, per user
app.use(rateLimitMiddleware);

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

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
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

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
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

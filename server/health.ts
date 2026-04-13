/**
 * KIOKU™ Health Check System
 * /health        — fast liveness (Railway uses this)
 * /health/deep   — full diagnostic (DB + Redis + OpenAI + memory)
 * /health/ready  — readiness gate (all critical services up)
 */

import type { Express, Request, Response } from "express";
import { pool } from "./storage";
import { safeCompare } from "./index";

// ── Types ─────────────────────────────────────────────────────────────────────
interface CheckResult {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  detail?: string;
  error?: string;
}

interface DeepHealthReport {
  status: "ok" | "degraded" | "down";
  version: string;
  uptime: number;
  timestamp: string;
  checks: {
    database:  CheckResult;
    redis:     CheckResult;
    openai:    CheckResult;
    memory:    CheckResult;
    disk:      CheckResult;
  };
}

const START_TIME = Date.now();
const VERSION = "1.0.0";

// ── Individual Checks ─────────────────────────────────────────────────────────

async function checkDatabase(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { status: "down", latencyMs: Date.now() - t0, error: err.message };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const t0 = Date.now();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return { status: "degraded", detail: "REDIS_URL not set — running without Redis" };
  }
  try {
    // Use net socket to ping Redis without full client
    const { createConnection } = await import("net");
    const url = new URL(redisUrl);
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: url.hostname, port: Number(url.port || 6379) });
      const timeout = setTimeout(() => { sock.destroy(); reject(new Error("timeout")); }, 2000);
      sock.on("connect", () => {
        clearTimeout(timeout);
        sock.write("PING\r\n");
        sock.once("data", () => { sock.destroy(); resolve(); });
      });
      sock.on("error", (e) => { clearTimeout(timeout); reject(e); });
    });
    return { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { status: "degraded", latencyMs: Date.now() - t0, error: err.message };
  }
}

async function checkOpenAI(): Promise<CheckResult> {
  const t0 = Date.now();
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { status: "degraded", detail: "OPENAI_API_KEY not set" };
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401) return { status: "down", latencyMs: Date.now() - t0, error: "Invalid API key" };
    if (!res.ok) return { status: "degraded", latencyMs: Date.now() - t0, detail: `HTTP ${res.status}` };
    return { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { status: "degraded", latencyMs: Date.now() - t0, error: err.message };
  }
}

function checkMemory(): CheckResult {
  const mem = process.memoryUsage();
  const heapUsedMB  = Math.round(mem.heapUsed  / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB       = Math.round(mem.rss       / 1024 / 1024);
  const usagePct    = Math.round((mem.heapUsed / mem.heapTotal) * 100);

  const status: CheckResult["status"] =
    usagePct > 95 ? "down" :
    usagePct > 80 ? "degraded" : "ok";

  return {
    status,
    detail: `heap ${heapUsedMB}/${heapTotalMB}MB (${usagePct}%) · rss ${rssMB}MB`,
  };
}

function checkDisk(): CheckResult {
  // In Railway container we can't easily check disk — report ok with note
  return { status: "ok", detail: "Railway managed — no disk concern" };
}

// ── Status aggregation ────────────────────────────────────────────────────────
function aggregate(checks: DeepHealthReport["checks"]): "ok" | "degraded" | "down" {
  const statuses = Object.values(checks).map(c => c.status);
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

// ── Last known health state (used by monitor) ──────────────────────────────────
let lastReport: DeepHealthReport | null = null;
export function getLastHealthReport(): DeepHealthReport | null { return lastReport; }

// ── Route registration ────────────────────────────────────────────────────────
export function registerHealthRoutes(app: Express): void {

  // GET /health — enhanced liveness (Railway health check + DB ping + uptime)
  app.get("/health", async (_req: Request, res: Response) => {
    const t0 = Date.now();
    let dbStatus: "connected" | "disconnected" = "connected";
    let dbLatency = 0;
    try {
      await pool.query("SELECT 1");
      dbLatency = Date.now() - t0;
    } catch {
      dbStatus = "disconnected";
      dbLatency = Date.now() - t0;
    }

    const status = dbStatus === "connected" ? "ok" : "degraded";
    const httpStatus = status === "ok" ? 200 : 503;

    res.status(httpStatus).json({
      status,
      ts: new Date().toISOString(),
      db: dbStatus,
      db_latency_ms: dbLatency,
      version: VERSION,
      uptime_s: Math.floor((Date.now() - START_TIME) / 1000),
    });
  });

  // GET /health/ready — readiness (DB must be up)
  app.get("/health/ready", async (_req: Request, res: Response) => {
    const db = await checkDatabase();
    const ready = db.status === "ok";
    res.status(ready ? 200 : 503).json({
      ready,
      database: db.status,
      latencyMs: db.latencyMs,
    });
  });

  // GET /health/deep — full diagnostic (internal/partner use)
  app.get("/health/deep", async (req: Request, res: Response) => {
    // Fail-closed: require KIOKU_MASTER_KEY — deny if not set
    const masterKey = process.env.KIOKU_MASTER_KEY;
    if (!masterKey || !safeCompare(req.headers["x-master-key"] as string || '', masterKey)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const [database, redis, openai] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkOpenAI(),
    ]);

    const memory = checkMemory();
    const disk   = checkDisk();

    const checks = { database, redis, openai, memory, disk };
    const report: DeepHealthReport = {
      status:    aggregate(checks),
      version:   VERSION,
      uptime:    Math.floor((Date.now() - START_TIME) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    };

    lastReport = report;

    const httpStatus = report.status === "down" ? 503 : 200;
    res.status(httpStatus).json(report);
  });
}

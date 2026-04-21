/**
 * KIOKU™ Health Check Primitives
 *
 * Extracted check functions used by /health/detailed (public, cheap)
 * and available for future internal use.
 *
 * Each check accepts an optional AbortSignal for the 2.5s deadline enforced
 * by /health/detailed via Promise.allSettled + AbortController.
 */

import { pool } from "../storage";
import { getRedisClient } from "./redis";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Check = {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
  detail?: string;
  error?: string;
  [k: string]: unknown;
};

// ── checkDatabase ─────────────────────────────────────────────────────────────

/**
 * Ping the Postgres pool with a lightweight SELECT 1.
 * Returns `down` on any error (including abort).
 */
export async function checkDatabase(signal?: AbortSignal): Promise<Check> {
  const t0 = Date.now();
  try {
    if (signal?.aborted) {
      return { status: "down", error: "timeout", latency_ms: 0 };
    }
    const client = await pool.connect();
    // Respect abort after connect
    if (signal?.aborted) {
      client.release();
      return { status: "down", error: "timeout", latency_ms: Date.now() - t0 };
    }
    await client.query("SELECT 1");
    client.release();
    return { status: "ok", latency_ms: Date.now() - t0 };
  } catch (err: any) {
    return { status: "down", latency_ms: Date.now() - t0, error: err.message };
  }
}

// ── checkRedis ────────────────────────────────────────────────────────────────

/**
 * PING Redis via the lazy IORedis client.
 * Returns `degraded` if REDIS_URL is not set (not an error, just not configured).
 * Returns `down` on connection error or timeout.
 */
export async function checkRedis(signal?: AbortSignal): Promise<Check> {
  const t0 = Date.now();

  if (!process.env.REDIS_URL) {
    return { status: "degraded", detail: "REDIS_URL not set — running without Redis" };
  }

  if (signal?.aborted) {
    return { status: "down", error: "timeout", latency_ms: 0 };
  }

  try {
    const redis = getRedisClient();
    if (!redis) {
      return { status: "degraded", detail: "Redis client unavailable" };
    }

    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000)
      ),
    ]);

    return { status: "ok", latency_ms: Date.now() - t0 };
  } catch (err: any) {
    return { status: "down", latency_ms: Date.now() - t0, error: err.message };
  }
}

// ── checkMigrations ───────────────────────────────────────────────────────────

/**
 * Detect stale (crashed-mid-run) migrations.
 * A migration is stale if duration_ms = 0 and applied_at < NOW() - 1h
 * (meaning it was claimed but never completed).
 *
 * Returns:
 *   - `down`  when pending_stale > 0
 *   - `ok`    otherwise
 *
 * Q1: NO total_applied exposed (schema evolution cadence leak).
 * O2: Includes latest_applied_at for observability.
 */
export async function checkMigrations(signal?: AbortSignal): Promise<Check> {
  const t0 = Date.now();
  try {
    if (signal?.aborted) {
      return { status: "down", error: "timeout", latency_ms: 0 };
    }

    const { rows } = await pool.query<{
      stale: string;
      latest_applied_at: Date | null;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE duration_ms = 0 AND applied_at < NOW() - INTERVAL '1 hour') AS stale,
        MAX(applied_at) FILTER (WHERE duration_ms > 0) AS latest_applied_at
      FROM schema_migrations
    `);

    const row = rows[0];
    const pendingStale = parseInt(row?.stale ?? "0", 10);
    const latestAppliedAt = row?.latest_applied_at
      ? new Date(row.latest_applied_at).toISOString()
      : null;

    const status: Check["status"] = pendingStale > 0 ? "down" : "ok";
    return {
      status,
      latency_ms: Date.now() - t0,
      pending_stale: pendingStale,
      latest_applied_at: latestAppliedAt,
    };
  } catch (err: any) {
    return { status: "down", latency_ms: Date.now() - t0, error: err.message };
  }
}

// ── checkQueues ───────────────────────────────────────────────────────────────

/**
 * Check BullMQ availability. Synchronous — reads env state, no I/O.
 * Returns `degraded` if Redis (required for BullMQ) is not configured.
 */
export function checkQueues(): Check {
  if (!process.env.REDIS_URL) {
    return { status: "degraded", detail: "disabled — REDIS_URL not set" };
  }
  return { status: "ok", detail: "bullmq-connected" };
}

// ── checkMemory ───────────────────────────────────────────────────────────────

/**
 * Report process memory usage.
 *
 * Q8.2 / O1: Uses RSS + RAILWAY_MEMORY_LIMIT_MB when available.
 * Falls back to V8 heap% when no limit is configured.
 */
export function checkMemory(): Check {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const limitMB =
    parseInt(process.env.RAILWAY_MEMORY_LIMIT_MB || "0", 10) || null;
  const pct = limitMB
    ? Math.round((rssMB / limitMB) * 100)
    : Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const status: Check["status"] =
    pct > 95 ? "down" : pct > 80 ? "degraded" : "ok";

  return {
    status,
    rss_mb: rssMB,
    heap_mb: heapUsedMB,
    usage_pct: pct,
    limit_mb: limitMB,
  };
}

// ── aggregateStatus ───────────────────────────────────────────────────────────

/**
 * Roll up individual check statuses into one overall status.
 * Any `down` → `down`. Any `degraded` → `degraded`. All `ok` → `ok`.
 */
export function aggregateStatus(
  checks: Record<string, Check>
): "ok" | "degraded" | "down" {
  const statuses = Object.values(checks).map((c) => c.status);
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

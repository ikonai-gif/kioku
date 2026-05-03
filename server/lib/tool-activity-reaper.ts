/**
 * Tool-activity TTL reaper — BRO1 hot-fix #2 for PR #106 (Phase 1 timeline).
 *
 * Background sweep that deletes `tool_activity_log` rows older than the TTL
 * (default 30 days). Without this the table grows unbounded — at ~50 rows
 * per active conversation × multi-week sessions, this would balloon.
 *
 * Design (mirrors meeting-reaper.ts):
 *   - One sweep every `intervalMs` (default 6h). Cheap DELETE; index on
 *     created_at exists indirectly via room_id+created_at composite.
 *   - Single instance per process; safe to run concurrently (DELETE is
 *     idempotent), but wasteful. Pin to one replica in prod (Railway = 1).
 *   - Gated on `TOOL_ACTIVITY_TTL_REAPER_ENABLED` — defaults to "true" when
 *     env unset (safe-by-default; explicit "false" disables).
 *   - `unref()`-ed interval so Node can exit cleanly.
 *
 * BRO1 R431 ack:
 *   - TTL is hard-floored at 1 day (no accidental rm -rf of recent rows
 *     via env mis-config).
 *   - Returns deleted-count for observability + tests.
 */

import type { Pool } from "pg";
import logger from "../logger";

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const MIN_TTL_DAYS = 1;

export interface ToolActivityReaperOptions {
  pool: Pool;
  /** Override for tests. */
  intervalMs?: number;
  /** Override for tests. */
  ttlDays?: number;
}

export interface ToolActivityReaperStats {
  rowsDeleted: number;
}

export interface ToolActivityReaperHandle {
  stop(): void;
  /** Test helper: force one sweep immediately. */
  sweepOnce(): Promise<ToolActivityReaperStats>;
}

function resolveTtlDays(opts: ToolActivityReaperOptions): number {
  if (opts.ttlDays != null) return Math.max(MIN_TTL_DAYS, Number(opts.ttlDays));
  const envDays = Number(process.env.TOOL_ACTIVITY_TTL_DAYS);
  if (Number.isFinite(envDays) && envDays > 0) {
    return Math.max(MIN_TTL_DAYS, Math.floor(envDays));
  }
  return DEFAULT_TTL_DAYS;
}

export async function runToolActivitySweep(
  opts: ToolActivityReaperOptions
): Promise<ToolActivityReaperStats> {
  const ttlDays = resolveTtlDays(opts);
  const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  try {
    const res = await opts.pool.query(
      `DELETE FROM tool_activity_log WHERE created_at < $1`,
      [cutoffMs]
    );
    return { rowsDeleted: res.rowCount ?? 0 };
  } catch (err: any) {
    logger.warn({ err: err?.message }, "tool-activity-reaper: sweep failed");
    return { rowsDeleted: 0 };
  }
}

export function startToolActivityReaper(
  opts: ToolActivityReaperOptions
): ToolActivityReaperHandle {
  // Disabled-by-default unless env is explicitly NOT "false". This matches
  // BRO1 must-fix: the reaper is mandatory for prod, but devs / tests should
  // be able to opt out by setting TOOL_ACTIVITY_TTL_REAPER_ENABLED=false.
  if (process.env.TOOL_ACTIVITY_TTL_REAPER_ENABLED === "false") {
    logger.info("tool-activity-reaper: disabled via env");
    return {
      stop: () => undefined,
      sweepOnce: () => Promise.resolve({ rowsDeleted: 0 }),
    };
  }

  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ttlDays = resolveTtlDays(opts);
  logger.info(
    { intervalMs: interval, ttlDays },
    "tool-activity-reaper: starting"
  );

  const tick = async () => {
    try {
      const stats = await runToolActivitySweep(opts);
      if (stats.rowsDeleted > 0) {
        logger.info(stats, "tool-activity-reaper: rows reaped");
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, "tool-activity-reaper: tick crashed");
    }
  };

  const handle = setInterval(tick, interval);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop: () => clearInterval(handle),
    sweepOnce: () => runToolActivitySweep(opts),
  };
}

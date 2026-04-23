/**
 * Luca Day 6 — approval expire worker.
 *
 * Periodic tick (default 60s) that flips any `tool_approvals` rows
 * past their `expires_at` from status='pending' → 'timeout'. Emits a
 * WS event per timed-out row so the Luca Board UI can grey the card
 * without the user having to refresh.
 *
 * Worker is started at boot from server/index.ts iff
 * LUCA_APPROVAL_GATE_ENABLED=true. No-op otherwise (no rows exist).
 *
 * Per-tick cost is tiny: one UPDATE ... WHERE status='pending' AND
 * expires_at < now() RETURNING *, backed by a partial index on
 * (expires_at) filtered by status='pending' (migration 0006).
 */

import logger from "../../logger";
import { expirePending } from "./gate";
import { broadcastApprovalDecided } from "./ws-events";

/** Tick interval in ms. Kept module-local so tests can't diverge on value. */
export const EXPIRE_WORKER_TICK_MS = 60 * 1000;

let _handle: NodeJS.Timeout | null = null;

/**
 * Start the expire worker. Idempotent — calling twice is a no-op
 * (returns the existing handle). Safe across hot-reloads in dev.
 */
export function startApprovalExpireWorker(
  tickMs: number = EXPIRE_WORKER_TICK_MS,
): NodeJS.Timeout {
  if (_handle) return _handle;
  _handle = setInterval(() => {
    void runExpireTick();
  }, tickMs);
  // Don't block SIGTERM — this is a background housekeeping worker.
  if (typeof _handle.unref === "function") _handle.unref();
  logger.info(
    { component: "luca-approvals", event: "expire_worker_started", tickMs },
    "[luca-approvals] expire worker started",
  );
  return _handle;
}

/** Test/shutdown helper. Clears the interval and resets the handle. */
export function stopApprovalExpireWorker(): void {
  if (_handle) {
    clearInterval(_handle);
    _handle = null;
  }
}

/**
 * One tick. Exposed for direct invocation from tests.
 * Never throws — errors are logged and swallowed.
 */
export async function runExpireTick(): Promise<number> {
  try {
    const expired = await expirePending();
    if (expired.length > 0) {
      logger.info(
        {
          component: "luca-approvals",
          event: "expire_tick",
          count: expired.length,
        },
        `[luca-approvals] expired ${expired.length} pending approvals`,
      );
      // Fan out WS events so the board UI updates without polling.
      for (const row of expired) {
        try {
          broadcastApprovalDecided({
            approvalId: row.id,
            userId: row.userId,
            status: "timeout",
            toolName: row.toolName,
            decidedAt: row.decidedAt ?? new Date(),
            finalPayload: null,
          });
        } catch (e) {
          // Broadcast failure must not break the tick.
          logger.warn(
            { component: "luca-approvals", event: "expire_broadcast_failed", approvalId: row.id, err: e instanceof Error ? e.message : String(e) },
            "[luca-approvals] broadcast failed for timed-out approval",
          );
        }
      }
    }
    return expired.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(
      { component: "luca-approvals", event: "expire_tick_failed", err: msg },
      "[luca-approvals] expire tick failed",
    );
    return 0;
  }
}

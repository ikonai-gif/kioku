/**
 * CRON-2 — nightly memory consolidation [LUCA-098 / SPEC-3b / BRO2].
 *
 * Sleep-time consolidation: once a night, merge highly-similar memories per
 * user. consolidateMemories already implements the merge; this is the missing
 * scheduler that the manual /api/memories/consolidate endpoint never provided.
 *
 * Gated by MEMORY_CONSOLIDATION_ENABLED (default OFF) — registers but returns
 * early so prod blast radius is zero until BOSS GO. Iterates only users with
 * recent memory writes to avoid scanning the whole table nightly.
 */
import { pool } from "../storage";
import { consolidateMemories } from "../memory-consolidation";
import logger from "../logger";

export const CRON2_JOB_ID = "CRON-2-consolidation";

/** Window of recent activity that makes a user eligible for nightly consolidation. */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function consolidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MEMORY_CONSOLIDATION_ENABLED ?? "").trim().toLowerCase() === "true";
}

export async function runNightlyConsolidation(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<{ usersProcessed: number; totalMerged: number }> {
  if (!consolidationEnabled(env)) {
    logger.debug({ component: "cron", job: CRON2_JOB_ID }, "[CRON-2] disabled — skip");
    return { usersProcessed: 0, totalMerged: 0 };
  }

  const cutoff = now - ACTIVE_WINDOW_MS;
  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM memories WHERE created_at >= $1`,
    [cutoff],
  );

  let usersProcessed = 0;
  let totalMerged = 0;
  for (const row of rows) {
    const userId = Number(row.user_id);
    if (!Number.isFinite(userId)) continue;
    try {
      const result = await consolidateMemories(pool, userId);
      usersProcessed++;
      totalMerged += result.merged;
      if (result.merged > 0) {
        logger.info(
          { component: "cron", job: CRON2_JOB_ID, userId, merged: result.merged },
          "[CRON-2] consolidated user memories",
        );
      }
    } catch (e) {
      logger.warn(
        { component: "cron", job: CRON2_JOB_ID, userId, err: String(e) },
        "[CRON-2] consolidation failed for user (non-fatal, continuing)",
      );
    }
  }

  logger.info(
    { component: "cron", job: CRON2_JOB_ID, usersProcessed, totalMerged },
    "[CRON-2] nightly consolidation complete",
  );
  return { usersProcessed, totalMerged };
}

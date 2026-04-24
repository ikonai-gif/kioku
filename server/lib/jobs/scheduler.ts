/**
 * KIOKU™ Internal Jobs — Scheduler
 *
 * Step 3 (PR #68). Owns the tick loop for business-level internal jobs
 * (daily-backup, annual missed-by-both review, and future ones). Lives
 * alongside the pre-existing self-monitoring jobs loop rather than
 * replacing it — self-monitoring is a product subsystem with different
 * semantics (no multi-replica safety needed; always fires on every
 * replica because its output is idempotent).
 *
 * This scheduler:
 *   - Ticks every 60s, checks UTC time against registered jobs.
 *   - Matches day-of-year for annual jobs, and every-day for daily jobs.
 *   - Uses runWithClaim() so only one replica actually runs each fire.
 *   - Reports failures to jobs webhook.
 *
 * Registration is static; jobs live in lib/jobs/ and are imported here.
 */

import logger from "../../logger";
import { runWithClaim } from "./job-runs";
import { runDailyBackup, DAILY_BACKUP_JOB_ID } from "./daily-backup";
import { runMissedByBothReview, MISSED_BY_BOTH_JOB_ID } from "./missed-by-both";
import { notifyJob } from "./jobs-webhook";

const TICK_MS = 60_000;

export type InternalJob = {
  id: string;
  /** UTC hour 0-23 */
  utcHour: number;
  /** UTC minute 0-59 */
  utcMinute: number;
  /**
   * Date gate. `daily` → fires each day. `{ month, day }` (1-indexed) →
   * fires only when the current UTC date matches that month+day (annual).
   */
  schedule: "daily" | { month: number; day: number };
  disabled?: boolean;
  run: () => Promise<Record<string, unknown> | void>;
};

export const JOBS: InternalJob[] = [
  {
    id: DAILY_BACKUP_JOB_ID,
    utcHour: 13,
    utcMinute: 0,
    schedule: "daily",
    run: () => runDailyBackup(),
  },
  {
    id: MISSED_BY_BOTH_JOB_ID,
    utcHour: 16,
    utcMinute: 0,
    schedule: { month: 7, day: 21 },
    run: () => runMissedByBothReview(),
  },
];

export function isDue(job: InternalJob, now: Date): boolean {
  if (job.disabled) return false;
  if (now.getUTCHours() !== job.utcHour) return false;
  // Allow the target minute and the following minute so a 60s tick that
  // fires mid-way through the target minute still catches the window.
  const min = now.getUTCMinutes();
  if (min !== job.utcMinute && min !== job.utcMinute + 1) return false;
  if (job.schedule === "daily") return true;
  return (
    now.getUTCMonth() + 1 === job.schedule.month &&
    now.getUTCDate() === job.schedule.day
  );
}

export async function tick(now: Date = new Date()): Promise<void> {
  for (const job of JOBS) {
    if (!isDue(job, now)) continue;
    logger.info(
      { component: "jobs", job_id: job.id, utc: now.toISOString() },
      `[jobs] firing ${job.id}`,
    );
    const result = await runWithClaim(job.id, async () => {
      const detail = await job.run();
      return detail ?? {};
    });
    if (result.ran && result.status === "error") {
      // runWithClaim has persisted; now alert operators.
      await notifyJob({
        severity: "critical",
        title: `Job failed: ${job.id}`,
        detail: result.error ?? "unknown error",
        context: { job_id: job.id, run_id: result.runId, duration_ms: result.durationMs },
      }).catch((e) =>
        logger.error({ err: e?.message, job_id: job.id }, "[jobs] notify failed"),
      );
    }
  }
}

let started = false;

export function startJobScheduler(): void {
  if (started) {
    logger.warn("[jobs] scheduler already started");
    return;
  }
  started = true;
  tick().catch((err) =>
    logger.error({ err: err?.message }, "[jobs] initial tick failed"),
  );
  setInterval(() => {
    tick().catch((err) =>
      logger.error({ err: err?.message }, "[jobs] tick failed"),
    );
  }, TICK_MS);
  logger.info("[jobs] scheduler started — tick every 60s");
}

// For tests.
export const __test__ = { JOBS, isDue, tick };

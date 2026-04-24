/**
 * KIOKU™ Internal Jobs — persistent run record + cluster-wide dedup
 *
 * Step 3 (PR #68). Wraps kioku_job_runs (migration 0009) with a safe claim
 * protocol:
 *
 *   1. INSERT (job_id, utc_day, status='running') … ON CONFLICT DO NOTHING.
 *      If 0 rows inserted, some other replica/tick already claimed today —
 *      skip silently.
 *   2. Grab pg_try_advisory_lock(hashtext(job_id)) for the duration of the
 *      run. If it fails, another concurrent run is in-flight (rare edge case:
 *      two replicas INSERT near-simultaneously before either commits the
 *      unique constraint check); skip with status='skipped'.
 *   3. Execute the job.
 *   4. UPDATE the row to status='ok' or 'error' with duration + detail.
 *   5. Release the advisory lock.
 *
 * The advisory lock + unique constraint combo is belt-and-suspenders but
 * both are cheap and they defend different races:
 *   - UNIQUE (job_id, utc_day)       → prevents double-fire on the same day
 *   - pg_try_advisory_lock(job_id)   → prevents overlap if a job is still
 *     running when the next day boundary crosses (e.g. backup started at
 *     23:59:50 UTC and still running after midnight). Without the lock,
 *     the next UTC day tick could INSERT a new claim and start a concurrent
 *     run on a resource that doesn't tolerate it (e.g. Drive upload).
 */

import { pool } from "../../storage";
import logger from "../../logger";

export type JobStatus = "running" | "ok" | "error" | "skipped";

export type JobRunContext = {
  jobId: string;
  runId: number;       // kioku_job_runs.id
  utcDay: string;      // YYYY-MM-DD
  startedAtMs: number;
};

export type JobRunResult =
  | { ran: true;  status: "ok" | "error"; runId: number; durationMs: number; error?: string }
  | { ran: false; status: "skipped";      reason: "already_claimed" | "lock_held" };

type ClientLike = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

/** YYYY-MM-DD in UTC. */
export function utcDay(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Deterministic 31-bit int key for pg_try_advisory_lock from jobId.
 * Postgres' hashtext() would also work but using a client-side hash keeps
 * lock keys stable across pg versions and lets tests predict them.
 */
export function jobLockKey(jobId: string): number {
  // FNV-1a 32-bit, clamped to positive signed int32 range.
  let h = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i++) {
    h ^= jobId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h & 0x7fffffff;
}

/**
 * Run a job with cluster-wide dedup + advisory lock guard.
 *
 * On success: returns { ran: true, status: 'ok', durationMs }.
 * On exception: returns { ran: true, status: 'error', error }.  Never throws.
 * On already-claimed: returns { ran: false, status: 'skipped', reason: 'already_claimed' }.
 * On lock-held: returns { ran: false, status: 'skipped', reason: 'lock_held' }.
 */
export async function runWithClaim(
  jobId: string,
  fn: (ctx: JobRunContext) => Promise<Record<string, unknown> | void>,
  opts: { now?: Date; poolOverride?: ClientLike } = {},
): Promise<JobRunResult> {
  const now = opts.now ?? new Date();
  const day = utcDay(now);
  const p = opts.poolOverride ?? pool;

  // (1) Claim the day.
  const insert = await p.query(
    `INSERT INTO kioku_job_runs (job_id, utc_day, status)
     VALUES ($1, $2, 'running')
     ON CONFLICT (job_id, utc_day) DO NOTHING
     RETURNING id`,
    [jobId, day],
  );
  if (!insert.rows.length) {
    logger.info({ component: "jobs", job_id: jobId, utc_day: day }, "[jobs] already claimed today, skipping");
    return { ran: false, status: "skipped", reason: "already_claimed" };
  }
  const runId = insert.rows[0].id as number;

  // (2) Advisory lock — needs a dedicated connection so the release pairs
  // with the acquire on the same session.
  const lockKey = jobLockKey(jobId);
  // storage.pool is a real pg.Pool at runtime; .connect() returns a client.
  // In tests the fake pool may or may not support .connect(), so be defensive.
  const anyPool = p as any;
  let client: any = null;
  let lockAcquired = false;
  if (typeof anyPool.connect === "function") {
    client = await anyPool.connect();
    try {
      const lockR = await client.query(`SELECT pg_try_advisory_lock($1) AS got`, [lockKey]);
      lockAcquired = !!lockR.rows[0]?.got;
    } catch (err: any) {
      // If advisory-lock SQL isn't supported (fake DB), treat as acquired and
      // rely solely on the unique-constraint claim. Real pg will always work.
      logger.warn(
        { component: "jobs", job_id: jobId, err: err?.message },
        "[jobs] advisory lock query failed, falling back to constraint-only dedup",
      );
      lockAcquired = true;
    }
  } else {
    lockAcquired = true;
  }

  if (!lockAcquired) {
    // Another replica/tick is mid-flight. Mark this claim skipped so admin
    // can see we were in flight-for-hour but never ran.
    await p.query(
      `UPDATE kioku_job_runs
         SET status = 'skipped',
             finished_at = NOW(),
             detail = detail || jsonb_build_object('skip_reason','lock_held')
       WHERE id = $1`,
      [runId],
    );
    if (client) client.release();
    return { ran: false, status: "skipped", reason: "lock_held" };
  }

  // (3) Run.
  const startedAtMs = Date.now();
  const ctx: JobRunContext = { jobId, runId, utcDay: day, startedAtMs };
  let status: "ok" | "error" = "ok";
  let errorMsg: string | undefined;
  let detail: Record<string, unknown> = {};

  try {
    const out = await fn(ctx);
    if (out && typeof out === "object") detail = out;
  } catch (err: any) {
    status = "error";
    errorMsg = String(err?.message ?? err ?? "unknown error");
    detail.error_stack = String(err?.stack ?? "").slice(0, 2000);
  } finally {
    const durationMs = Date.now() - startedAtMs;
    try {
      await p.query(
        `UPDATE kioku_job_runs
           SET status = $2,
               finished_at = NOW(),
               duration_ms = $3,
               error = $4,
               detail = detail || $5::jsonb
         WHERE id = $1`,
        [runId, status, durationMs, errorMsg ?? null, JSON.stringify(detail)],
      );
    } catch (err: any) {
      // Logging-only; the job itself already ran.
      logger.error(
        { component: "jobs", job_id: jobId, run_id: runId, err: err?.message },
        "[jobs] failed to persist job run result",
      );
    }

    if (client) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
      } catch {
        // ignore — connection release will clean up if we're the last holder
      }
      client.release();
    }

    const durationLogMs = Date.now() - startedAtMs;
    if (status === "ok") {
      logger.info(
        { component: "jobs", job_id: jobId, run_id: runId, duration_ms: durationLogMs, utc_day: day },
        `[jobs] ${jobId} ok`,
      );
    } else {
      logger.error(
        { component: "jobs", job_id: jobId, run_id: runId, duration_ms: durationLogMs, utc_day: day, err: errorMsg },
        `[jobs] ${jobId} error`,
      );
    }
  }

  return status === "ok"
    ? { ran: true, status: "ok", runId, durationMs: Date.now() - startedAtMs }
    : { ran: true, status: "error", runId, durationMs: Date.now() - startedAtMs, error: errorMsg };
}

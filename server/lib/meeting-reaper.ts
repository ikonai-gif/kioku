/**
 * Meeting Reaper — W9 Item 2 (§2d in week9_plan_v2.md).
 *
 * Background sweep (every 30s) that cleans up two kinds of stuck state:
 *
 *   1. **Stuck turns**: `turn_records.state='running'` for > 120s.
 *      Likely cause: process crash between T1 and T2, or an LLM call that
 *      didn't honour the timeout. Marks the turn row 'failed' with
 *      `error='turn_timeout'`, then aborts the owning meeting (if it's
 *      still in `turn_in_progress` with this turn pinned).
 *
 *   2. **Stale approvals**: `meetings.state='waiting_for_approval'` with
 *      `metadata.waiting_since` older than 24h (Bro2 R3). Aborts the
 *      meeting with `abort_reason='approval_timeout'`.
 *
 * Design notes (Bro2 F2 + SF3):
 *   - Two EXPLICIT steps per sweep (UPDATE turn_records → UPDATE meetings)
 *     inside a single tx so the "abort the meeting owning this stuck turn"
 *     link is atomic. The UPDATE … RETURNING trick passes turn ids between
 *     the two statements.
 *   - The reaper never reaches back to the LLM or the event bus inside the
 *     tx. Event emission happens fire-and-forget after the tx commits
 *     (best-effort; durable state in the DB is authoritative).
 *   - Gated on `MEETING_ROOM_ENABLED`. When the flag is off the reaper
 *     logs its startup intent once and returns — no polling overhead.
 *   - Single instance per process. Multiple Node workers would race on the
 *     UPDATEs; with ON CONFLICT semantics this is safe (idempotent) but
 *     wasteful, so prod should pin the reaper to one replica (we run one
 *     Railway service — this is already true).
 */
import type { Pool } from "pg";
import type { MeetingEventBus, MeetingState } from "./meeting-event-bus";
import { NoopMeetingEventBus } from "./meeting-event-bus";
import logger from "../logger";

export interface ReaperSweepStats {
  stuckTurnsAborted: number;
  staleApprovalsAborted: number;
}

export interface ReaperOptions {
  pool: Pool;
  eventBus?: MeetingEventBus;
  /** Cadence in ms. Default 30_000. Tests pass a shorter value. */
  intervalMs?: number;
  /** Turn timeout threshold. Default 120s. */
  turnTimeoutMs?: number;
  /** Approval timeout threshold. Default 24h. */
  approvalTimeoutMs?: number;
  /** Abort reason to stamp on stuck turn meetings. */
  stuckReason?: string;
  /** Abort reason to stamp on stale approvals. */
  approvalReason?: string;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/**
 * Run a single reaper sweep. Returns stats. Errors are logged and re-thrown
 * so the caller (the interval loop or a test) can observe them.
 */
export async function runReaperSweep(opts: ReaperOptions): Promise<ReaperSweepStats> {
  const eventBus = opts.eventBus ?? new NoopMeetingEventBus();
  const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const stuckReason = opts.stuckReason ?? "turn_timeout";
  const approvalReason = opts.approvalReason ?? "approval_timeout";

  const stats: ReaperSweepStats = { stuckTurnsAborted: 0, staleApprovalsAborted: 0 };

  // ── 1. Stuck turns ───────────────────────────────────────────────────────
  const stuckTurns = await sweepStuckTurns(opts.pool, turnTimeoutMs, stuckReason);
  stats.stuckTurnsAborted = stuckTurns.length;
  for (const row of stuckTurns) {
    try {
      await eventBus.emit("meeting.state.changed", {
        meetingId: row.meetingId,
        state: "aborted",
        previousState: "turn_in_progress",
        reason: stuckReason,
      });
    } catch (err) {
      logger.warn({ err, meetingId: row.meetingId }, "reaper: event emit failed (stuck turn)");
    }
  }

  // ── 2. Stale approvals ───────────────────────────────────────────────────
  const staleApprovals = await sweepStaleApprovals(opts.pool, approvalTimeoutMs, approvalReason);
  stats.staleApprovalsAborted = staleApprovals.length;
  for (const row of staleApprovals) {
    try {
      await eventBus.emit("meeting.state.changed", {
        meetingId: row.meetingId,
        state: "aborted",
        previousState: "waiting_for_approval",
        reason: approvalReason,
      });
    } catch (err) {
      logger.warn({ err, meetingId: row.meetingId }, "reaper: event emit failed (stale approval)");
    }
  }

  return stats;
}

interface AbortedRow {
  meetingId: string;
  turnId?: string;
}

/**
 * Two-step sweep inside one tx: fail stuck turn_records, then abort the
 * meetings they pin. The UPDATE … RETURNING on step 1 is used as the
 * input list for step 2, giving us an atomic link between the two.
 */
async function sweepStuckTurns(
  pool: Pool,
  timeoutMs: number,
  reason: string,
): Promise<AbortedRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const timeoutIntervalSql = `interval '${Math.floor(timeoutMs / 1000)} seconds'`;
    const { rows: stuck } = await client.query(
      `UPDATE turn_records
          SET state = 'failed',
              error = $1,
              completed_at = now()
        WHERE state = 'running'
          AND started_at < now() - ${timeoutIntervalSql}
        RETURNING id AS turn_id, meeting_id`,
      [reason],
    );

    if (stuck.length === 0) {
      await client.query("COMMIT");
      return [];
    }

    const turnIds = stuck.map((r) => r.turn_id as string);
    const { rows: aborted } = await client.query(
      `UPDATE meetings
          SET state = 'aborted',
              current_turn_id = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('abort_reason', $1::text, 'aborted_at', to_jsonb(now()))
        WHERE current_turn_id = ANY($2::uuid[])
          AND state = 'turn_in_progress'
       RETURNING id`,
      [reason, turnIds],
    );

    await client.query("COMMIT");

    // Pair back aborted meetings with the turn id that doomed them for events.
    const turnByMeeting = new Map<string, string>();
    for (const r of stuck) turnByMeeting.set(r.meeting_id as string, r.turn_id as string);
    return aborted.map((r) => ({
      meetingId: r.id as string,
      turnId: turnByMeeting.get(r.id as string),
    }));
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    logger.error({ err }, "reaper: sweepStuckTurns failed");
    throw err;
  } finally {
    client.release();
  }
}

async function sweepStaleApprovals(
  pool: Pool,
  timeoutMs: number,
  reason: string,
): Promise<AbortedRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const timeoutIntervalSql = `interval '${Math.floor(timeoutMs / 1000)} seconds'`;
    const { rows } = await client.query(
      `UPDATE meetings
          SET state = 'aborted',
              current_turn_id = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('abort_reason', $1::text, 'aborted_at', to_jsonb(now()))
        WHERE state = 'waiting_for_approval'
          AND (metadata->>'waiting_since')::timestamptz < now() - ${timeoutIntervalSql}
       RETURNING id`,
      [reason],
    );
    await client.query("COMMIT");
    return rows.map((r) => ({ meetingId: r.id as string }));
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    logger.error({ err }, "reaper: sweepStaleApprovals failed");
    throw err;
  } finally {
    client.release();
  }
}

// ── Long-running loop ────────────────────────────────────────────────────────

export interface ReaperHandle {
  stop(): void;
  /** Test helper: force a single sweep immediately. */
  sweepOnce(): Promise<ReaperSweepStats>;
}

/**
 * Start the reaper loop. Returns a handle with `stop()` to cancel the
 * interval. Gated on `process.env.MEETING_ROOM_ENABLED === 'true'`; when
 * disabled, logs once and returns a no-op handle.
 */
export function startMeetingReaper(opts: ReaperOptions): ReaperHandle {
  if (process.env.MEETING_ROOM_ENABLED !== "true") {
    logger.info("reaper: MEETING_ROOM_ENABLED=false, not starting");
    return {
      stop: () => undefined,
      sweepOnce: () => Promise.resolve({ stuckTurnsAborted: 0, staleApprovalsAborted: 0 }),
    };
  }
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  logger.info({ intervalMs: interval }, "reaper: starting meeting reaper loop");

  const tick = async () => {
    try {
      const stats = await runReaperSweep(opts);
      if (stats.stuckTurnsAborted > 0 || stats.staleApprovalsAborted > 0) {
        logger.info(stats, "reaper: sweep aborted stuck rows");
      }
    } catch (err) {
      logger.error({ err }, "reaper: sweep crashed (will retry on next tick)");
    }
  };

  const handle = setInterval(tick, interval);
  // Let Node shut down cleanly — don't hold the process open for the reaper.
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop: () => clearInterval(handle),
    sweepOnce: () => runReaperSweep(opts),
  };
}

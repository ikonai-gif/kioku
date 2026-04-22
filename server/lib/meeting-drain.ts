/**
 * Admin drain helper (W9 Item 3-4, Bro2 SF4).
 *
 * Extracted from the POST /api/admin/meetings/drain route handler so it can
 * be unit-tested without instantiating Express + master-key auth. The route
 * is a thin wrapper: check master key → call `drainMeetings`.
 *
 * `dryRun=true` returns the candidate id list without mutating state — used
 * by the rollback DoD runbook to preview blast radius before committing.
 */
import type { Pool } from "pg";
import type { MeetingEventBus } from "./meeting-event-bus";

export interface DrainResult {
  /** Candidate meeting ids; on wet run, also the ids that were updated. */
  ids: string[];
  count: number;
  dryRun: boolean;
}

export async function drainMeetings(
  pool: Pool | { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  eventBus: MeetingEventBus,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<DrainResult> {
  const limit = opts.limit ?? 10_000;
  const { rows: candidates } = await pool.query(
    `SELECT id FROM meetings
      WHERE state NOT IN ('completed', 'aborted')
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit],
  );
  const ids: string[] = candidates.map((r: any) => r.id);
  if (opts.dryRun) {
    return { ids, count: ids.length, dryRun: true };
  }
  if (ids.length === 0) {
    return { ids: [], count: 0, dryRun: false };
  }
  await pool.query(
    `UPDATE meetings SET state = 'aborted', updated_at = NOW()
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  // Fire-and-forget emissions — one per drained meeting. Errors swallowed
  // by the bus implementation; we don't re-await a batch promise because
  // slow subscribers could serialise a 10k-id drain into minutes.
  for (const mid of ids) {
    eventBus
      .emit("meeting.state.changed", {
        meetingId: mid,
        state: "aborted",
        reason: "admin_drain",
      })
      .catch(() => {});
  }
  return { ids, count: ids.length, dryRun: false };
}

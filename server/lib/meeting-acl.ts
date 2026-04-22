/**
 * Meeting Room ACL helpers (W9 Item 3-4).
 *
 * Centralises "can user access meeting?" so HTTP routes and the WS subscribe
 * handler can share one predicate. Reader access = creator OR owner of any
 * active participant agent. Writer access (for /turn) = creator OR owner of
 * the next participant.
 *
 * SECURITY: The WS bus broadcasts metadata-only events — no content. But the
 * topic name `meeting:{id}` is ACL-gated on subscribe, so unauthorised users
 * cannot observe activity timing either.
 */
import type { Pool, PoolClient } from "pg";

export interface AclDb {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/**
 * Read ACL — creator OR active-participant-owner. Returns false on missing
 * meeting. Accepts any DB executor (pool or tx client) so callers inside a
 * transaction can reuse it.
 */
export async function verifyMeetingAccess(
  db: AclDb | Pool | PoolClient,
  userId: number,
  meetingId: string,
): Promise<boolean> {
  const { rows } = await (db as AclDb).query(
    `SELECT 1
       FROM meetings m
      WHERE m.id = $1
        AND (
          m.creator_user_id = $2
          OR EXISTS (
            SELECT 1 FROM meeting_participants mp
             WHERE mp.meeting_id = m.id
               AND mp.owner_user_id = $2
               AND mp.left_at IS NULL
          )
        )
      LIMIT 1`,
    [meetingId, userId],
  );
  return rows.length > 0;
}

/**
 * Write ACL for turn endpoints — caller must own the acting participant.
 * `participantId` may be null (caller defers to meeting.next_participant_id),
 * in which case we resolve next_participant_id and check its owner.
 *
 * Returns { ok: true, participantId } on success or
 * { ok: false, reason } on failure — callers map reasons to HTTP codes.
 */
export async function verifyTurnParticipantOwnership(
  db: AclDb | Pool | PoolClient,
  userId: number,
  meetingId: string,
  participantId: string | null,
): Promise<
  | { ok: true; participantId: string; agentId: number }
  | { ok: false; reason: "meeting_not_found" | "no_next_participant" | "participant_not_owned" | "participant_inactive" }
> {
  const { rows: meetingRows } = await (db as AclDb).query(
    `SELECT id, next_participant_id FROM meetings WHERE id = $1`,
    [meetingId],
  );
  if (meetingRows.length === 0) return { ok: false, reason: "meeting_not_found" };

  const pid = participantId ?? meetingRows[0].next_participant_id;
  if (!pid) return { ok: false, reason: "no_next_participant" };

  const { rows: partRows } = await (db as AclDb).query(
    `SELECT id, owner_user_id, agent_id, left_at
       FROM meeting_participants
      WHERE id = $1 AND meeting_id = $2`,
    [pid, meetingId],
  );
  if (partRows.length === 0) return { ok: false, reason: "meeting_not_found" };
  if (partRows[0].left_at !== null) return { ok: false, reason: "participant_inactive" };
  if (partRows[0].owner_user_id !== userId) return { ok: false, reason: "participant_not_owned" };

  return { ok: true, participantId: pid, agentId: partRows[0].agent_id };
}

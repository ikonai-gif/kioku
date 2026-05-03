/**
 * Room ACL helpers — Phase 5 (R-luca-computer-ui).
 *
 * Long-pending R431 ask: extract the "verify room belongs to user" pattern
 * from server/routes.ts (5 grep-verified callsites — see PR description).
 *
 * Two helpers:
 *   1. assertRoomOwnership(roomId, userId)
 *      → returns { id, userId } on success; throws RoomNotFoundError otherwise.
 *      A user trying to access another user's room is INDISTINGUISHABLE from a
 *      room that does not exist — this is intentional (no enumeration). We
 *      DO NOT differentiate Forbidden vs NotFound for the typical case to
 *      avoid leaking room existence.
 *
 *   2. assertRoomOwnershipWithFields(roomId, userId, fields)
 *      → for callsites that need extra columns from rooms (e.g. routes.ts:634
 *      needs `agent_ids`, :723 needs `name`). Avoids a redundant SELECT.
 *
 * BRO1 R438 must:
 *   - signature returns { id, userId, ...fields } so callsites are useable.
 *   - SELECT uses LIMIT 1 (verified by tests).
 *   - throw, not Result<>; mapped to 404 by global error middleware.
 */

import { pool } from "../storage";

export class RoomNotFoundError extends Error {
  readonly code = "ROOM_NOT_FOUND";
  readonly status = 404;
  constructor(public roomId: number, public userId: number) {
    super(`room ${roomId} not found for user ${userId}`);
    this.name = "RoomNotFoundError";
  }
}

/**
 * Reserved for future paths where existence is public but ownership is not
 * (e.g. a future "shared rooms" feature). Currently unused — assertRoomOwnership
 * collapses both into 404 by design (no enumeration leak).
 */
export class RoomForbiddenError extends Error {
  readonly code = "ROOM_FORBIDDEN";
  readonly status = 403;
  constructor(public roomId: number, public userId: number) {
    super(`room ${roomId} forbidden for user ${userId}`);
    this.name = "RoomForbiddenError";
  }
}

export interface OwnedRoomMin {
  id: number;
  userId: number;
}

/**
 * Verify room belongs to user. SELECT id, user_id FROM rooms WHERE id=$1 AND
 * user_id=$2 LIMIT 1. Throws RoomNotFoundError on miss.
 *
 * BRO1 R438 NICE: explicit "LIMIT 1" verified — see room-acl.test.ts.
 */
export async function assertRoomOwnership(
  roomId: number,
  userId: number,
): Promise<OwnedRoomMin> {
  if (!Number.isFinite(roomId) || !Number.isFinite(userId)) {
    throw new RoomNotFoundError(roomId, userId);
  }
  const r = await pool.query(
    `SELECT id, user_id FROM rooms WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [roomId, userId],
  );
  if (r.rows.length === 0) throw new RoomNotFoundError(roomId, userId);
  return { id: Number(r.rows[0].id), userId: Number(r.rows[0].user_id) };
}

/**
 * Same as assertRoomOwnership but returns extra columns. Used by callsites
 * that previously SELECT'd custom column lists (routes.ts:634 needs
 * agent_ids; :723 needs name).
 *
 * Allowlist of fields prevents SQL injection — caller passes string keys, we
 * map them to known column names.
 */
const FIELD_COLUMNS: Record<string, string> = {
  agentIds: "agent_ids",
  name: "name",
  description: "description",
  status: "status",
  purpose: "purpose",
};

export async function assertRoomOwnershipWithFields<F extends keyof typeof FIELD_COLUMNS>(
  roomId: number,
  userId: number,
  fields: readonly F[],
): Promise<OwnedRoomMin & { [K in F]: any }> {
  if (!Number.isFinite(roomId) || !Number.isFinite(userId)) {
    throw new RoomNotFoundError(roomId, userId);
  }
  const cols = ["id", "user_id", ...fields.map((f) => {
    const c = FIELD_COLUMNS[f as string];
    if (!c) throw new Error(`unknown field: ${String(f)}`);
    return c;
  })];
  const r = await pool.query(
    `SELECT ${cols.join(", ")} FROM rooms WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [roomId, userId],
  );
  if (r.rows.length === 0) throw new RoomNotFoundError(roomId, userId);
  const row = r.rows[0];
  const out: any = { id: Number(row.id), userId: Number(row.user_id) };
  for (const f of fields) {
    const c = FIELD_COLUMNS[f as string]!;
    out[f] = row[c];
  }
  return out;
}

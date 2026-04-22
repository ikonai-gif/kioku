/**
 * Meeting Room API — Week 5.
 *
 * Schema in `migrations/0001_meeting_room_schema.sql`. All IDs are UUIDs
 * except `rooms.id` (INTEGER) and `agents.id` (INTEGER).
 *
 * Mounted behind `requireFlag("MEETING_ROOM_ENABLED")` in routes.ts:
 *   app.use("/api/meetings", requireFlag("MEETING_ROOM_ENABLED"));
 *   registerMeetingRoutes(app, getUser);
 *
 * No gate inside — already applied at app.use level.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { pool } from "../storage";
import logger from "../logger";
import {
  runTurn,
  TurnStateMismatchError,
  TurnBreakerOpenError,
  TurnTimeoutError,
  type LlmCaller,
} from "../lib/meeting-turn-runner";
import type { MeetingEventBus } from "../lib/meeting-event-bus";
import { NoopMeetingEventBus } from "../lib/meeting-event-bus";
import { verifyTurnParticipantOwnership } from "../lib/meeting-acl";
import { makeMeetingLlmCaller } from "../lib/meeting-llm-caller";

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const MEETING_STATES = [
  "pending",
  "active",
  "waiting_for_turn",
  "waiting_for_approval",
  "completed",
  "aborted",
] as const;

type MeetingState = (typeof MEETING_STATES)[number];

const TERMINAL_STATES: ReadonlySet<MeetingState> = new Set(["completed", "aborted"]);

// Allowed state transitions (pending → ..., active → ..., ...).
const STATE_TRANSITIONS: Record<MeetingState, readonly MeetingState[]> = {
  pending: ["active", "aborted"],
  active: ["waiting_for_turn", "waiting_for_approval", "completed", "aborted"],
  waiting_for_turn: ["active", "aborted"],
  waiting_for_approval: ["active", "completed", "aborted"],
  completed: [],
  aborted: [],
};

const participantSpec = z.object({
  agent_id: z.number().int().positive(),
  participation_mode: z.enum(["observe", "approve", "autonomous"]).default("approve"),
});

const createMeetingSchema = z.object({
  room_id: z.number().int().positive(),
  metadata: z.record(z.unknown()).optional(),
  participants: z.array(participantSpec).max(20).optional(),
});

const patchMeetingSchema = z
  .object({
    state: z.enum(MEETING_STATES).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => d.state !== undefined || d.metadata !== undefined, {
    message: "at least one of state or metadata required",
  });

const appendContextSchema = z
  .object({
    content: z.string().min(1).max(50_000),
    author_agent_id: z.number().int().positive().optional().nullable(),
    visibility: z.enum(["all", "owner", "scoped"]).default("all"),
    scope_agent_ids: z.array(z.number().int().positive()).optional(),
  })
  .refine(
    (d) => d.visibility !== "scoped" || (d.scope_agent_ids && d.scope_agent_ids.length > 0),
    { message: "scope_agent_ids required when visibility='scoped'" },
  );

const addParticipantSchema = participantSpec;

const uuidParam = z.string().uuid();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidUuid(id: string): boolean {
  return uuidParam.safeParse(id).success;
}

/**
 * Does `userId` have read access to the meeting?
 * Creator OR owner of any active participant agent. Returns false on missing.
 */
async function userCanReadMeeting(userId: number, meetingId: string): Promise<boolean> {
  const { rows } = await pool.query(
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

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Registration options (W9 Item 3-4). `eventBus` is injected so production
 * wires `WsMeetingEventBus` while tests can pass a `RecordingMeetingEventBus`.
 * `llmFactory` lets tests stub LLM without instantiating Anthropic.
 */
export interface MeetingRoutesOptions {
  eventBus?: MeetingEventBus;
  llmFactory?: (agentId: number) => Promise<LlmCaller>;
}

export function registerMeetingRoutes(
  app: Express,
  getUser: (req: any) => Promise<number | null>,
  opts: MeetingRoutesOptions = {},
) {
  const eventBus = opts.eventBus ?? new NoopMeetingEventBus();
  const llmFactory = opts.llmFactory ?? makeMeetingLlmCaller;
  // ── POST /api/meetings ─────────────────────────────────────────────────────
  app.post(
    "/api/meetings",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const parsed = createMeetingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { room_id, metadata, participants } = parsed.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Room ownership: 404 when room doesn't exist, 403 when not owned.
        const { rows: roomRows } = await client.query(
          "SELECT user_id FROM rooms WHERE id = $1",
          [room_id],
        );
        if (roomRows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "room_not_found" });
        }
        if (roomRows[0].user_id !== userId) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "room_not_owned" });
        }

        // Validate every participant agent belongs to caller (if provided).
        if (participants && participants.length > 0) {
          const ids = participants.map((p) => p.agent_id);
          const { rows: agentRows } = await client.query(
            "SELECT id FROM agents WHERE id = ANY($1::int[]) AND user_id = $2",
            [ids, userId],
          );
          if (agentRows.length !== ids.length) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "agent_not_owned" });
          }
        }

        const { rows: meetingRows } = await client.query(
          `INSERT INTO meetings (room_id, creator_user_id, state, metadata)
           VALUES ($1, $2, 'pending', $3::jsonb)
           RETURNING id, room_id, creator_user_id, state, created_at, ended_at, metadata`,
          [room_id, userId, JSON.stringify(metadata ?? {})],
        );
        const meeting = meetingRows[0];

        let participantRows: any[] = [];
        if (participants && participants.length > 0) {
          for (const p of participants) {
            const { rows } = await client.query(
              `INSERT INTO meeting_participants
                 (meeting_id, agent_id, owner_user_id, participation_mode)
               VALUES ($1, $2, $3, $4)
               RETURNING id, meeting_id, agent_id, owner_user_id, participation_mode, joined_at, left_at`,
              [meeting.id, p.agent_id, userId, p.participation_mode],
            );
            participantRows.push(rows[0]);
          }
        }

        await client.query("COMMIT");
        logger.info(
          { component: "meetings", userId, meetingId: meeting.id, action: "create", result: "ok" },
          "[meetings] created",
        );
        return res.status(201).json({ ...meeting, participants: participantRows });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // ── GET /api/meetings ──────────────────────────────────────────────────────
  app.get(
    "/api/meetings",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
      const offset = Math.max(parseInt((req.query.offset as string) ?? "0", 10) || 0, 0);

      // Caller sees meetings they created OR participate in via an owned agent.
      const { rows } = await pool.query(
        `SELECT DISTINCT m.id, m.room_id, m.creator_user_id, m.state,
                m.created_at, m.ended_at, m.metadata
           FROM meetings m
           LEFT JOIN meeting_participants mp
             ON mp.meeting_id = m.id AND mp.left_at IS NULL
          WHERE m.creator_user_id = $1
             OR mp.owner_user_id = $1
          ORDER BY m.created_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
      return res.json({ meetings: rows, limit, offset });
    }),
  );

  // ── GET /api/meetings/:id ──────────────────────────────────────────────────
  app.get(
    "/api/meetings/:id",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) {
        return res.status(400).json({ error: "invalid_id" });
      }

      if (!(await userCanReadMeeting(userId, id))) {
        // 404 to avoid existence leak.
        return res.status(404).json({ error: "meeting_not_found" });
      }

      const { rows: meetingRows } = await pool.query(
        `SELECT id, room_id, creator_user_id, state, created_at, ended_at, metadata
           FROM meetings WHERE id = $1`,
        [id],
      );
      const meeting = meetingRows[0];

      const { rows: participants } = await pool.query(
        `SELECT id, meeting_id, agent_id, owner_user_id, participation_mode, joined_at, left_at
           FROM meeting_participants
          WHERE meeting_id = $1
          ORDER BY joined_at ASC`,
        [id],
      );

      return res.json({ ...meeting, participants });
    }),
  );

  // ── PATCH /api/meetings/:id ────────────────────────────────────────────────
  // Replace semantics: the fields provided are overwritten. metadata is not merged.
  app.patch(
    "/api/meetings/:id",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      const parsed = patchMeetingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { state, metadata } = parsed.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: meetingRows } = await client.query(
          `SELECT id, creator_user_id, state FROM meetings WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const meeting = meetingRows[0];
        if (!meeting) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        if (meeting.creator_user_id !== userId) {
          await client.query("ROLLBACK");
          // 404 on write to avoid existence leak
          return res.status(404).json({ error: "meeting_not_found" });
        }

        let nextState: MeetingState | undefined = state;
        if (nextState && nextState !== meeting.state) {
          if (TERMINAL_STATES.has(meeting.state as MeetingState)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "meeting_terminal", state: meeting.state });
          }
          const allowed = STATE_TRANSITIONS[meeting.state as MeetingState] ?? [];
          if (!allowed.includes(nextState)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: "invalid_state_transition",
              from: meeting.state,
              to: nextState,
            });
          }
        } else if (nextState === meeting.state) {
          // Null-op — drop the field.
          nextState = undefined;
        }

        const endsNow = nextState && TERMINAL_STATES.has(nextState);
        const sets: string[] = [];
        const params: any[] = [];
        if (nextState) {
          params.push(nextState);
          sets.push(`state = $${params.length}`);
        }
        if (metadata !== undefined) {
          params.push(JSON.stringify(metadata));
          sets.push(`metadata = $${params.length}::jsonb`);
        }
        if (endsNow) {
          sets.push(`ended_at = COALESCE(ended_at, NOW())`);
        }

        if (sets.length === 0) {
          // No-op — return current row.
          await client.query("COMMIT");
          return res.json(meeting);
        }

        params.push(id);
        const { rows: updated } = await client.query(
          `UPDATE meetings SET ${sets.join(", ")}
             WHERE id = $${params.length}
           RETURNING id, room_id, creator_user_id, state, created_at, ended_at, metadata`,
          params,
        );
        await client.query("COMMIT");
        logger.info(
          { component: "meetings", userId, meetingId: id, action: "patch", result: "ok" },
          "[meetings] patched",
        );
        return res.json(updated[0]);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // ── DELETE /api/meetings/:id ───────────────────────────────────────────────
  // Soft delete: state='aborted' + ended_at=NOW(). Rejects terminal state.
  app.delete(
    "/api/meetings/:id",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: meetingRows } = await client.query(
          `SELECT creator_user_id, state FROM meetings WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const meeting = meetingRows[0];
        if (!meeting) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        if (meeting.creator_user_id !== userId) {
          // 404 on write to avoid existence leak.
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        if (TERMINAL_STATES.has(meeting.state as MeetingState)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "meeting_terminal", state: meeting.state });
        }

        const { rows: updated } = await client.query(
          `UPDATE meetings
              SET state = 'aborted',
                  ended_at = COALESCE(ended_at, NOW())
            WHERE id = $1
          RETURNING id, state, ended_at`,
          [id],
        );
        await client.query("COMMIT");
        logger.info(
          { component: "meetings", userId, meetingId: id, action: "delete", result: "ok" },
          "[meetings] soft-deleted",
        );
        return res.json(updated[0]);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // ── POST /api/meetings/:id/participants ────────────────────────────────────
  app.post(
    "/api/meetings/:id/participants",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      const parsed = addParticipantSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { agent_id, participation_mode } = parsed.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: meetingRows } = await client.query(
          `SELECT creator_user_id, state FROM meetings WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const meeting = meetingRows[0];
        if (!meeting) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        if (meeting.creator_user_id !== userId) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        if (TERMINAL_STATES.has(meeting.state as MeetingState)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "meeting_terminal", state: meeting.state });
        }

        const { rows: agentRows } = await client.query(
          "SELECT id FROM agents WHERE id = $1 AND user_id = $2",
          [agent_id, userId],
        );
        if (agentRows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "agent_not_owned" });
        }

        try {
          const { rows: inserted } = await client.query(
            `INSERT INTO meeting_participants
               (meeting_id, agent_id, owner_user_id, participation_mode)
             VALUES ($1, $2, $3, $4)
             RETURNING id, meeting_id, agent_id, owner_user_id, participation_mode, joined_at, left_at`,
            [id, agent_id, userId, participation_mode],
          );
          await client.query("COMMIT");
          logger.info(
            {
              component: "meetings",
              userId,
              meetingId: id,
              action: "add_participant",
              agentId: agent_id,
              result: "ok",
            },
            "[meetings] participant added",
          );
          return res.status(201).json(inserted[0]);
        } catch (err: any) {
          await client.query("ROLLBACK");
          if (err?.code === "23505") {
            // uniq_mp_active violation — active participant already exists.
            logger.warn(
              {
                component: "meetings",
                userId,
                meetingId: id,
                action: "add_participant",
                agentId: agent_id,
                result: "error",
                errorCode: "participant_exists",
              },
              "[meetings] participant already active",
            );
            return res.status(409).json({ error: "participant_exists" });
          }
          throw err;
        }
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // ── POST /api/meetings/:id/context ────────────────────────────────────────
  // N1 fix: lock the meetings row (always exists) before MAX+1 on meeting_context
  // (FOR UPDATE on empty result set is a no-op under READ COMMITTED).
  app.post(
    "/api/meetings/:id/context",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      const parsed = appendContextSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { content, author_agent_id, visibility, scope_agent_ids } = parsed.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Lock meeting row (serialization point) + authz + state check.
        const { rows: meetingRows } = await client.query(
          `SELECT creator_user_id, state FROM meetings WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const meeting = meetingRows[0];
        if (!meeting) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        // Writer must be creator OR an active-participant-owner.
        const isCreator = meeting.creator_user_id === userId;
        let isParticipantOwner = false;
        if (!isCreator) {
          const { rows } = await client.query(
            `SELECT 1 FROM meeting_participants
              WHERE meeting_id = $1 AND owner_user_id = $2 AND left_at IS NULL
              LIMIT 1`,
            [id, userId],
          );
          isParticipantOwner = rows.length > 0;
        }
        if (!isCreator && !isParticipantOwner) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }
        if (TERMINAL_STATES.has(meeting.state as MeetingState)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "meeting_terminal", state: meeting.state });
        }

        // If author_agent_id provided, it must be owned by the caller.
        if (author_agent_id != null) {
          const { rows: agentRows } = await client.query(
            "SELECT id FROM agents WHERE id = $1 AND user_id = $2",
            [author_agent_id, userId],
          );
          if (agentRows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "agent_not_owned" });
          }
        }

        // 2. Next sequence number. Safe because the meeting row is locked.
        const { rows: seqRows } = await client.query(
          `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
             FROM meeting_context WHERE meeting_id = $1`,
          [id],
        );
        const nextSeq = seqRows[0].next_seq;

        const { rows: inserted } = await client.query(
          `INSERT INTO meeting_context
             (meeting_id, sequence_number, content, author_agent_id, visibility, scope_agent_ids)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id, meeting_id, sequence_number, content, author_agent_id,
                     visibility, scope_agent_ids, created_at`,
          [
            id,
            nextSeq,
            content,
            author_agent_id ?? null,
            visibility,
            JSON.stringify(scope_agent_ids ?? []),
          ],
        );
        await client.query("COMMIT");
        logger.info(
          {
            component: "meetings",
            userId,
            meetingId: id,
            action: "append_context",
            sequenceNumber: nextSeq,
            result: "ok",
          },
          "[meetings] context appended",
        );
        return res.status(201).json(inserted[0]);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // ── GET /api/meetings/:id/context ──────────────────────────────────────────
  app.get(
    "/api/meetings/:id/context",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      if (!(await userCanReadMeeting(userId, id))) {
        return res.status(404).json({ error: "meeting_not_found" });
      }

      const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 500);
      const afterSeq = Math.max(parseInt((req.query.after_seq as string) ?? "0", 10) || 0, 0);

      // Is caller the creator? (Needed for visibility filter.)
      const { rows: creatorRows } = await pool.query(
        "SELECT creator_user_id FROM meetings WHERE id = $1",
        [id],
      );
      const isCreator = creatorRows[0]?.creator_user_id === userId;

      // Caller's agent IDs that are participants in this meeting — for scoped visibility.
      const { rows: ownedAgents } = await pool.query(
        `SELECT DISTINCT mp.agent_id
           FROM meeting_participants mp
          WHERE mp.meeting_id = $1 AND mp.owner_user_id = $2 AND mp.left_at IS NULL`,
        [id, userId],
      );
      const ownedAgentIds: number[] = ownedAgents.map((r: any) => r.agent_id);

      // Visibility filter:
      //  - 'all' → always visible
      //  - 'owner' → visible only to creator
      //  - 'scoped' → visible to creator OR caller owns an agent in scope_agent_ids
      //    (JSONB containment: scope_agent_ids @> '[agent_id]'::jsonb)
      const params: any[] = [id];
      const clauses: string[] = ["meeting_id = $1"];
      if (afterSeq > 0) {
        params.push(afterSeq);
        clauses.push(`sequence_number > $${params.length}`);
      }

      // Build visibility clause
      const visClauses: string[] = ["visibility = 'all'"];
      if (isCreator) {
        visClauses.push("visibility = 'owner'");
        visClauses.push("visibility = 'scoped'");
      } else if (ownedAgentIds.length > 0) {
        // scoped: at least one of caller's agents appears in scope_agent_ids.
        params.push(JSON.stringify(ownedAgentIds));
        visClauses.push(
          `(visibility = 'scoped' AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(scope_agent_ids) AS e
               WHERE (e::int) = ANY(SELECT (x)::int FROM jsonb_array_elements_text($${params.length}::jsonb) AS x)
            ))`,
        );
      }
      clauses.push(`(${visClauses.join(" OR ")})`);

      params.push(limit);
      const sql = `
        SELECT id, meeting_id, sequence_number, content, author_agent_id,
               visibility, scope_agent_ids, created_at
          FROM meeting_context
         WHERE ${clauses.join(" AND ")}
         ORDER BY sequence_number ASC
         LIMIT $${params.length}`;
      const { rows } = await pool.query(sql, params);
      return res.json({ context: rows, limit });
    }),
  );

  // ── POST /api/meetings/:id/turn ────────────────────────────────────────────
  // Advance the meeting by one turn. Caller owns the acting participant
  // (either explicit `participant_id` in body, or meeting.next_participant_id).
  // Headers: `X-Idempotency-Key` optional — forwarded to the runner so client
  // retries collapse to one LLM call.
  app.post(
    "/api/meetings/:id/turn",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      const body = z
        .object({ participant_id: z.string().uuid().optional() })
        .safeParse(req.body ?? {});
      if (!body.success) {
        return res.status(400).json({ error: "invalid_request", issues: body.error.issues });
      }

      // ACL: resolve participant, verify ownership.
      const acl = await verifyTurnParticipantOwnership(
        pool,
        userId,
        id,
        body.data.participant_id ?? null,
      );
      if (!acl.ok) {
        const map: Record<typeof acl.reason, number> = {
          meeting_not_found: 404,
          no_next_participant: 409,
          participant_not_owned: 403,
          participant_inactive: 409,
        };
        return res.status(map[acl.reason]).json({ error: acl.reason });
      }

      const idemHeader = req.header("x-idempotency-key");
      const idempotencyKey = idemHeader && idemHeader.length > 0 ? idemHeader : undefined;

      // LLM caller resolved per-call so each turn picks up the current agent
      // credentials (rotation, degraded-agent disable, etc.).
      let llm: LlmCaller;
      try {
        llm = await llmFactory(acl.agentId);
      } catch (err: any) {
        if (err?.message === "no_llm_provider") {
          return res.status(503).json({ error: "no_llm_provider" });
        }
        throw err;
      }

      try {
        const result = await runTurn(pool, {
          meetingId: id,
          participantId: acl.participantId,
          idempotencyKey,
          llm,
          eventBus,
        });
        return res.status(200).json(result);
      } catch (err: any) {
        if (err instanceof TurnStateMismatchError) {
          return res.status(409).json({ error: err.code });
        }
        if (err instanceof TurnBreakerOpenError) {
          return res.status(503).json({ error: "llm_breaker_open" });
        }
        if (err instanceof TurnTimeoutError) {
          return res.status(504).json({ error: "llm_timeout" });
        }
        throw err;
      }
    }),
  );

  // ── POST /api/meetings/:id/turn/approve ────────────────────────────────────
  // Human-in-the-loop approval step for scoped / approval-gated content.
  // Caller must be the creator OR own an approve-mode participant in the
  // meeting. Transitions waiting_for_approval → active and flips the stored
  // context row's approval metadata.
  const approveSchema = z.object({
    context_entry_id: z.string().uuid(),
    approved: z.boolean(),
  });

  app.post(
    "/api/meetings/:id/turn/approve",
    asyncHandler(async (req, res) => {
      const userId = await getUser(req);
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const id = String(req.params.id ?? "");
      if (!isValidUuid(id)) return res.status(400).json({ error: "invalid_id" });

      const parsed = approveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      }
      const { context_entry_id, approved } = parsed.data;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: meetingRows } = await client.query(
          `SELECT creator_user_id, state FROM meetings WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const meeting = meetingRows[0];
        if (!meeting) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "meeting_not_found" });
        }

        // Approver must be creator OR own an approve-mode participant.
        const isCreator = meeting.creator_user_id === userId;
        let canApprove = isCreator;
        if (!canApprove) {
          const { rows } = await client.query(
            `SELECT 1 FROM meeting_participants
              WHERE meeting_id = $1 AND owner_user_id = $2
                AND participation_mode = 'approve' AND left_at IS NULL
              LIMIT 1`,
            [id, userId],
          );
          canApprove = rows.length > 0;
        }
        if (!canApprove) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "not_authorized" });
        }

        if (meeting.state !== "waiting_for_approval") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "not_awaiting_approval", state: meeting.state });
        }

        // Verify the context entry belongs to this meeting.
        const { rows: ctxRows } = await client.query(
          `SELECT id FROM meeting_context WHERE id = $1 AND meeting_id = $2`,
          [context_entry_id, id],
        );
        if (ctxRows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "context_entry_not_found" });
        }

        const newState = approved ? "active" : "aborted";
        await client.query(`UPDATE meetings SET state = $1, updated_at = NOW() WHERE id = $2`, [
          newState,
          id,
        ]);
        await client.query("COMMIT");

        // Emit state change OUTSIDE the transaction — fire and forget.
        eventBus
          .emit("meeting.state.changed", {
            meetingId: id,
            state: newState,
            previousState: "waiting_for_approval",
            reason: approved ? "approved" : "rejected",
          })
          .catch(() => {});

        logger.info(
          { component: "meetings", userId, meetingId: id, action: "approve", approved, result: "ok" },
          "[meetings] turn approval",
        );
        return res.status(200).json({ meeting_id: id, state: newState, approved });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }),
  );
}

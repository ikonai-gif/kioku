/**
 * meeting-artifact — W9 Item 5 core.
 *
 * Two responsibilities, single module so the invariant "meeting context
 * NEVER becomes personal memory by default" stays readable end-to-end:
 *
 *   1. `upsertArtifact` — version-bumped artifact write for a meeting.
 *      Called by POST /api/meetings/:id/artifact (creator-only).
 *
 *   2. `endMeetingAndMaybeCommitMemory` — transitions the meeting to
 *      `completed`, then for each participant whose profile has
 *      `carry_over_memory=true` inserts EXACTLY ONE memory row under the
 *      reserved namespace `_meeting_summary_{meetingId}`. Participants
 *      with `carry_over_memory=false` receive ZERO writes.
 *
 * Invariants enforced here (not convention):
 *   - Namespace prefix is `_meeting_summary_` with a leading underscore so
 *     the consolidation-skip LIKE pattern is unambiguous.
 *   - Summary is generated via the provided `summarizer` (default calls
 *     Anthropic through the existing meeting LLM client wrapper) — single
 *     LLM call, no tools, no retries. If summary fails, the memory row is
 *     still written with a safe fallback ("[meeting summary unavailable]")
 *     so participants with opt-in get a deterministic artifact.
 *   - Writes use `storage.createMemory` so embedding generation + the rest
 *     of the memory pipeline runs (search still works on meeting summaries
 *     for the opt-in user).
 *   - End is idempotent: re-calling on an already-`completed` meeting
 *     returns 409 at the route layer (see routes/meetings.ts POST /end).
 *
 * Explicitly NOT here:
 *   - Artifact diff / version history UI (out-of-scope v2).
 *   - Cross-owner memory writes (Track B / W11+).
 *   - Any tool that the in-turn LLM can call — by design, only this
 *     server-side path can write meeting-originated memories.
 */

import type { PoolClient } from "pg";
import { pool, storage } from "../storage";
import logger from "../logger";

/** Reserved namespace prefix for meeting-originated memories. */
export const MEETING_SUMMARY_NAMESPACE_PREFIX = "_meeting_summary_";

export function meetingSummaryNamespace(meetingId: string): string {
  return `${MEETING_SUMMARY_NAMESPACE_PREFIX}${meetingId}`;
}

/**
 * Narrow type for the summarizer injection. Given the plain-text transcript
 * and meeting id, returns a one-line summary. Tests pass a deterministic
 * stub; production wires Anthropic.
 */
export type MeetingSummarizer = (args: {
  meetingId: string;
  transcript: string;
}) => Promise<string>;

/** Safe fallback when the summarizer throws or times out. */
const SUMMARY_FALLBACK = "[meeting summary unavailable]";

// ─── Artifact upsert ─────────────────────────────────────────────────────────

export interface ArtifactUpsertInput {
  meetingId: string;
  type: string;
  content: unknown;
  createdByAgentId?: number | null;
}

export interface ArtifactUpsertResult {
  id: string;
  meetingId: string;
  type: string;
  version: number;
  content: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Insert a new artifact row or bump its version if one already exists for
 * (meeting_id, type). Monotonic per-type versioning: v1 → v2 → v3, one row
 * per version. Returns the newly-created row.
 *
 * Acquires a short row-lock on the meeting row first to avoid two creators
 * racing on the same (meeting_id, type) pair. Callers must ensure the
 * meeting is NOT in a terminal state (checked at route layer).
 */
export async function upsertArtifact(
  client: PoolClient,
  input: ArtifactUpsertInput,
): Promise<ArtifactUpsertResult> {
  // Lock the parent meeting row so concurrent POST /artifact from the same
  // creator do not insert the same version twice.
  await client.query(`SELECT 1 FROM meetings WHERE id = $1 FOR UPDATE`, [input.meetingId]);

  const { rows: maxRows } = await client.query(
    `SELECT COALESCE(MAX(version), 0) AS max_version
       FROM meeting_artifacts
      WHERE meeting_id = $1 AND type = $2`,
    [input.meetingId, input.type],
  );
  const nextVersion = Number(maxRows[0]?.max_version ?? 0) + 1;

  const { rows } = await client.query(
    `INSERT INTO meeting_artifacts
        (meeting_id, type, content, version, created_by_agent_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING id, meeting_id, type, version, content, created_at, updated_at`,
    [
      input.meetingId,
      input.type,
      JSON.stringify(input.content ?? {}),
      nextVersion,
      input.createdByAgentId ?? null,
    ],
  );

  const row = rows[0];
  return {
    id: String(row.id),
    meetingId: String(row.meeting_id),
    type: String(row.type),
    version: Number(row.version),
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── End meeting + memory commit ─────────────────────────────────────────────

export interface EndMeetingInput {
  meetingId: string;
  summarizer: MeetingSummarizer;
}

export interface EndMeetingResult {
  meetingId: string;
  previousState: string;
  state: "completed";
  memoriesWritten: number;
  participantsOptedIn: number;
}

export class MeetingAlreadyTerminalError extends Error {
  state: string;
  constructor(state: string) {
    super(`meeting already terminal: ${state}`);
    this.state = state;
  }
}

/**
 * Transition `active|waiting_for_turn|waiting_for_approval` → `completed`
 * and, for each participant with `carry_over_memory=true`, insert exactly
 * one memory row into the `_meeting_summary_{meetingId}` namespace.
 *
 * Two-phase:
 *   Phase 1 (transactional): lock meeting, verify state, flip to completed,
 *                            load participants + context transcript.
 *   Phase 2 (outside tx):    run summarizer once, then iterate opt-in
 *                            participants and call storage.createMemory.
 *
 * Summarizer failure is caught per-call — a fallback memory is still written
 * so the opt-in path remains deterministic for tests and admins.
 */
export async function endMeetingAndMaybeCommitMemory(
  input: EndMeetingInput,
): Promise<EndMeetingResult> {
  const { meetingId, summarizer } = input;
  const client = await pool.connect();

  let previousState: string;
  let participants: Array<{
    id: string;
    agentId: number;
    ownerUserId: number;
    carryOverMemory: boolean;
  }>;
  let transcript: string;

  try {
    await client.query("BEGIN");

    const { rows: mRows } = await client.query(
      `SELECT id, state FROM meetings WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    if (mRows.length === 0) {
      await client.query("ROLLBACK");
      throw new Error("meeting_not_found");
    }
    previousState = String(mRows[0].state);
    if (previousState === "completed" || previousState === "aborted") {
      await client.query("ROLLBACK");
      throw new MeetingAlreadyTerminalError(previousState);
    }

    const { rows: pRows } = await client.query(
      `SELECT id, agent_id, owner_user_id, carry_over_memory
         FROM meeting_participants
        WHERE meeting_id = $1 AND left_at IS NULL`,
      [meetingId],
    );
    participants = pRows.map((r: any) => ({
      id: String(r.id),
      agentId: Number(r.agent_id),
      ownerUserId: Number(r.owner_user_id),
      carryOverMemory: Boolean(r.carry_over_memory),
    }));

    const { rows: cRows } = await client.query(
      `SELECT sequence_number, author_agent_id, content
         FROM meeting_context
        WHERE meeting_id = $1
        ORDER BY sequence_number ASC
        LIMIT 500`,
      [meetingId],
    );
    transcript = cRows
      .map((r: any) => `[agent ${r.author_agent_id ?? "system"} / seq ${r.sequence_number}] ${r.content}`)
      .join("\n");

    await client.query(
      `UPDATE meetings SET state = 'completed', updated_at = NOW() WHERE id = $1`,
      [meetingId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // Phase 2 — summarize + memory commits for opt-in participants.
  const optIn = participants.filter((p) => p.carryOverMemory);
  let summary = SUMMARY_FALLBACK;
  if (optIn.length > 0) {
    try {
      summary = (await summarizer({ meetingId, transcript })).trim() || SUMMARY_FALLBACK;
    } catch (err) {
      logger.warn(
        { component: "meeting-artifact", meetingId, err: String(err) },
        "[meeting-artifact] summarizer failed, using fallback",
      );
      summary = SUMMARY_FALLBACK;
    }
  }

  let written = 0;
  const namespace = meetingSummaryNamespace(meetingId);
  for (const p of optIn) {
    try {
      await storage.createMemory({
        userId: p.ownerUserId,
        agentId: p.agentId,
        agentName: null,
        content: summary,
        type: "episodic",
        namespace,
        importance: 0.4,
        confidence: 1.0,
        decayRate: 0.01,
      } as any);
      written += 1;
    } catch (err) {
      logger.error(
        { component: "meeting-artifact", meetingId, participantId: p.id, err: String(err) },
        "[meeting-artifact] memory commit failed for opt-in participant",
      );
    }
  }

  logger.info(
    {
      component: "meeting-artifact",
      meetingId,
      previousState,
      participantsOptedIn: optIn.length,
      memoriesWritten: written,
    },
    "[meeting-artifact] meeting ended",
  );

  return {
    meetingId,
    previousState,
    state: "completed",
    memoriesWritten: written,
    participantsOptedIn: optIn.length,
  };
}

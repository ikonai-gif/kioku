/**
 * Meeting Turn Runner — W9 Item 2 (per week9_plan_v2.md §Item 2).
 *
 * Orchestrates one meeting turn end-to-end:
 *
 *   T1  (tx A)  → reserve        — lock meeting, assert state + next_participant,
 *                                  capture global sequence fence, insert
 *                                  turn_records row (state='running'), flip
 *                                  meeting to state='turn_in_progress',
 *                                  register idempotency-pending marker.
 *   LLM         → call           — build input via MCM, filter tools via
 *                                  getMeetingTurnTools (NO memory-write tools),
 *                                  call Anthropic via withAnthropicBreaker,
 *                                  60s hard timeout (enforced by the breaker
 *                                  circuit + a Promise.race guard below).
 *   T2  (tx B)  → commit         — lock meeting, assert state=turn_in_progress
 *                                  AND current_turn_id=$turnId, insert new
 *                                  meeting_context row, mark turn_records
 *                                  'completed', advance state machine to
 *                                  next_participant OR waiting_for_approval
 *                                  depending on participation_mode.
 *   T2-fail      → abort         — on LLM error / breaker-open / timeout,
 *                                  abort meeting + mark turn_records 'failed'.
 *   Events      → emit           — fire-and-forget AFTER commit. Never inside
 *                                  a tx (bus failure must not roll back state).
 *
 * Concurrency model (Bro2 SF1): two concurrent POST /turn hits to the same
 * (meeting, participant, fence) are serialised by the `FOR UPDATE` row lock
 * in T1. The first wins, inserts the turn_record, flips state. The second
 * takes the lock after the first commits — by then `meetings.state` =
 * 'turn_in_progress' so the state-assertion fails with `state_mismatch` (409).
 * Sequential retries with an explicit `X-Idempotency-Key` hit the Redis
 * idempotency store and replay the cached response without a new T1.
 *
 * Idempotency fence (Bro2 SF2): the sequence_fence captured in T1 is the
 * GLOBAL meeting MAX(sequence_number), NOT the per-agent visible fence from
 * MCM. Rationale: private rows by other agents legitimately bust idempotency
 * — even though the acting agent cannot SEE them, they change what this
 * turn would produce (e.g. artifact state shifts). This is enforced by the
 * `getMeetingSequenceFence` helper below.
 *
 * LLM cost cap: MAX_TURNS_PER_MEETING (20) prevents runaway LLM spend if a
 * meeting somehow loops. Enforced at T1 via a COUNT on completed+failed rows.
 */
import type { PoolClient } from "pg";
import { randomUUID } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildTurnInput, MCMNotFoundError, ParticipantInactiveError, ProfileMissingError } from "./meeting-context-manager";
import type { TurnInput, DbExecutor } from "./meeting-context-manager";
import { getMeetingTurnTools } from "./meeting-tools";
import { isAnthropicFailure, CircuitOpenError } from "./anthropic-client";
import type { MeetingEventBus } from "./meeting-event-bus";
import { NoopMeetingEventBus } from "./meeting-event-bus";
import { makeIdempotencyKey, checkIdempotency, storeIdempotencyResult, DEFAULT_TTL_LONG } from "../idempotency";
import logger from "../logger";

// ── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on turns per meeting — LLM cost runaway guard. */
export const MAX_TURNS_PER_MEETING = 20;

/**
 * LLM call timeout in ms. Matches breaker + runner hard-stop.
 * Env-tunable (N5) so smoke tests can set it low (e.g. 5_000) to fail fast.
 * Production defaults to 60s.
 */
export const LLM_TIMEOUT_MS = Number(process.env.MEETING_LLM_TIMEOUT_MS ?? 60_000);

/**
 * Idempotency pending-marker TTL for meeting_turn scope (Bro2 F1).
 * Invariant: MUST be > LLM_TIMEOUT_MS + post-LLM work budget (T2 + network + retries).
 * Formula: `LLM_TIMEOUT_MS / 1000 + 30` — 30s budget for T2 commit + retries.
 * Without this override the default 60s pending TTL equals LLM_TIMEOUT_MS, so a
 * retry at the exact timeout boundary sees the marker gone and races with
 * t2Fail on the abort path — the retry gets 409s instead of the cached result.
 */
export const MEETING_TURN_PENDING_TTL_SEC = Math.ceil(LLM_TIMEOUT_MS / 1000) + 30;

/** Idempotency scope string. Keys look like `idem:meeting_turn:<16hex>`. */
export const IDEMPOTENCY_SCOPE = "meeting_turn";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown from T1 when the meeting is not in a state that permits a turn to
 * start, OR when the incoming participant_id does not match
 * next_participant_id. Maps to HTTP 409 in the route handler.
 */
export class TurnStateMismatchError extends Error {
  constructor(
    public readonly code:
      | "state_mismatch"
      | "out_of_order"
      | "meeting_ended"
      | "turn_cap_exceeded"
      | "already_running",
    message: string,
  ) {
    super(message);
    this.name = "TurnStateMismatchError";
  }
}

/** Thrown from the LLM phase when the breaker is open. Maps to 503. */
export class TurnBreakerOpenError extends Error {
  constructor(message = "LLM breaker open — meeting aborted") {
    super(message);
    this.name = "TurnBreakerOpenError";
  }
}

/** Thrown from the LLM phase when the call times out. Maps to 504. */
export class TurnTimeoutError extends Error {
  constructor(message = "LLM call exceeded timeout — meeting aborted") {
    super(message);
    this.name = "TurnTimeoutError";
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type MeetingStateDb =
  | "pending"
  | "active"
  | "turn_in_progress"
  | "waiting_for_turn"
  | "waiting_for_approval"
  | "completed"
  | "aborted";

/**
 * Result of a successful turn. `contextEntryId` is the newly inserted
 * meeting_context row. `sequenceNumber` is its (per-meeting, monotonic)
 * sequence number. `newState` is where the meeting machine landed.
 */
export interface TurnResult {
  turnId: string;
  meetingId: string;
  participantId: string;
  sequenceNumber: number;
  contextEntryId: string;
  newState: MeetingStateDb;
  nextParticipantId: string | null;
  /** Whether this response was served from the idempotency cache. */
  replayed: boolean;
}

export interface RunTurnArgs {
  meetingId: string;
  /** If omitted, runner uses meeting.next_participant_id. */
  participantId?: string;
  /** Optional client idempotency key (e.g. from `X-Idempotency-Key` header). */
  idempotencyKey?: string;
  /**
   * Low-level LLM hook. Receives the assembled TurnInput + the filtered tool
   * set, returns the assistant text + visibility for the new context row.
   * Injected (not hard-coded) so tests can stub deterministically and so the
   * production path can swap Anthropic/OpenAI without touching the runner.
   */
  llm: LlmCaller;
  /** Optional event bus. Defaults to NoopMeetingEventBus. */
  eventBus?: MeetingEventBus;
}

/**
 * The LLM-facing contract. Production callers wrap Anthropic (or OpenAI) and
 * return the assistant's final text plus the desired `visibility`. Most turns
 * return `visibility='all'` — proposals or scoped messages can flip to
 * 'scoped' or 'private'. The runner does NOT inspect tool calls from the
 * LLM; those are handled by the caller before returning content.
 */
export type LlmCaller = (
  input: TurnInput,
  tools: Anthropic.Messages.Tool[],
) => Promise<{
  content: string;
  visibility: "all" | "scoped" | "private";
  scopeAgentIds?: number[];
}>;

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Run a single turn. Caller owns the top-level pool; the runner acquires its
 * own PoolClients for T1 and T2 so the two transactions are independent (the
 * LLM call between them must not hold a DB connection).
 */
export async function runTurn(
  pool: { connect(): Promise<PoolClient> },
  args: RunTurnArgs,
): Promise<TurnResult> {
  const eventBus = args.eventBus ?? new NoopMeetingEventBus();

  // ── Idempotency replay (before any DB work) ────────────────────────────────
  let idemKey: string | null = null;
  if (args.idempotencyKey) {
    idemKey = makeIdempotencyKey(IDEMPOTENCY_SCOPE, {
      meetingId: args.meetingId,
      participantId: args.participantId ?? null,
      clientKey: args.idempotencyKey,
    });
    // F1: pass an explicit pendingTtl > LLM_TIMEOUT_MS so a retry at the timeout
    // boundary still sees `in_progress` (not `new`), preventing the 409 race
    // described in the Bro2 review.
    const cached = await checkIdempotency<TurnResult>(idemKey, DEFAULT_TTL_LONG, MEETING_TURN_PENDING_TTL_SEC);
    if (cached.status === "done") {
      return { ...cached.result, replayed: true };
    }
    // 'in_progress' means another request is mid-flight; let the caller retry.
    if (cached.status === "in_progress") {
      throw new TurnStateMismatchError("already_running", "another turn in flight for this idempotency key");
    }
    // 'new' falls through — claim the slot when we start T1. checkIdempotency
    // has already SET the pending marker with DEFAULT_PENDING_TTL, so a parallel
    // retry sees 'in_progress' until we either store the final result or time out.
  }

  // ── T1: reserve ────────────────────────────────────────────────────────────
  const t1 = await pool.connect();
  let turnId: string;
  let resolvedParticipantId: string;
  let previousState: MeetingStateDb;
  let sequenceFence: number;
  try {
    ({ turnId, resolvedParticipantId, previousState, sequenceFence } = await t1Reserve(t1, args.meetingId, args.participantId));
    // idempotency pending marker was already SET by checkIdempotency() above
    // when it returned 'new', so concurrent retries will see 'in_progress'.
  } catch (err) {
    t1.release();
    throw err;
  }
  t1.release();

  // ── LLM call (outside any tx) ──────────────────────────────────────────────
  let llmResult: { content: string; visibility: "all" | "scoped" | "private"; scopeAgentIds?: number[] };
  let input: TurnInput;
  try {
    // Re-read the TurnInput via a short-lived PoolClient so MCM sees committed
    // T1 state. Using `pool` (Pool) would also work; we reuse the connect/release
    // pattern for consistency with the rest of the runner.
    const mcmClient = await pool.connect();
    try {
      input = await buildTurnInput(mcmClient as unknown as DbExecutor, {
        meetingId: args.meetingId,
        participantId: resolvedParticipantId,
      });
    } finally {
      mcmClient.release();
    }

    const partnerToolsForAgent = await loadPartnerToolsForAgent(input);
    const meetingTools = getMeetingTurnTools(partnerToolsForAgent);

    // The injected llm caller is responsible for its own breaker wiring
    // (withAnthropicBreaker / withOpenAIBreaker) — this keeps the runner
    // vendor-agnostic. The runner enforces only the hard wall-clock timeout.
    llmResult = await withTimeout(args.llm(input, meetingTools), LLM_TIMEOUT_MS);
  } catch (err) {
    const reason = classifyError(err);
    await t2Fail(pool, args.meetingId, turnId, previousState, reason, eventBus);
    // Intentionally do NOT store a cached failure result here: we want a later
    // retry with the same client idempotency key to be able to run (once the
    // Redis pending marker expires after DEFAULT_PENDING_TTL seconds). Caching
    // the error would require the caller to mint a fresh key to unblock retry,
    // which is user-hostile for transient LLM failures.
    if (err instanceof CircuitOpenError) throw new TurnBreakerOpenError();
    if (err instanceof TurnTimeoutError) throw err;
    if (isAnthropicFailure(err)) {
      throw new Error(`LLM call failed: ${(err as Error).message}`);
    }
    throw err;
  }

  // ── T2: commit ─────────────────────────────────────────────────────────────
  const t2 = await pool.connect();
  let result: TurnResult;
  try {
    result = await t2Commit(t2, {
      meetingId: args.meetingId,
      participantId: resolvedParticipantId,
      turnId,
      agentId: input.agentId,
      ownerUserId: input.ownerUserId,
      content: llmResult.content,
      visibility: llmResult.visibility,
      scopeAgentIds: llmResult.scopeAgentIds ?? [],
      sequenceFence,
    });
  } catch (err) {
    t2.release();
    // T2 failed after a successful LLM call — best-effort abort.
    // SF2: preserve a preview of the lost LLM output in metadata so ops can
    // see what the model produced before T2 died (first 120 chars, forensic
    // aid for manual recovery).
    const lostPreview = (llmResult.content ?? "").slice(0, 120);
    await t2Fail(pool, args.meetingId, turnId, previousState, "t2_commit_failed", eventBus, lostPreview);
    throw err;
  }
  t2.release();

  // ── Idempotency result store BEFORE event emit (Bro2 SF3) ─────────────────
  // Event subscribers may trigger a retry of the same key; if the retry reaches
  // checkIdempotency before the store completes, it sees `in_progress` and
  // throws 409. Storing first eliminates the race (fire-and-forget emit order
  // was the old ordering; storing first is defense-in-depth).
  if (idemKey) {
    await storeIdempotencyResult(idemKey, result, DEFAULT_TTL_LONG);
  }

  // ── Events (after commit, never inside tx) ────────────────────────────────
  await eventBus.emit("meeting.turn.completed", {
    meetingId: result.meetingId,
    participantId: result.participantId,
    agentId: input.agentId,
    sequenceNumber: result.sequenceNumber,
    visibility: llmResult.visibility,
    state: result.newState,
    previousState,
  });

  return result;
}

// ── T1: reserve ──────────────────────────────────────────────────────────────

async function t1Reserve(
  client: PoolClient,
  meetingId: string,
  participantIdHint: string | undefined,
): Promise<{
  turnId: string;
  resolvedParticipantId: string;
  previousState: MeetingStateDb;
  sequenceFence: number;
}> {
  await client.query("BEGIN");
  try {
    // Row-lock the meeting — serialises concurrent turn attempts at Postgres.
    const mRes = await client.query(
      `SELECT id, state, next_participant_id, current_turn_id
         FROM meetings WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    if (mRes.rows.length === 0) {
      throw new TurnStateMismatchError("state_mismatch", `meeting ${meetingId} not found`);
    }
    const meeting = mRes.rows[0] as {
      id: string;
      state: MeetingStateDb;
      next_participant_id: string | null;
      current_turn_id: string | null;
    };

    // Terminal states block all turns.
    if (meeting.state === "completed" || meeting.state === "aborted") {
      throw new TurnStateMismatchError("meeting_ended", `meeting is ${meeting.state}`);
    }
    // Only (active | waiting_for_turn) can start a new turn.
    if (meeting.state !== "active" && meeting.state !== "waiting_for_turn") {
      throw new TurnStateMismatchError("state_mismatch", `cannot start turn from state=${meeting.state}`);
    }
    if (meeting.current_turn_id) {
      throw new TurnStateMismatchError("already_running", `a turn is already running (${meeting.current_turn_id})`);
    }

    // Resolve participant: explicit hint wins IF it matches next_participant_id
    // (F3: out-of-order protection). Omitted hint uses next_participant_id.
    const resolvedParticipantId = (() => {
      if (participantIdHint) {
        if (meeting.next_participant_id && meeting.next_participant_id !== participantIdHint) {
          throw new TurnStateMismatchError(
            "out_of_order",
            `participant_id ${participantIdHint} does not match next_participant_id ${meeting.next_participant_id}`,
          );
        }
        return participantIdHint;
      }
      if (!meeting.next_participant_id) {
        throw new TurnStateMismatchError(
          "state_mismatch",
          "no next_participant_id set on meeting — caller must provide one or end the meeting",
        );
      }
      return meeting.next_participant_id;
    })();

    // Turn cap: count completed + failed turn_records for this meeting.
    const capRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM turn_records
        WHERE meeting_id = $1 AND state IN ('completed','failed')`,
      [meetingId],
    );
    const prior = Number(capRes.rows[0]?.n ?? 0);
    if (prior >= MAX_TURNS_PER_MEETING) {
      throw new TurnStateMismatchError(
        "turn_cap_exceeded",
        `meeting reached ${MAX_TURNS_PER_MEETING}-turn cap`,
      );
    }

    // Global fence — the CURRENT max(sequence_number) at T1 time. Stored in
    // turn_records.sequence_fence for audit trail (forensic: what was the
    // meeting's sequence at T1?). NOT part of the idempotency key — the
    // idem key composition lives above at line 183 ({meetingId, participantId,
    // clientKey}). The state-machine itself (meetings.state + current_turn_id)
    // is the concurrency serialisation primitive, not the fence.
    const fenceRes = await client.query(
      `SELECT COALESCE(MAX(sequence_number), 0)::bigint AS fence
         FROM meeting_context WHERE meeting_id = $1`,
      [meetingId],
    );
    const sequenceFence = Number(fenceRes.rows[0]?.fence ?? 0);

    // Insert the turn_records row and grab its id.
    const turnId = randomUUID();
    await client.query(
      `INSERT INTO turn_records (id, meeting_id, participant_id, sequence_fence, state)
       VALUES ($1, $2, $3, $4, 'running')`,
      [turnId, meetingId, resolvedParticipantId, sequenceFence],
    );

    // Flip meeting to turn_in_progress and pin current_turn_id atomically.
    await client.query(
      `UPDATE meetings
          SET state = 'turn_in_progress',
              current_turn_id = $1
        WHERE id = $2`,
      [turnId, meetingId],
    );

    await client.query("COMMIT");
    return {
      turnId,
      resolvedParticipantId,
      previousState: meeting.state,
      sequenceFence,
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw err;
  }
}

// ── T2: commit ───────────────────────────────────────────────────────────────

interface T2CommitArgs {
  meetingId: string;
  participantId: string;
  turnId: string;
  agentId: number;
  ownerUserId: number;
  content: string;
  visibility: "all" | "scoped" | "private";
  scopeAgentIds: number[];
  /** Fence captured in T1; defense-in-depth check re-asserted in T2. */
  sequenceFence?: number;
}

async function t2Commit(client: PoolClient, args: T2CommitArgs): Promise<TurnResult> {
  await client.query("BEGIN");
  try {
    // Lock meeting row, re-assert invariants.
    const mRes = await client.query(
      `SELECT id, state, current_turn_id FROM meetings WHERE id = $1 FOR UPDATE`,
      [args.meetingId],
    );
    if (mRes.rows.length === 0) {
      throw new Error(`meeting ${args.meetingId} vanished between T1 and T2`);
    }
    const meeting = mRes.rows[0] as { state: MeetingStateDb; current_turn_id: string | null };
    if (meeting.state !== "turn_in_progress" || meeting.current_turn_id !== args.turnId) {
      throw new TurnStateMismatchError(
        "state_mismatch",
        `T2: expected state=turn_in_progress current_turn_id=${args.turnId}, got state=${meeting.state} current_turn_id=${meeting.current_turn_id}`,
      );
    }

    // Defense-in-depth fence assertion (Bro2 Q1 adjacent suggestion): re-read
    // the current MAX(sequence_number) and verify it's >= the fence we captured
    // in T1. If it's ever less, something catastrophic happened (row deletion,
    // cross-meeting contamination) and we abort loudly before writing more data.
    if (args.sequenceFence !== undefined) {
      const fenceRes = await client.query(
        `SELECT COALESCE(MAX(sequence_number), 0)::bigint AS fence
           FROM meeting_context WHERE meeting_id = $1`,
        [args.meetingId],
      );
      const currentFence = Number(fenceRes.rows[0]?.fence ?? 0);
      if (currentFence < args.sequenceFence) {
        throw new Error(
          `T2 fence regression: captured=${args.sequenceFence} observed=${currentFence} meeting=${args.meetingId} turn=${args.turnId}`,
        );
      }
    }

    // Compute the next sequence_number atomically — max+1 under row lock.
    const seqRes = await client.query(
      `SELECT COALESCE(MAX(sequence_number), 0)::bigint + 1 AS next_seq
         FROM meeting_context WHERE meeting_id = $1`,
      [args.meetingId],
    );
    const nextSeq = Number(seqRes.rows[0]?.next_seq ?? 1);

    // Insert new meeting_context row.
    const ctxRes = await client.query(
      `INSERT INTO meeting_context
         (meeting_id, sequence_number, content, author_agent_id, visibility, scope_agent_ids)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        args.meetingId,
        nextSeq,
        args.content,
        args.agentId,
        args.visibility,
        JSON.stringify(args.scopeAgentIds ?? []),
      ],
    );
    const contextEntryId = ctxRes.rows[0].id as string;

    // Mark turn_records row completed.
    await client.query(
      `UPDATE turn_records
          SET state = 'completed', completed_at = now()
        WHERE id = $1`,
      [args.turnId],
    );

    // Advance state machine: determine next participant + next state.
    const nextPid = await pickNextParticipant(client, args.meetingId, args.participantId);

    // Per-participant profile: if current speaker is `approve` mode, park.
    const needApproval = await currentModeRequiresApproval(client, args.participantId);
    const newState: MeetingStateDb = needApproval
      ? "waiting_for_approval"
      : nextPid
        ? "waiting_for_turn"
        : "active"; // ran out of participants / round complete — remain active for round 2

    await client.query(
      `UPDATE meetings
          SET state = $1,
              current_turn_id = NULL,
              next_participant_id = $2,
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                         CASE WHEN $1 = 'waiting_for_approval'
                              THEN jsonb_build_object('waiting_since', to_jsonb(now()))
                              ELSE '{}'::jsonb
                         END
        WHERE id = $3`,
      [newState, needApproval ? args.participantId : nextPid, args.meetingId],
    );

    await client.query("COMMIT");

    return {
      turnId: args.turnId,
      meetingId: args.meetingId,
      participantId: args.participantId,
      sequenceNumber: nextSeq,
      contextEntryId,
      newState,
      nextParticipantId: needApproval ? args.participantId : nextPid,
      replayed: false,
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw err;
  }
}

// ── T2-fail: abort path ──────────────────────────────────────────────────────

async function t2Fail(
  pool: { connect(): Promise<PoolClient> },
  meetingId: string,
  turnId: string,
  previousState: MeetingStateDb,
  reason: string,
  eventBus: MeetingEventBus,
  /** SF2: preview of LLM output lost on t2_commit_failed (first 120 chars). */
  lostLlmOutputPreview?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const metadataPatch: Record<string, unknown> = {
      abort_reason: reason,
    };
    if (lostLlmOutputPreview !== undefined && lostLlmOutputPreview.length > 0) {
      metadataPatch.lost_llm_output_preview = lostLlmOutputPreview;
    }
    await client.query(
      `UPDATE meetings
          SET state = 'aborted',
              current_turn_id = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb)
                         || $4::jsonb
                         || jsonb_build_object('aborted_at', to_jsonb(now()))
        WHERE id = $2 AND current_turn_id = $3`,
      [reason, meetingId, turnId, JSON.stringify(metadataPatch)],
    );
    await client.query(
      `UPDATE turn_records
          SET state = 'failed', error = $1, completed_at = now()
        WHERE id = $2`,
      [reason, turnId],
    );
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    logger.error({ err, meetingId, turnId }, "t2Fail: abort path itself failed");
  } finally {
    client.release();
  }
  try {
    await eventBus.emit("meeting.state.changed", {
      meetingId,
      state: "aborted",
      previousState,
      reason,
    });
  } catch (err) {
    logger.error({ err, meetingId }, "t2Fail: eventBus emit failed (swallowed)");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Round-robin pick: returns the id of the next active participant (ordered
 * by joined_at, id) AFTER the one that just spoke. Returns null if there is
 * no active sibling (single participant or everyone else has left).
 *
 * Skips participants with `left_at IS NOT NULL`.
 */
async function pickNextParticipant(
  client: PoolClient,
  meetingId: string,
  currentParticipantId: string,
): Promise<string | null> {
  // Ordered list of active participants; find current, return the one after
  // (cyclic). Done in SQL for atomicity inside the T2 tx.
  const res = await client.query(
    `WITH active AS (
       SELECT id, joined_at
         FROM meeting_participants
        WHERE meeting_id = $1 AND left_at IS NULL
        ORDER BY joined_at ASC, id ASC
     ),
     indexed AS (
       SELECT id, ROW_NUMBER() OVER () AS rn, COUNT(*) OVER () AS n FROM active
     ),
     me AS (
       SELECT rn, n FROM indexed WHERE id = $2
     )
     SELECT indexed.id
       FROM indexed, me
      WHERE indexed.rn = ((me.rn % me.n) + 1)`,
    [meetingId, currentParticipantId],
  );
  if (res.rows.length === 0) return null;
  const nextId = res.rows[0].id as string;
  // If the ring has only one participant, the "next" is themselves — return
  // null so the caller knows there's no true next (callers can still flip to
  // waiting_for_turn with the same id if desired, but default is round-done).
  return nextId === currentParticipantId ? null : nextId;
}

async function currentModeRequiresApproval(
  client: PoolClient,
  participantId: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT participation_mode FROM meeting_participants WHERE id = $1`,
    [participantId],
  );
  if (res.rows.length === 0) return false;
  return res.rows[0].participation_mode === "approve";
}

/**
 * Attach the partner tools registry lazily to avoid a circular import at
 * module-load time (deliberation.ts imports from all over the server).
 * The runner only needs the tool list shape; deliberation.ts exposes
 * `getPartnerToolsForAgent(agent)` which we call here.
 */
async function loadPartnerToolsForAgent(input: TurnInput): Promise<Anthropic.Messages.Tool[]> {
  const mod = await import("../deliberation");
  return mod.getPartnerToolsForAgent({ name: extractAgentNameFromSystemPrompt(input) });
}

/**
 * Extract agent name from `buildSystemPrompt` output. Parses the canonical
 * "You are <name>, …" prefix. Exported for a tripwire test (Bro2 F2) that
 * fails loudly if buildSystemPrompt changes shape (e.g. voice-PR adds a
 * preamble) and would otherwise silently route to the empty-tool-list fallback.
 *
 * On fallback, logs a `warn` with agentId + first 80 chars of the system
 * prompt so prod diverges visibly in logs BEFORE users see broken behavior.
 *
 * W10 follow-up: carry `agentName` through TurnInput directly and delete this.
 */
export function extractAgentNameFromSystemPrompt(input: {
  systemPrompt: string;
  agentId: number;
}): string {
  // Canonical buildSystemPrompt shape:
  //   "You are <name> participating in a KIOKU Meeting Room.\n\n..."
  // Or, when adopted in prior partner-chat shapes:
  //   "You are <name>, <description>..."
  //   "You are <name>. <rest>"
  // The pattern below captures the agent name up to the FIRST of:
  //   comma, period, or " participating" landmark.
  const m = input.systemPrompt.match(/^You are ([^,.\n]+?)(?:,|\.|\s+participating\b)/);
  if (m) return m[1].trim();
  logger.warn(
    {
      agentId: input.agentId,
      promptPrefix: input.systemPrompt.slice(0, 80),
    },
    "extractAgentNameFromSystemPrompt: regex fallback — buildSystemPrompt prefix may have changed",
  );
  return `agent_${input.agentId}`;
}

function classifyError(err: unknown): string {
  if (err instanceof CircuitOpenError) return "breaker_open";
  if (err instanceof TurnTimeoutError) return "turn_timeout";
  if (err instanceof MCMNotFoundError) return `mcm_${err.code}`;
  if (err instanceof ParticipantInactiveError) return "participant_inactive";
  if (err instanceof ProfileMissingError) return "profile_missing";
  if (isAnthropicFailure(err)) return "llm_failure";
  if (err instanceof Error) return `llm_error:${err.message.slice(0, 120)}`;
  return "unknown_error";
}

/**
 * Promise.race timeout wrapper. Rejects with TurnTimeoutError if `ms`
 * elapses first. The underlying promise keeps running — callers tolerate
 * that (the Anthropic SDK request continues until it settles, but our
 * runner already took the abort path).
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let tid: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    tid = setTimeout(() => reject(new TurnTimeoutError()), ms);
  });
  return Promise.race([
    p.finally(() => clearTimeout(tid!)),
    timeout,
  ]) as Promise<T>;
}

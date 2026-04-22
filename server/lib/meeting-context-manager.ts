/**
 * Meeting Context Manager (MCM) — W9 Item 1
 *
 * Pure, read-only assembly of the input for a single meeting turn.
 *
 * Responsibilities (from week9_plan_v2.md):
 *   1. Given (meetingId, participantId), return TurnInput with:
 *        - resolved agent + llmModel
 *        - autonomy_level string
 *        - systemPrompt (agent.description + allowed/blocked topics + autonomy rules)
 *        - visibleContext (meeting_context rows the *agent* is allowed to see)
 *        - lastSequence (for idempotency fence in turn runner)
 *   2. Enforce read-side privacy (visibility filter identical to GET /context).
 *   3. Throw typed errors (NotFound / ProfileMissing / ParticipantInactive) so
 *      the turn runner can translate to state transitions.
 *
 * This module is pure-readonly: no writes, no side effects, no event emission.
 * It is a separate seam from the turn runner (Item 2) and the REST route
 * handlers (Item 3-4). Callers pass a PoolClient (inside a tx) or a Pool
 * (ad-hoc read) — both satisfy the `DbExecutor` interface.
 *
 * Bro2 plan v2 alignment:
 *   - Invariant #2 (participant sees only their scoped context) enforced here.
 *   - F1 test hook: visibility='private' handled by excluding entries where the
 *     requesting agent is not in scope_agent_ids. This mirrors (and extends)
 *     the existing GET /context filter which only supports all/owner/scoped.
 *   - Tool filtering is NOT done here — that lives in meeting-tools.ts (Item 2)
 *     which the turn runner consults when building the LLM request.
 *   - No writes: memory_scope / carry_over_memory are READ only; enforcement
 *     lives in Item 5 (artifact + end-meeting commit).
 */

import type { Pool, PoolClient } from "pg";

/** Either a Pool or a PoolClient in an open transaction. */
export type DbExecutor = Pool | PoolClient;

/**
 * Autonomy levels allowed by the schema (migrations/0001 — CHECK constraint on
 * meeting_participant_profiles.autonomy_level). W9 MVP scopes active behaviour
 * to `propose` and `commit` only; `observe` and `execute` are out-of-scope for
 * W9 (see week9_plan_v2.md "Out of scope") but still valid schema values so
 * MCM must not crash if the DB returns one of them.
 */
export type AutonomyLevel = "observe" | "propose" | "commit" | "execute";

/**
 * Visibility levels on a meeting_context row.
 *
 * `'private'` is a FORWARD-COMPATIBLE value: the migrations/0001 CHECK
 * constraint currently only accepts `all | owner | scoped`, and the CHECK is
 * widened in Item 2 (migration 0004). MCM handles `'private'` here already so
 * that (a) the F1 read-side test can exercise the code path via unit tests
 * with an in-memory DB executor, and (b) once 0004 lands no code change is
 * required — the turn runner can start emitting private rows immediately.
 */
export type ContextVisibility = "all" | "owner" | "scoped" | "private";

export interface MeetingContextEntry {
  id: string;
  meetingId: string;
  sequenceNumber: number;
  content: string;
  authorAgentId: number | null;
  visibility: ContextVisibility;
  scopeAgentIds: number[];
  createdAt: Date;
}

export interface TurnInput {
  meetingId: string;
  participantId: string;
  agentId: number;
  /**
   * Canonical agent display name sourced directly from `agents.name`.
   * W10: carried through explicitly so downstream consumers (partner tool
   * registry, logger, prompt builder) never re-parse it from systemPrompt.
   * Falls back to `agent_<id>` if the agent row has no name (should not
   * happen in prod; defensive for seed/test data).
   */
  agentName: string;
  ownerUserId: number;
  llmModel: string | null;
  autonomyLevel: AutonomyLevel;
  systemPrompt: string;
  visibleContext: MeetingContextEntry[];
  /**
   * MAX(sequence_number) visible to THIS AGENT at assembly time. 0 if empty.
   *
   * Useful for: building the LLM message array floor ("include everything I
   * can see up to here") and per-agent retry logic.
   *
   * NOT for Item 2 T1 idempotency fence — that must be a GLOBAL
   * `MAX(sequence_number) FROM meeting_context WHERE meeting_id=$1` (no
   * visibility filter). Private rows from other agents constitute meeting
   * advancement and must bust an agent's idempotency cache. See Bro2 W9
   * Item 1 review, R2 (2026-04-22).
   */
  lastSequence: number;
  /**
   * Raw memory_scope JSONB from `meeting_participant_profiles`. Passed
   * through so Item 5's memory-commit step can consume without a re-query.
   * Shape is intentionally `Record<string, unknown>` here — schema for the
   * scope object is defined at the memory-commit boundary, not here.
   */
  memoryScope: Record<string, unknown>;
  /** Raw `carry_over_memory` flag from the participant profile. */
  carryOverMemory: boolean;
}

/** Thrown when the meeting does not exist or the participant row is absent. */
export class MCMNotFoundError extends Error {
  constructor(public readonly code: "meeting_not_found" | "participant_not_found") {
    super(code);
    this.name = "MCMNotFoundError";
  }
}

/** Thrown when the participant exists but has no profile row. */
export class ProfileMissingError extends Error {
  constructor(public readonly meetingId: string, public readonly agentId: number) {
    super(`profile_missing meeting=${meetingId} agent=${agentId}`);
    this.name = "ProfileMissingError";
  }
}

/** Thrown when the participant has left (left_at IS NOT NULL). */
export class ParticipantInactiveError extends Error {
  constructor(public readonly participantId: string) {
    super(`participant_inactive id=${participantId}`);
    this.name = "ParticipantInactiveError";
  }
}

const AUTONOMY_LEVELS: ReadonlySet<AutonomyLevel> = new Set([
  "observe",
  "propose",
  "commit",
  "execute",
]);

function isAutonomyLevel(x: string): x is AutonomyLevel {
  return AUTONOMY_LEVELS.has(x as AutonomyLevel);
}

/**
 * Short instruction stanzas appended to systemPrompt based on autonomy level.
 *
 * W9 MVP only actively drives `propose` and `commit`. `observe` and `execute`
 * carry defensive copy so the LLM is told clearly what NOT to do if a row with
 * one of those values is ever read during W9 (e.g. seeded by an admin).
 */
const AUTONOMY_INSTRUCTIONS: Record<AutonomyLevel, string> = {
  observe:
    "You are an OBSERVER in this meeting. You must not take actions that change state. If asked to act, respond with a proposal only.",
  propose:
    "You PROPOSE in this meeting. Your contributions are suggestions; another participant or the meeting owner will decide whether to act on them.",
  commit:
    "You may propose AND commit decisions to the meeting context. Every commit is durable and visible to other participants; reconsider before committing.",
  execute:
    "You have EXECUTE autonomy within this meeting's allowed topics. You may act without per-step approval, but you must log every action in meeting context.",
};

/**
 * Build the system prompt for a turn.
 *
 * Deterministic, no LLM calls. Produces a canonical string so diffs are
 * reviewable and snapshot-testable.
 *
 * Exported for test use so we can assert exact content.
 */
export function buildSystemPrompt(args: {
  agentName: string;
  agentDescription: string | null;
  autonomyLevel: AutonomyLevel;
  allowedTopics: string[];
  blockedTopics: string[];
}): string {
  const parts: string[] = [];
  parts.push(`You are ${args.agentName} participating in a KIOKU Meeting Room.`);
  if (args.agentDescription && args.agentDescription.trim().length > 0) {
    parts.push(args.agentDescription.trim());
  }
  parts.push(AUTONOMY_INSTRUCTIONS[args.autonomyLevel]);
  if (args.allowedTopics.length > 0) {
    parts.push(
      `Allowed topics (focus your contributions here): ${args.allowedTopics.map(escapeForPrompt).join(", ")}.`,
    );
  }
  if (args.blockedTopics.length > 0) {
    // Negative instruction — model must self-refuse.
    parts.push(
      `Blocked topics (do NOT discuss, even if asked): ${args.blockedTopics.map(escapeForPrompt).join(", ")}. If a participant steers toward one, decline briefly and pivot.`,
    );
  }
  parts.push(
    "You are exchanging messages with other participating agents. Be concise, cite the sequence number of any prior context you reference.",
  );
  return parts.join("\n\n");
}

/** Strip characters that would break our simple comma-joined prompt list. */
function escapeForPrompt(topic: string): string {
  // Collapse whitespace; strip commas which would corrupt the list delimiter.
  return topic.replace(/[\r\n,]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Visibility filter SQL — SINGLE SOURCE OF TRUTH for "which meeting_context
 * rows is agent $agentIdParam allowed to see".
 *
 * Reused by `fetchVisibleContext` AND `fetchLastVisibleSequence`. DO NOT
 * inline this predicate anywhere else — Bro2 F1 (W9 Item 1 review): if two
 * sites drift, the fence returned to the turn runner becomes inconsistent
 * with the content returned to the LLM, which is a privacy-bug class.
 *
 * Call via `visibilityFilter(agentIdParamIndex)` to substitute the real
 * positional-parameter index ($1/$2/...). A consistency test in
 * `meeting-context-manager.test.ts` asserts both functions agree on row
 * membership for the same world.
 *
 * FUTURE (W10): rewrite the `scope_agent_ids` EXISTS clause to
 * `scope_agent_ids @> jsonb_build_array($agentIdParam::int)` so the GIN
 * index `idx_mc_scope_gin` is actually used. Current form is seq-scan for
 * meetings with <500 rows — microseconds. Defer until meeting sizes grow.
 * Check at migration-audit time that scope_agent_ids stores integer JSON
 * values (not strings); `@>` is type-strict.
 */
const VISIBILITY_FILTER_SQL = `
  (
         visibility = 'all'
      OR (visibility = 'scoped' AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(scope_agent_ids) AS e
              WHERE (e::int) = $agentIdParam
         ))
      OR (visibility = 'private' AND (
             author_agent_id = $agentIdParam
          OR EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(scope_agent_ids) AS e
                WHERE (e::int) = $agentIdParam
             )
         ))
  )
`;

/** Build the visibility filter with a concrete positional parameter index. */
function visibilityFilter(agentIdParamIndex: number): string {
  return VISIBILITY_FILTER_SQL.replaceAll("$agentIdParam", `$${agentIdParamIndex}`);
}

/**
 * Return the array of agentIds owned by `ownerUserId` that are ACTIVE
 * participants in `meetingId`. Used for scoped-visibility resolution.
 */
async function fetchOwnedActiveAgentIds(
  db: DbExecutor,
  meetingId: string,
  ownerUserId: number,
): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT agent_id
       FROM meeting_participants
      WHERE meeting_id = $1 AND owner_user_id = $2 AND left_at IS NULL`,
    [meetingId, ownerUserId],
  );
  return rows.map((r: { agent_id: number }) => r.agent_id);
}

/**
 * Fetch meeting context visible to a specific agent.
 *
 * Visibility rules:
 *  - visibility='all'      → always visible
 *  - visibility='owner'    → visible only to meeting creator (NOT the turn-taking agent)
 *  - visibility='scoped'   → visible if this agent's id appears in scope_agent_ids
 *  - visibility='private'  → visible if this agent is the author_agent_id OR
 *                            this agent's id appears in scope_agent_ids
 *
 * Note: owner-scoped rows are excluded for non-creator agents because a turn
 * is run on behalf of an agent, not on behalf of the creator-as-human. The
 * creator can still read those rows via GET /context.
 */
export async function fetchVisibleContext(
  db: DbExecutor,
  meetingId: string,
  agentId: number,
  limit = 500,
): Promise<MeetingContextEntry[]> {
  // For meeting TURN inputs we want a TIGHT filter: the agent sees rows
  // scoped to itself (not to its sibling agents). This is the difference vs
  // GET /context which aggregates for the owner-as-human.
  //
  // Therefore we parameterize on a single agentId. `ownerUserId` is not part
  // of the filter here — the route-level ACL has already validated the user
  // owns the participant before calling MCM.

  const params: Array<string | number> = [meetingId, agentId, limit];
  const sql = `
    SELECT id, meeting_id, sequence_number, content, author_agent_id,
           visibility, scope_agent_ids, created_at
      FROM meeting_context
     WHERE meeting_id = $1
       AND ${visibilityFilter(2)}
     ORDER BY sequence_number ASC
     LIMIT $3`;
  const { rows } = await db.query(sql, params);
  return rows.map(rowToEntry);
}

function rowToEntry(r: any): MeetingContextEntry {
  // scope_agent_ids is JSONB containing an integer array in the schema, but we
  // defensively coerce each element through Number() before filtering with
  // Number.isFinite. Why: different JSONB readers / driver configurations do
  // not all hand back JSON arrays identically — node-postgres with the default
  // type parser returns a real JS array of numbers, but some test doubles,
  // older pg-types versions, or admin/migration tools that round-trip JSONB
  // through text can yield an array of strings (e.g. ["10", "12"]). Coercing
  // here keeps the public MeetingContextEntry.scopeAgentIds shape as number[]
  // no matter which reader path produced the row, and the isFinite filter
  // drops anything non-numeric (NaN, nulls) instead of propagating bad data.
  const rawScope = r.scope_agent_ids;
  let scope: number[] = [];
  if (Array.isArray(rawScope)) {
    scope = rawScope
      .map((v: unknown) => (typeof v === "number" ? v : Number(v)))
      .filter((n: number) => Number.isFinite(n));
  }
  return {
    id: r.id,
    meetingId: r.meeting_id,
    sequenceNumber: Number(r.sequence_number),
    content: r.content,
    authorAgentId: r.author_agent_id == null ? null : Number(r.author_agent_id),
    visibility: r.visibility as ContextVisibility,
    scopeAgentIds: scope,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  };
}

/**
 * Main entry point — assemble a TurnInput for (meetingId, participantId).
 *
 * Use inside a transaction when called from the turn runner so the row lock
 * semantics are correct. Fetching is read-only so it also works outside a tx
 * (e.g. for test assertions or debugging endpoints).
 */
export async function buildTurnInput(
  db: DbExecutor,
  args: {
    meetingId: string;
    participantId: string;
    /**
     * If true, return context visible to the agent. If false, return empty
     * context (used by the turn-runner error paths where we only need agent
     * metadata). Defaults to true.
     */
    includeContext?: boolean;
    /** Max context rows. Defaults to 500 (schema-aligned). */
    contextLimit?: number;
  },
): Promise<TurnInput> {
  const includeContext = args.includeContext !== false;
  const limit = args.contextLimit ?? 500;

  // 1. Meeting + participant + profile + agent — single join so we either have
  //    all pieces or we know exactly which is missing.
  const { rows: joinRows } = await db.query(
    `SELECT
        m.id                           AS meeting_id,
        m.state                        AS meeting_state,
        mp.id                          AS participant_id,
        mp.agent_id                    AS agent_id,
        mp.owner_user_id               AS owner_user_id,
        mp.left_at                     AS left_at,
        a.name                         AS agent_name,
        a.description                  AS agent_description,
        a.llm_model                    AS agent_llm_model,
        mpp.autonomy_level             AS autonomy_level,
        mpp.allowed_topics             AS allowed_topics,
        mpp.blocked_topics             AS blocked_topics,
        mpp.memory_scope               AS memory_scope,
        mpp.carry_over_memory          AS carry_over_memory
      FROM meetings m
      LEFT JOIN meeting_participants mp
        ON mp.meeting_id = m.id AND mp.id = $2
      LEFT JOIN agents a
        ON a.id = mp.agent_id
      LEFT JOIN meeting_participant_profiles mpp
        ON mpp.meeting_id = m.id AND mpp.agent_id = mp.agent_id
     WHERE m.id = $1`,
    [args.meetingId, args.participantId],
  );

  const row = joinRows[0];
  if (!row) {
    throw new MCMNotFoundError("meeting_not_found");
  }
  if (!row.participant_id) {
    throw new MCMNotFoundError("participant_not_found");
  }
  if (row.left_at) {
    throw new ParticipantInactiveError(args.participantId);
  }
  if (!row.autonomy_level) {
    // Left-join on profile missed → no profile row.
    throw new ProfileMissingError(args.meetingId, row.agent_id);
  }

  // 2. Normalize.
  const autonomy: string = row.autonomy_level;
  if (!isAutonomyLevel(autonomy)) {
    // Defensive: schema default is 'propose'; if we see an unexpected literal
    // fail loudly rather than silently falling back.
    throw new Error(
      `invalid autonomy_level in profile: ${JSON.stringify(autonomy)} (meeting=${args.meetingId} agent=${row.agent_id})`,
    );
  }
  const allowed: string[] = Array.isArray(row.allowed_topics) ? row.allowed_topics.map(String) : [];
  const blocked: string[] = Array.isArray(row.blocked_topics) ? row.blocked_topics.map(String) : [];

  // 3. System prompt — deterministic assembly.
  const agentName: string = row.agent_name ?? `agent_${row.agent_id}`;
  const systemPrompt = buildSystemPrompt({
    agentName,
    agentDescription: row.agent_description,
    autonomyLevel: autonomy,
    allowedTopics: allowed,
    blockedTopics: blocked,
  });

  // 4. Visible context.
  let visibleContext: MeetingContextEntry[] = [];
  let lastSequence = 0;
  if (includeContext) {
    visibleContext = await fetchVisibleContext(
      db,
      args.meetingId,
      row.agent_id,
      limit,
    );
    if (visibleContext.length > 0) {
      lastSequence = visibleContext[visibleContext.length - 1]!.sequenceNumber;
    }
  }

  // 5. Memory policy fields (R1) — read-only, surfaced for the turn runner
  //    and memory-isolation layer. memory_scope is a JSONB object; default to
  //    {} when null so downstream never branches on null. carry_over_memory
  //    is a bool column (default false); strict === true avoids coercing
  //    unexpected values (e.g. 'false' strings from a misbehaving driver).
  const memoryScope: Record<string, unknown> =
    row.memory_scope && typeof row.memory_scope === "object" && !Array.isArray(row.memory_scope)
      ? (row.memory_scope as Record<string, unknown>)
      : {};
  const carryOverMemory: boolean = row.carry_over_memory === true;

  return {
    meetingId: args.meetingId,
    participantId: args.participantId,
    agentId: row.agent_id,
    agentName,
    ownerUserId: row.owner_user_id,
    llmModel: row.agent_llm_model ?? null,
    autonomyLevel: autonomy,
    systemPrompt,
    visibleContext,
    lastSequence,
    memoryScope,
    carryOverMemory,
  };
}

/**
 * Public helper so other modules (e.g. the turn runner when preparing
 * idempotency keys) can fetch the fence WITHOUT assembling the full input.
 *
 * Returns 0 for empty context. Uses the same visibility filter so the fence
 * matches what the agent "sees"; the runner uses this to avoid generating a
 * duplicate turn when the agent's visible history hasn't changed.
 */
export async function fetchLastVisibleSequence(
  db: DbExecutor,
  meetingId: string,
  agentId: number,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(sequence_number), 0)::bigint AS seq
       FROM meeting_context
      WHERE meeting_id = $1
        AND ${visibilityFilter(2)}`,
    [meetingId, agentId],
  );
  return Number(rows[0]?.seq ?? 0);
}

/**
 * Test/debug helper: returns the set of owned active agent IDs for
 * `ownerUserId` in `meetingId`. Not called by buildTurnInput itself (we
 * deliberately scope to a single agent there), but useful for integration
 * tests and admin tooling.
 */
export async function listOwnedActiveAgentIds(
  db: DbExecutor,
  meetingId: string,
  ownerUserId: number,
): Promise<number[]> {
  return fetchOwnedActiveAgentIds(db, meetingId, ownerUserId);
}

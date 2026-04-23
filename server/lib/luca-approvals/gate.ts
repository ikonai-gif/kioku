/**
 * Luca Day 6 — approval gate module.
 *
 * Single source of truth for the `tool_approvals` lifecycle:
 *
 *   createPendingApproval()  —  middleware inserts a pending row before
 *                               executing a HIGH_STAKES_WRITE tool, and
 *                               returns `{status:"pending_approval"}` to
 *                               Luca instead of running the handler.
 *                               Dedupe: see below.
 *
 *   decideApproval()         —  the decision endpoint calls this when
 *                               Kote clicks Send / No / Edit. Flips
 *                               status, persists final_payload, and
 *                               (for send/edit) returns a descriptor
 *                               that the caller uses to actually run
 *                               the downstream tool handler. Execution
 *                               itself is NOT inside this module —
 *                               that lives in the middleware so we
 *                               don't pull the whole partner-tool
 *                               dispatcher into a low-level library.
 *
 *   getApproval() / listPendingForUser()
 *                            —  read paths for UI + polling fallback.
 *
 *   expirePending()          —  worker tick. Flips any pending rows
 *                               past expires_at to status='timeout'.
 *                               Called from server startup as
 *                               setInterval(EXPIRE_WORKER_TICK_MS).
 *
 * Dedupe (Luca N3 from Day 6 review):
 *   Turn-scoped primary key — `(agentId, toolName, codeSha, turnId)`.
 *   If a pending row with same 4-tuple exists, reuse it. Turn-scoped
 *   precisely captures "one attempt per turn per payload" which is the
 *   intent (deliberation retry loops stay within the same turn; cross-
 *   turn identical calls are legitimately different intents).
 *
 *   Fallback for turnId=null: 60s time window on `(agentId, toolName,
 *   codeSha)`. Solo Luca sessions (no meeting) have no turnId; the
 *   time window is a weaker proxy but still prevents the "retry-loop
 *   spams Kote" failure mode.
 *
 * What this module does NOT do:
 *   - Run the downstream tool handler on approval (middleware's job).
 *   - Decide which tools are HIGH (classify.ts's job).
 *   - Broadcast to the UI (ws.ts helpers, wired by the caller — this
 *     module returns rows + decision descriptors; callers fan out).
 *
 * All DB work uses the shared drizzle `db` from server/storage.ts.
 */

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db as defaultDb } from "../../storage";
import { toolApprovals, type ToolApproval } from "@shared/schema";

/**
 * DB handle type — any object shaped like the drizzle client we use.
 * Tests inject an in-memory fake; production uses the real `db` from
 * server/storage.ts. Kept loose because drizzle's generic query builders
 * are structural and pinning internal drizzle types here is fragile.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GateDb = any;

let _db: GateDb = defaultDb;

/** Test-only: inject an in-memory fake db. */
export function __setGateDbForTests(fake: GateDb): void {
  _db = fake;
}

/** Test-only: restore production db. */
export function __resetGateDbForTests(): void {
  _db = defaultDb;
}

function db(): GateDb {
  return _db;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "edited"
  | "timeout"
  | "error";

export type ApprovalAction = "send" | "reject" | "edit";

/** Default TTL for a pending approval — 24h per Kote's spec. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Dedupe time window used ONLY when turnId is null (solo Luca session).
 * When turnId is present, dedupe is turn-scoped (strong) and this
 * window is not consulted.
 */
export const SOLO_DEDUPE_WINDOW_MS = 60 * 1000;

/**
 * Max number of pending approvals a single user may accrue (Luca Q5).
 * The 21st call throws ApprovalError("approval_queue_full") — the caller
 * (middleware) surfaces this to Luca as a tool-layer error, which he
 * reports to Kote ("я собрал 20 ожидающих решений, разберись с ними
 * прежде чем я буду слать ещё"). Dedupe hits are OK past the cap — they
 * don't create a new row.
 */
export const MAX_PENDING_PER_USER = 20;

export interface CreateApprovalInput {
  agentId: number;
  userId: number;
  meetingId?: string | null;
  turnId?: string | null;
  toolName: string;
  draftPayload: unknown;
  ttlMs?: number;
}

export interface DecideApprovalInput {
  approvalId: string;
  action: ApprovalAction;
  deciderUserId: number;
  editedPayload?: unknown;
  note?: string;
}

/**
 * Descriptor returned to the caller of decideApproval for send/edit
 * decisions. The middleware uses it to actually run the downstream
 * tool handler — gate.ts stays pure w.r.t. tool dispatch.
 */
export interface ApprovalExecutionDescriptor {
  approval: ToolApproval;
  shouldExecute: boolean;             // true if action=send|edit
  payloadToExecute: unknown | null;   // final_payload; null if shouldExecute=false
}

/** Errors thrown by the gate (string-matchable). */
export class ApprovalError extends Error {
  constructor(public readonly code: ApprovalErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ApprovalError";
  }
}

export type ApprovalErrorCode =
  | "approval_not_found"
  | "approval_already_decided"
  | "approval_not_authorized"
  | "approval_edit_missing_payload"
  | "approval_invalid_action"
  | "approval_queue_full";

/**
 * Stable JSON stringify for codeSha hashing. Sorts object keys so
 * `{a:1,b:2}` and `{b:2,a:1}` hash identically — prevents dedupe
 * misses from key-order drift. Arrays preserve order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** sha256(toolName + "|" + stableStringify(draftPayload)) as hex. */
export function computeCodeSha(toolName: string, draftPayload: unknown): string {
  const h = createHash("sha256");
  h.update(toolName);
  h.update("|");
  h.update(stableStringify(draftPayload));
  return h.digest("hex");
}

/**
 * Create (or reuse on dedupe hit) a pending approval row.
 *
 * Dedupe strategy:
 *   1. If turnId is provided, look up existing pending row with same
 *      (agentId, toolName, codeSha, turnId). If found, return it —
 *      this is the "retry-loop within a single turn" case.
 *   2. If turnId is null, look up existing pending row with same
 *      (agentId, toolName, codeSha) within the last
 *      SOLO_DEDUPE_WINDOW_MS. If found, return it.
 *   3. Otherwise insert a fresh row and return it.
 *
 * Both branches short-circuit BEFORE inserting — the row we return on
 * a dedupe hit is the ORIGINAL row (same approval_id), so the caller's
 * "pending_approval" response stays consistent across retries.
 */
export async function createPendingApproval(
  input: CreateApprovalInput,
): Promise<ToolApproval> {
  const now = new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const codeSha = computeCodeSha(input.toolName, input.draftPayload);

  // ─── Dedupe lookup ──────────────────────────────────────────────
  if (input.turnId) {
    // Turn-scoped — strongest signal. A single turn should never produce
    // two semantically identical HIGH calls; if it does, it's a retry.
    const existing = await db()
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.agentId, input.agentId),
          eq(toolApprovals.toolName, input.toolName),
          eq(toolApprovals.codeSha, codeSha),
          eq(toolApprovals.turnId, input.turnId),
          eq(toolApprovals.status, "pending"),
        ),
      )
      .orderBy(desc(toolApprovals.createdAt))
      .limit(1);
    if (existing.length > 0) {
      return existing[0];
    }
  } else {
    // Solo-session fallback — time-window dedupe.
    const windowStart = new Date(now.getTime() - SOLO_DEDUPE_WINDOW_MS);
    const existing = await db()
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.agentId, input.agentId),
          eq(toolApprovals.toolName, input.toolName),
          eq(toolApprovals.codeSha, codeSha),
          eq(toolApprovals.status, "pending"),
          gt(toolApprovals.createdAt, windowStart),
        ),
      )
      .orderBy(desc(toolApprovals.createdAt))
      .limit(1);
    if (existing.length > 0) {
      return existing[0];
    }
  }

  // ─── Pending-cap check (Q5) ─────────────────────────────────────
  // Only evaluated when we're about to insert a fresh row. A dedupe hit
  // above already short-circuited, so existing pending rows are fine.
  const pending = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.userId, input.userId),
        eq(toolApprovals.status, "pending"),
      ),
    );
  const pendingCount = pending[0]?.count ?? 0;
  if (pendingCount >= MAX_PENDING_PER_USER) {
    throw new ApprovalError(
      "approval_queue_full",
      `user ${input.userId} already has ${pendingCount} pending approvals (cap ${MAX_PENDING_PER_USER})`,
    );
  }

  // ─── Fresh insert ───────────────────────────────────────────────
  const [row] = await db()
    .insert(toolApprovals)
    .values({
      agentId: input.agentId,
      userId: input.userId,
      meetingId: input.meetingId ?? null,
      turnId: input.turnId ?? null,
      toolName: input.toolName,
      draftPayload: input.draftPayload as Record<string, unknown>,
      finalPayload: null,
      status: "pending",
      decisionNote: null,
      codeSha,
      expiresAt,
      decidedAt: null,
      executedAt: null,
      executionResult: null,
    })
    .returning();

  return row;
}

/**
 * Single-row fetch for UI polling fallback and decision endpoints.
 * Returns null if no such row exists.
 */
export async function getApproval(approvalId: string): Promise<ToolApproval | null> {
  const rows = await db()
    .select()
    .from(toolApprovals)
    .where(eq(toolApprovals.id, approvalId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * List pending approvals for a given user (Kote's Luca Board "what
 * needs my decision" query). Ordered by creation time DESC, newest
 * first — UI wants most recent at the top.
 */
export async function listPendingForUser(
  userId: number,
  limit = 50,
): Promise<ToolApproval[]> {
  return db()
    .select()
    .from(toolApprovals)
    .where(
      and(eq(toolApprovals.userId, userId), eq(toolApprovals.status, "pending")),
    )
    .orderBy(desc(toolApprovals.createdAt))
    .limit(limit);
}

/**
 * Count pending approvals for a user — used by the queue-full cap
 * (Luca Q5: 20 max pending, 21st returns error).
 */
export async function countPendingForUser(userId: number): Promise<number> {
  const rows = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(toolApprovals)
    .where(
      and(eq(toolApprovals.userId, userId), eq(toolApprovals.status, "pending")),
    );
  return rows[0]?.count ?? 0;
}

/**
 * Apply a decision. Transitions pending → approved|rejected|edited
 * and returns a descriptor the caller uses to run the downstream
 * tool handler (for send/edit) or skip execution (for reject).
 *
 * Authorization: deciderUserId MUST equal approval.user_id. Any other
 * value throws approval_not_authorized — approvals are per-user.
 *
 * Idempotency: decision on an already-decided row throws
 * approval_already_decided. The caller is responsible for handling
 * this (UI should disable buttons after first click, but server
 * must enforce).
 */
export async function decideApproval(
  input: DecideApprovalInput,
): Promise<ApprovalExecutionDescriptor> {
  if (input.action !== "send" && input.action !== "reject" && input.action !== "edit") {
    throw new ApprovalError("approval_invalid_action", `unknown action: ${input.action}`);
  }
  if (input.action === "edit" && input.editedPayload === undefined) {
    throw new ApprovalError(
      "approval_edit_missing_payload",
      "edit action requires editedPayload",
    );
  }

  const row = await getApproval(input.approvalId);
  if (!row) {
    throw new ApprovalError("approval_not_found", input.approvalId);
  }
  if (row.userId !== input.deciderUserId) {
    throw new ApprovalError(
      "approval_not_authorized",
      `user ${input.deciderUserId} cannot decide approval owned by user ${row.userId}`,
    );
  }
  if (row.status !== "pending") {
    throw new ApprovalError(
      "approval_already_decided",
      `status is ${row.status}, not pending`,
    );
  }

  // ─── Apply state transition ────────────────────────────────────
  const now = new Date();
  let newStatus: ApprovalStatus;
  let finalPayload: unknown;
  switch (input.action) {
    case "send":
      newStatus = "approved";
      finalPayload = row.draftPayload;
      break;
    case "edit":
      // Luca N2 review decision (instant send on edit): Kote's edited
      // payload is the final; we do NOT loop back to pending. A future
      // flag APPROVAL_EDIT_MODE=preview could reintroduce two-step.
      newStatus = "edited";
      finalPayload = input.editedPayload;
      break;
    case "reject":
      newStatus = "rejected";
      finalPayload = null;
      break;
  }

  const [updated] = await db()
    .update(toolApprovals)
    .set({
      status: newStatus,
      finalPayload: finalPayload as Record<string, unknown> | null,
      decisionNote: input.note ?? null,
      decidedAt: now,
    })
    .where(
      and(
        eq(toolApprovals.id, input.approvalId),
        eq(toolApprovals.status, "pending"), // optimistic concurrency guard
      ),
    )
    .returning();

  if (!updated) {
    // Row flipped underneath us (concurrent decide). Re-fetch to report
    // the right reason.
    const fresh = await getApproval(input.approvalId);
    if (!fresh) throw new ApprovalError("approval_not_found");
    if (fresh.status !== "pending") {
      throw new ApprovalError(
        "approval_already_decided",
        `status is ${fresh.status}, not pending`,
      );
    }
    // Very unlikely: row exists, still pending, but update returned zero.
    // Bubble up as already_decided conservatively.
    throw new ApprovalError("approval_already_decided", "concurrent update");
  }

  const shouldExecute = newStatus === "approved" || newStatus === "edited";
  return {
    approval: updated,
    shouldExecute,
    payloadToExecute: shouldExecute ? finalPayload : null,
  };
}

/**
 * Persist the downstream tool handler's result back onto the approval
 * row. Called by the caller after actually executing the approved
 * handler. Separate step so gate.ts doesn't need to know anything
 * about tool dispatch — caller is responsible for running the handler
 * and feeding us the outcome.
 *
 * Writes: executed_at = now(), execution_result = result. If the
 * handler threw, caller should set status='error' via this method
 * (pass ok=false).
 */
export async function recordExecutionResult(
  approvalId: string,
  outcome: { ok: boolean; result: unknown },
): Promise<ToolApproval | null> {
  const now = new Date();
  const updates: Partial<typeof toolApprovals.$inferInsert> = {
    executedAt: now,
    executionResult: outcome.result as Record<string, unknown>,
  };
  if (!outcome.ok) {
    updates.status = "error";
  }
  const [updated] = await db()
    .update(toolApprovals)
    .set(updates)
    .where(eq(toolApprovals.id, approvalId))
    .returning();
  return updated ?? null;
}

/**
 * Expire pending rows past their deadline. Called from a worker tick
 * (setInterval) at server startup. Returns the number of rows
 * transitioned pending → timeout.
 *
 * Safe to run concurrently with decideApproval — the UPDATE narrows
 * to status='pending' only, so a row mid-decision won't be clobbered.
 */
export async function expirePending(nowOverride?: Date): Promise<ToolApproval[]> {
  const now = nowOverride ?? new Date();
  return db()
    .update(toolApprovals)
    .set({
      status: "timeout",
      decidedAt: now,
    })
    .where(
      and(
        eq(toolApprovals.status, "pending"),
        lt(toolApprovals.expiresAt, now),
      ),
    )
    .returning();
}

/**
 * R467 — luca_propose_improvement (Phase 3 of Luca-autonomy plan).
 *
 * Pure validators + handler split:
 *   - validateProposalInput(input)  — pure input validator (no I/O).
 *   - createProposal(args)          — performs the INSERT, returns
 *     {status:'ok', proposal_id, ...} or {status:'error', error:<code>}.
 *
 * This is the FIRST WRITE tool Luca gets in the autonomy plan, but it
 * writes ONLY to the proposals queue — it does NOT touch any other table,
 * does NOT trigger PRs, does NOT escalate. BOSS sees the row in
 * GET /api/luca/proposals?status=pending and decides manually.
 *
 * Classification: LOW_STAKES_WRITE. Rationale: writing a row that BOSS
 * still has to approve is itself low-stakes — the GATE is the explicit
 * decide endpoint, not the insert. Putting this through the approval
 * gate would require BOSS to approve TWICE for every change (once to
 * even let Luca file the proposal, again to apply it) — defeats the
 * point of letting Luca think out loud at all.
 *
 * Safety:
 *   1. Title length cap (200 chars; matches DB VARCHAR(200)).
 *   2. Body length cap (8000 chars; matches design budget).
 *   3. Category enum (tool|prompt|memory|process|other).
 *   4. Strip NUL bytes (would break PostgreSQL TEXT writes silently).
 *   5. Empty / whitespace-only title or body → invalid.
 *   6. Rate-limited at the dispatcher (5/h + 2/min per agent).
 */
import type { db as DbType } from "../../storage";
import { lucaProposals } from "../../../shared/schema";

export type ProposalCategory = "tool" | "prompt" | "memory" | "process" | "other";

export type ProposalErrorCode =
  | "missing_title"
  | "missing_body"
  | "title_too_long"
  | "body_too_long"
  | "invalid_category"
  | "invalid_chars"
  | "db_error";

export interface ProposalInput {
  title: string;
  body: string;
  category: ProposalCategory;
}

export interface ValidatedProposal {
  title: string;
  body: string;
  category: ProposalCategory;
}

const TITLE_MAX = 200;
const BODY_MAX = 8000;
const VALID_CATEGORIES: ReadonlySet<ProposalCategory> = new Set(["tool", "prompt", "memory", "process", "other"]);

/**
 * Pure validator. Returns {ok:true, value} on success or {ok:false, error}
 * on any rejection. Trims title (single-line). Body is left as-is so
 * markdown indentation / code fences survive.
 */
export function validateProposalInput(
  input: unknown,
): { ok: true; value: ValidatedProposal } | { ok: false; error: ProposalErrorCode } {
  if (!input || typeof input !== "object") return { ok: false, error: "missing_title" };
  const i = input as Record<string, unknown>;

  const title = typeof i.title === "string" ? i.title.trim() : "";
  if (!title) return { ok: false, error: "missing_title" };
  if (title.length > TITLE_MAX) return { ok: false, error: "title_too_long" };
  if (title.includes("\0")) return { ok: false, error: "invalid_chars" };

  const body = typeof i.body === "string" ? i.body : "";
  // Body must contain at least one non-whitespace char.
  if (!body.trim()) return { ok: false, error: "missing_body" };
  if (body.length > BODY_MAX) return { ok: false, error: "body_too_long" };
  if (body.includes("\0")) return { ok: false, error: "invalid_chars" };

  const category = typeof i.category === "string" ? i.category : "";
  if (!VALID_CATEGORIES.has(category as ProposalCategory)) {
    return { ok: false, error: "invalid_category" };
  }

  return {
    ok: true,
    value: {
      title,
      body,
      category: category as ProposalCategory,
    },
  };
}

export interface CreateProposalArgs {
  userId: number;
  agentId: number | null;
  input: unknown;
  /** Override db handle for testing. */
  dbImpl?: typeof DbType;
}

export type CreateProposalResult =
  | { status: "ok"; proposal_id: number; title: string; category: ProposalCategory; created_at: string }
  | { status: "error"; error: ProposalErrorCode; error_detail?: string };

/**
 * Validates the input, INSERTs the proposal with status='pending', returns
 * the new id + truncated title for confirmation. Fail-closed: any DB
 * error is reported as 'db_error' with a short detail (no stack trace).
 */
export async function createProposal(args: CreateProposalArgs): Promise<CreateProposalResult> {
  const v = validateProposalInput(args.input);
  if (!v.ok) return { status: "error", error: v.error };

  const dbHandle = args.dbImpl ?? (await import("../../storage")).db;

  try {
    const rows = await dbHandle
      .insert(lucaProposals)
      .values({
        userId: args.userId,
        agentId: args.agentId ?? null,
        title: v.value.title,
        body: v.value.body,
        category: v.value.category,
        // status defaults to 'pending' at the DB level — pass undefined.
      })
      .returning({
        id: lucaProposals.id,
        title: lucaProposals.title,
        category: lucaProposals.category,
        createdAt: lucaProposals.createdAt,
      });

    const row = rows[0];
    if (!row) {
      return { status: "error", error: "db_error", error_detail: "no_returning_row" };
    }
    return {
      status: "ok",
      proposal_id: row.id,
      title: row.title,
      category: row.category as ProposalCategory,
      created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    };
  } catch (e: any) {
    return {
      status: "error",
      error: "db_error",
      error_detail: (e?.message ?? String(e)).slice(0, 240),
    };
  }
}

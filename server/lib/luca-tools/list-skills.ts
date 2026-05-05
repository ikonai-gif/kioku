/**
 * R470 — luca_list_skills (Phase 3.7 of Luca-autonomy plan).
 *
 * Pure validators + handler split, mirroring propose-improvement.ts:
 *   - validateListSkillsInput(input)  — pure input validator (no I/O).
 *   - listSkills(args)                — performs the SELECT, returns
 *     {status:'ok', count, skills:[{name, category, description}, ...]}
 *     or {status:'error', error:<code>}.
 *
 * READ_ONLY. Never returns prompt_template (callers use luca_get_skill
 * by name to fetch the full recipe). This keeps token usage bounded
 * when Luca is just browsing what skills exist.
 *
 * Optional `category` filter. Empty / missing → list all categories.
 *
 * Safety:
 *   1. Category length cap (32 chars; matches DB VARCHAR(32)).
 *   2. Strip NUL bytes (would silently break PostgreSQL TEXT comparison).
 *   3. Hard cap of 200 rows returned (defensive — manual seeding bounds
 *      this to ~100 in practice but the cap protects against a future
 *      INSERT path or accidental seed loop).
 *   4. Rate-limited at the dispatcher (20/h + 5/min per agent).
 */
import type { db as DbType } from "../../storage";
import { lucaSkills } from "../../../shared/schema";
import { eq, asc } from "drizzle-orm";

export type ListSkillsErrorCode =
  | "category_too_long"
  | "invalid_chars"
  | "db_error";

export interface ListSkillsInput {
  category?: string;
}

export interface ValidatedListSkillsInput {
  category: string | null;
}

const CATEGORY_MAX = 32;
const ROW_CAP = 200;

/**
 * Pure validator. Returns {ok:true, value} on success or {ok:false, error}
 * on rejection. `category` is optional; empty / whitespace → null (no filter).
 */
export function validateListSkillsInput(
  input: unknown,
): { ok: true; value: ValidatedListSkillsInput } | { ok: false; error: ListSkillsErrorCode } {
  // null / undefined / non-object → treat as no-args (no filter).
  if (input === null || input === undefined) {
    return { ok: true, value: { category: null } };
  }
  if (typeof input !== "object") {
    return { ok: true, value: { category: null } };
  }
  const i = input as Record<string, unknown>;

  if (i.category === undefined || i.category === null) {
    return { ok: true, value: { category: null } };
  }
  if (typeof i.category !== "string") {
    // Non-string category: treat as missing rather than hard-error.
    // Schema-validated callers never hit this; defensive only.
    return { ok: true, value: { category: null } };
  }
  const trimmed = i.category.trim();
  if (!trimmed) return { ok: true, value: { category: null } };
  if (trimmed.length > CATEGORY_MAX) return { ok: false, error: "category_too_long" };
  if (trimmed.includes("\0")) return { ok: false, error: "invalid_chars" };

  return { ok: true, value: { category: trimmed } };
}

export interface ListSkillsArgs {
  input: unknown;
  /** Override db handle for testing. */
  dbImpl?: typeof DbType;
}

export interface SkillSummary {
  name: string;
  category: string;
  description: string;
}

export type ListSkillsResult =
  | { status: "ok"; count: number; skills: SkillSummary[] }
  | { status: "error"; error: ListSkillsErrorCode; error_detail?: string };

/**
 * Validates input, runs the SELECT, returns trimmed summary rows.
 * Does NOT include prompt_template — callers fetch full recipes via
 * luca_get_skill by name.
 */
export async function listSkills(args: ListSkillsArgs): Promise<ListSkillsResult> {
  const v = validateListSkillsInput(args.input);
  if (!v.ok) return { status: "error", error: v.error };

  const dbHandle = args.dbImpl ?? (await import("../../storage")).db;

  try {
    const baseQuery = dbHandle
      .select({
        name: lucaSkills.name,
        category: lucaSkills.category,
        description: lucaSkills.description,
      })
      .from(lucaSkills);

    const filtered = v.value.category
      ? baseQuery.where(eq(lucaSkills.category, v.value.category))
      : baseQuery;

    const rows = await filtered.orderBy(asc(lucaSkills.category), asc(lucaSkills.name)).limit(ROW_CAP);

    return {
      status: "ok",
      count: rows.length,
      skills: rows.map((r: any) => ({
        name: String(r.name),
        category: String(r.category),
        description: String(r.description),
      })),
    };
  } catch (e: any) {
    return {
      status: "error",
      error: "db_error",
      error_detail: (e?.message ?? String(e)).slice(0, 240),
    };
  }
}

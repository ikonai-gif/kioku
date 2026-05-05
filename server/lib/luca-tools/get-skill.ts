/**
 * R470 — luca_get_skill (Phase 3.7 of Luca-autonomy plan).
 *
 * Pure validators + handler split, mirroring propose-improvement.ts:
 *   - validateGetSkillInput(input)  — pure input validator (no I/O).
 *   - getSkill(args)                — performs the SELECT, returns
 *     {status:'ok', name, category, description, prompt_template, created_at}
 *     or {status:'error', error:<code>}.
 *
 * READ_ONLY. Looks up exactly one row by exact `name` (UNIQUE column).
 * Returns full prompt_template — this is the point of the tool. Bounded
 * by the 8000-char body cap enforced at insert time (Boss-side seeding).
 *
 * Safety:
 *   1. Name length cap (64 chars; matches DB VARCHAR(64)).
 *   2. Strip NUL bytes.
 *   3. Empty / whitespace-only name → invalid.
 *   4. Rate-limited at the dispatcher (20/h + 5/min per agent).
 *   5. not_found is a normal result (status:'error', error:'not_found') —
 *      never throws. Callers can branch on this without try/catch.
 */
import type { db as DbType } from "../../storage";
import { lucaSkills } from "../../../shared/schema";
import { eq } from "drizzle-orm";

export type GetSkillErrorCode =
  | "missing_name"
  | "name_too_long"
  | "invalid_chars"
  | "not_found"
  | "db_error";

export interface GetSkillInput {
  name: string;
}

export interface ValidatedGetSkillInput {
  name: string;
}

const NAME_MAX = 64;

/**
 * Pure validator. Returns {ok:true, value} on success or {ok:false, error}
 * on any rejection.
 */
export function validateGetSkillInput(
  input: unknown,
): { ok: true; value: ValidatedGetSkillInput } | { ok: false; error: GetSkillErrorCode } {
  if (!input || typeof input !== "object") return { ok: false, error: "missing_name" };
  const i = input as Record<string, unknown>;

  const name = typeof i.name === "string" ? i.name.trim() : "";
  if (!name) return { ok: false, error: "missing_name" };
  if (name.length > NAME_MAX) return { ok: false, error: "name_too_long" };
  if (name.includes("\0")) return { ok: false, error: "invalid_chars" };

  return { ok: true, value: { name } };
}

export interface GetSkillArgs {
  input: unknown;
  /** Override db handle for testing. */
  dbImpl?: typeof DbType;
}

export type GetSkillResult =
  | {
      status: "ok";
      name: string;
      category: string;
      description: string;
      prompt_template: string;
      created_at: string;
    }
  | { status: "error"; error: GetSkillErrorCode; error_detail?: string };

/**
 * Validates input, fetches one skill row by exact name. Returns the
 * full prompt_template + metadata. not_found is a normal error code
 * (no throw).
 */
export async function getSkill(args: GetSkillArgs): Promise<GetSkillResult> {
  const v = validateGetSkillInput(args.input);
  if (!v.ok) return { status: "error", error: v.error };

  const dbHandle = args.dbImpl ?? (await import("../../storage")).db;

  try {
    const rows = await dbHandle
      .select({
        name: lucaSkills.name,
        category: lucaSkills.category,
        description: lucaSkills.description,
        promptTemplate: lucaSkills.promptTemplate,
        createdAt: lucaSkills.createdAt,
      })
      .from(lucaSkills)
      .where(eq(lucaSkills.name, v.value.name))
      .limit(1);

    const row: any = rows[0];
    if (!row) return { status: "error", error: "not_found" };

    return {
      status: "ok",
      name: String(row.name),
      category: String(row.category),
      description: String(row.description),
      prompt_template: String(row.promptTemplate),
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

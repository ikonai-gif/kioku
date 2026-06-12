/**
 * [LUCA-089] Skills PR1 — flag-gated auto-skill detector.
 *
 * When the same tool completes >= threshold times for a user/agent inside a
 * 7-day window (counted from tool_activity_log, created_at is BIGINT ms), a
 * pending skill row is inserted with auto_created=TRUE for Boss review.
 * Everything sits behind LUCA_SKILLS_AUTO_CREATE (default OFF) — zero
 * behavior change until BOSS flips it. Dedup is by name (auto_<tool>, sliced
 * to the VARCHAR(64) budget) via ON CONFLICT DO NOTHING plus a tool_sequence
 * containment check.
 *
 * SPEC DEVIATIONS from LUCA-089 (flagged in MEETING_ROOM):
 * - hook lives in deliberation.ts next to the R465 audit calls, not inside
 *   recordToolActivityEnd (its params carry no userId/agentId/tool);
 * - tool_sequence is TEXT — the containment check casts ::jsonb;
 * - skill name is auto_<tool> (stable, dedupable), not auto_<tool>_<ts>
 *   which overflows VARCHAR(64) and defeats dedup;
 * - master flag default OFF (spec assumed always-on).
 */
import { pool } from "./storage";
import logger from "./logger";

const PATTERN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function skillsAutoCreateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LUCA_SKILLS_AUTO_CREATE ?? "").trim().toLowerCase() === "true";
}

export function skillAutoThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt((env.LUCA_SKILL_AUTO_THRESHOLD ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export async function checkToolPatternForSkillCreation(
  params: { userId?: number | null; agentId?: number | null; tool?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    if (!skillsAutoCreateEnabled(env)) return;
    if (!params.userId || !params.agentId || !params.tool) return;
    const windowStart = Date.now() - PATTERN_WINDOW_MS;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM tool_activity_log
       WHERE user_id = $1 AND agent_id = $2 AND tool = $3 AND status = 'done' AND created_at > $4`,
      [params.userId, params.agentId, params.tool, windowStart],
    );
    const cnt: number = rows[0]?.cnt ?? 0;
    if (cnt < skillAutoThreshold(env)) return;
    await maybeCreateSkill({ userId: params.userId, agentId: params.agentId, tool: params.tool, useCount: cnt });
  } catch (e) {
    logger.warn({ component: "skills", err: String(e) }, "[skills] pattern check failed (non-fatal)");
  }
}

export async function maybeCreateSkill(params: {
  userId: number;
  agentId: number;
  tool: string;
  useCount: number;
}): Promise<void> {
  const skillName = `auto_${params.tool}`.slice(0, 64);
  const existing = await pool.query(
    `SELECT id FROM luca_skills WHERE user_id = $1 AND auto_created = TRUE AND tool_sequence::jsonb @> $2::jsonb`,
    [params.userId, JSON.stringify([params.tool])],
  );
  if (existing.rows.length > 0) return;
  await pool.query(
    `INSERT INTO luca_skills
       (user_id, agent_id, name, category, description, prompt_template, tool_sequence, auto_created, use_count)
     VALUES ($1, $2, $3, 'auto', $4, $5, $6, TRUE, $7)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [
      params.userId,
      params.agentId,
      skillName,
      `Auto-detected skill: frequent use of ${params.tool} (${params.useCount}x in 7 days)`,
      `When asked to ${params.tool.replace(/_/g, " ")}, use this optimized approach: [TO BE REFINED BY BOSS]`,
      JSON.stringify([params.tool]),
      params.useCount,
    ],
  );
  logger.info(
    { component: "skills", userId: params.userId, tool: params.tool, useCount: params.useCount, skillName },
    "[skills] auto-created skill pending Boss review",
  );
}

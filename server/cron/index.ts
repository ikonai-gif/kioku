/**
 * Cron registry — [BRO2-A15 / LUCA-076] build order #2 PR1.
 *
 * Registers all scheduled jobs at server startup. node-cron in-process on
 * Railway (LUCA-076 §1): no extra infrastructure, zero blast radius while
 * LUCA_ROUTINES_ENABLED=false (jobs register but runMorningBrief returns
 * early). Missed runs around a deploy window are not compensated in PR1.
 */
import cron from "node-cron";
import logger from "../logger";
import { runMorningBrief, CRON1_JOB_ID } from "./morning-brief";
import { runNightlyConsolidation, CRON2_JOB_ID, consolidationEnabled } from "./consolidation";
import { CronExpressionParser } from "cron-parser";
import { pool } from "../storage";

const DEFAULT_MORNING_BRIEF_SCHEDULE = "0 9 * * *"; // 09:00 daily
const DEFAULT_CONSOLIDATION_SCHEDULE = "0 3 * * *"; // 03:00 daily (sleep-time)
const TIMEZONE = "America/Los_Angeles";

export function morningBriefSchedule(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.LUCA_CRON_MORNING_BRIEF_TIME ?? "").trim();
  if (raw && cron.validate(raw)) return raw;
  if (raw) {
    logger.warn({ component: "cron", value: raw }, "[cron] invalid LUCA_CRON_MORNING_BRIEF_TIME — using default 0 9 * * *");
  }
  return DEFAULT_MORNING_BRIEF_SCHEDULE;
}

/** Idempotent-enough for our single-boot lifecycle; called once from server/index.ts. */
export function registerCronJobs(): void {
  const schedule = morningBriefSchedule();
  cron.schedule(schedule, () => {
    runMorningBrief().catch((e) =>
      logger.error({ component: "cron", job: CRON1_JOB_ID, err: String(e) }, "[CRON-1] unhandled"),
    );
  }, { timezone: TIMEZONE });
  logger.info(
    { component: "cron", job: CRON1_JOB_ID, schedule, timezone: TIMEZONE },
    "[cron] CRON-1 morning brief registered",
  );

  // [LUCA-098 / SPEC-3b] CRON-2 — nightly sleep-time memory consolidation.
  // Registers always; runNightlyConsolidation no-ops unless MEMORY_CONSOLIDATION_ENABLED=true.
  const consolidationSchedule = DEFAULT_CONSOLIDATION_SCHEDULE;
  cron.schedule(consolidationSchedule, () => {
    runNightlyConsolidation().catch((e) =>
      logger.error({ component: "cron", job: CRON2_JOB_ID, err: String(e) }, "[CRON-2] unhandled"),
    );
  }, { timezone: TIMEZONE });
  logger.info(
    { component: "cron", job: CRON2_JOB_ID, schedule: consolidationSchedule, timezone: TIMEZONE, enabled: consolidationEnabled() },
    "[cron] CRON-2 consolidation registered",
  );

  // [LUCA-088] startup missed-run check. Delayed 30s (unref) so the initDb
  // retry loop has time to bring the pool up; a failed check is non-fatal.
  setTimeout(() => { void checkMissedMorningBrief(); }, 30_000).unref();
}

/** Window within which a missed scheduled fire is still worth flagging (mirrors the 6h rate cap). */
const MISSED_RUN_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * [LUCA-088] CRON PR2 — startup missed-run checker.
 *
 * SPEC DEVIATION (flagged to LUCA): the spec queried a scheduled_tasks table
 * that does not exist — CRON-1 lives in code. Detection instead derives the
 * previous expected fire from the live cron expression (cron-parser) and
 * checks luca_telegram_log for a delivery attempt after it. Auto-run of a
 * missed brief is gated by LUCA_CRON_RUN_MISSED_ON_STARTUP (default OFF) —
 * and even then runMorningBrief() still enforces the master flag, standing
 * telegram approval and the rate cap.
 */
export async function checkMissedMorningBrief(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<void> {
  try {
    const schedule = morningBriefSchedule(env);
    const prevFire = CronExpressionParser.parse(schedule, { tz: TIMEZONE, currentDate: new Date(now) })
      .prev()
      .getTime();
    const ageMs = now - prevFire;
    if (ageMs > MISSED_RUN_WINDOW_MS) {
      logger.info({ component: "cron", job: CRON1_JOB_ID, prevFire, ageMs }, "[cron] missed-run check: last expected fire outside window — skip");
      return;
    }
    const { rows } = await pool.query(
      `SELECT 1 FROM luca_telegram_log WHERE reason LIKE 'cron:%' || $1 || '%' AND sent_at >= to_timestamp($2 / 1000.0) LIMIT 1`,
      [CRON1_JOB_ID, prevFire],
    );
    if (rows.length > 0) {
      logger.info({ component: "cron", job: CRON1_JOB_ID }, "[cron] missed-run check: last scheduled run accounted for");
      return;
    }
    logger.warn(
      { component: "cron", job: CRON1_JOB_ID, expectedAt: new Date(prevFire).toISOString(), ageMinutes: Math.round(ageMs / 60000) },
      "[cron] STARTUP: CRON-1 missed run detected",
    );
    if ((env.LUCA_CRON_RUN_MISSED_ON_STARTUP ?? "").trim().toLowerCase() === "true") {
      logger.info({ component: "cron", job: CRON1_JOB_ID }, "[cron] running missed CRON-1 now (LUCA_CRON_RUN_MISSED_ON_STARTUP=true)");
      await runMorningBrief();
    }
  } catch (e) {
    logger.warn({ component: "cron", err: String(e) }, "[cron] missed-run check failed (non-fatal)");
  }
}

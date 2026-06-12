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

const DEFAULT_MORNING_BRIEF_SCHEDULE = "0 9 * * *"; // 09:00 daily
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
}

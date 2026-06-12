/**
 * Cron rate cap — [LUCA-076 §6]. Max one run per RATE_CAP_HOURS per job,
 * so a scheduler bug can never spam Telegram (worst case 24/cap per day).
 *
 * Primary store: Redis (key cron:<job>:last-sent). Fail-open to an
 * in-process Map when Redis is unavailable — the cap still holds within
 * a single process lifetime, which covers the runaway-loop failure mode.
 */
import { getRedisClient } from "../lib/redis";
import logger from "../logger";

const memLastSent = new Map<string, number>();

export function rateCapHours(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LUCA_CRON_RATE_CAP_HOURS ?? "6");
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * Returns true when the job is allowed to run now (and records the run);
 * false when the previous run was less than capHours ago.
 */
export async function checkAndMarkCronRun(
  jobKey: string,
  capHours: number = rateCapHours(),
  now: number = Date.now(),
): Promise<boolean> {
  const capMs = capHours * 3600_000;
  const redisKey = `cron:${jobKey}:last-sent`;
  const redis = getRedisClient();
  if (redis) {
    try {
      const prev = await redis.get(redisKey);
      if (prev && now - Number(prev) < capMs) {
        logger.warn({ component: "cron", job: jobKey, prev }, `[${jobKey}] rate cap hit — skipping run`);
        return false;
      }
      await redis.set(redisKey, String(now), "PX", capMs * 4);
      return true;
    } catch (e) {
      logger.warn({ component: "cron", job: jobKey, err: String(e) }, `[${jobKey}] redis rate cap failed — falling back to memory`);
    }
  }
  const prev = memLastSent.get(jobKey);
  if (prev !== undefined && now - prev < capMs) {
    logger.warn({ component: "cron", job: jobKey }, `[${jobKey}] rate cap hit (memory) — skipping run`);
    return false;
  }
  memLastSent.set(jobKey, now);
  return true;
}

/** Test helper. */
export function __resetCronRateLimiterForTests(): void {
  memLastSent.clear();
}

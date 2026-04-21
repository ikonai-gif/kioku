/**
 * General-purpose Redis client. For BullMQ use `server/queue.ts::getRedis()` (requires maxRetriesPerRequest: null).
 *
 * This module provides a lazy-init IORedis client with maxRetriesPerRequest: 3
 * (suitable for ordinary commands: SET/GET/SETNX, idempotency keys, etc.).
 *
 * Returns null when REDIS_URL is not set — callers must handle fail-open gracefully.
 * Do NOT throw on missing REDIS_URL here; that would break deployments without Redis.
 */
import IORedis from 'ioredis';
import logger from '../logger';

let client: IORedis | null = null;
let warnedMissing = false;  // dedup warn when REDIS_URL is unset

/**
 * Returns a shared lazy-init IORedis client for general-purpose use (non-BullMQ).
 * Returns null if REDIS_URL is not set — callers should fail-open.
 */
export function getRedisClient(): IORedis | null {
  if (client) return client;

  if (!process.env.REDIS_URL) {
    if (!warnedMissing) {
      logger.warn('[redis] REDIS_URL not set — client disabled');
      warnedMissing = true;
    }
    return null;
  }

  client = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on('error', (err) => logger.warn({ err: err.message }, '[redis] error'));

  return client;
}

/**
 * Gracefully close the Redis client (SIGTERM handler). Safe to call multiple times.
 */
export async function closeRedisClient(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[redis] error during close');
    }
    client = null;
    warnedMissing = false; // reset so a future test run / startup logs warn again if still missing
  }
}

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

/**
 * Returns a shared lazy-init IORedis client for general-purpose use (non-BullMQ).
 * Returns null if REDIS_URL is not set — callers should fail-open.
 */
export function getRedisClient(): IORedis | null {
  if (client) return client;

  if (!process.env.REDIS_URL) {
    logger.warn('[redis] REDIS_URL not set — client disabled');
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

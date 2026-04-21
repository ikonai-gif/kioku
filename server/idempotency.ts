/**
 * Redis-backed idempotency keys for BullMQ job deduplication.
 *
 * Usage pattern:
 *   Before enqueue:  claimIdempotencyKey(key) → false means duplicate, skip enqueue.
 *   Inside job:      checkIdempotency(key)     → 'done' means return stored result.
 *   After job done:  storeIdempotencyResult(key, result)
 *
 * Key format: `idem:<scope>:<sha256(sortedPayload).slice(0,16)>`
 * 64-bit collision resistance (16 hex chars × 4 bits), sufficient for <1M keys/day per scope.
 * Birthday collision probability ~1e-7 at that volume.
 *
 * Degradation: when Redis is unavailable (getRedisClient() returns null),
 * claimIdempotencyKey and checkIdempotency fail-open (return 'new' / true).
 * This is an explicit tradeoff — duplicates are preferable to total unavailability.
 * Since BullMQ also requires Redis, a Redis outage disables the queue entirely anyway.
 */
import { createHash } from 'crypto';
import { getRedisClient } from './lib/redis';
import logger from './logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** TTL for stored results (24h). Long enough for BullMQ retry windows. */
export const DEFAULT_TTL_LONG = 86400;

/** TTL for in-progress "pending" marker (60s = max expected job duration). */
export const DEFAULT_PENDING_TTL = 60;

// ── makeIdempotencyKey ────────────────────────────────────────────────────────

/**
 * Recursively sorts object keys before JSON.stringify to ensure deterministic
 * output regardless of insertion order. Arrays maintain their order (order matters).
 */
function sortedStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedStringify).join(',')}]`;
  if (typeof value === 'object') {
    const sorted = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify((value as Record<string, unknown>)[k])}`)
      .join(',');
    return `{${sorted}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hashes an arbitrary payload into a stable, scope-namespaced Redis key.
 * Uses SHA-256 truncated to 16 hex chars (64-bit collision resistance).
 *
 * Key format: `idem:<scope>:<sha256(sortedJSON).slice(0,16)>`
 */
export function makeIdempotencyKey(scope: string, payload: unknown): string {
  const serialized = sortedStringify(payload);
  const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  return `idem:${scope}:${hash}`;
}

// ── claimIdempotencyKey ───────────────────────────────────────────────────────

/**
 * Atomically claims an idempotency key before enqueuing a job.
 *
 * Returns true if this is the first claim (safe to enqueue).
 * Returns false if the key already exists (duplicate — skip enqueue).
 *
 * Fail-open: returns true with a warning when Redis is unavailable.
 * @param key       Redis key (e.g. from makeIdempotencyKey)
 * @param ttlSeconds TTL in seconds (default: DEFAULT_TTL_LONG = 24h)
 */
export async function claimIdempotencyKey(
  key: string,
  ttlSeconds: number = DEFAULT_TTL_LONG,
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn({ key }, '[idempotency] Redis unavailable — fail-open on claimIdempotencyKey');
    return true;
  }

  // SET key "pending" NX EX ttl — atomic claim
  const result = await redis.set(key, 'pending', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

// ── checkIdempotency ──────────────────────────────────────────────────────────

export type IdempotencyStatus<T> =
  | { status: 'new' }
  | { status: 'in_progress' }
  | { status: 'done'; result: T };

/**
 * Inside a job: checks if this logical unit was already processed.
 *
 * Four branches:
 *   1. Key not found    → SET "pending" NX EX pendingTtl → return { status: 'new' }
 *   2. Key = "pending" with live TTL → return { status: 'in_progress' } (another instance working)
 *   3. Key = "pending" with TTL <= 0 (expired/missing TTL) → overwrite + return { status: 'new' } (crashed job, retry allowed)
 *   4. Key contains JSON result → return { status: 'done', result }
 *
 * "pending" detection: exact string match `"pending"` (stored results are JSON, which is never
 * the bare string `pending` without quotes unless explicitly stored so).
 *
 * Fail-open: returns { status: 'new' } with a warning when Redis is unavailable.
 *
 * @param key         Redis key
 * @param ttlSeconds  TTL for stored result (default: DEFAULT_TTL_LONG = 24h)
 * @param pendingTtl  TTL for in-progress marker (default: DEFAULT_PENDING_TTL = 60s)
 */
export async function checkIdempotency<T>(
  key: string,
  ttlSeconds: number = DEFAULT_TTL_LONG,
  pendingTtl: number = DEFAULT_PENDING_TTL,
): Promise<IdempotencyStatus<T>> {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn({ key }, '[idempotency] Redis unavailable — fail-open on checkIdempotency');
    return { status: 'new' };
  }

  const value = await redis.get(key);

  if (value === null) {
    // Branch 1: key not found — first time seeing this job
    await redis.set(key, 'pending', 'EX', pendingTtl);
    return { status: 'new' };
  }

  if (value === 'pending') {
    // Check remaining TTL to distinguish live vs. abandoned
    const ttl = await redis.ttl(key);
    if (ttl > 0) {
      // Branch 2: another instance is actively working on this
      return { status: 'in_progress' };
    }
    // Branch 3: TTL = 0 or -1 (expired or no expiry) → job crashed, allow retry
    // Overwrite with a fresh pending marker
    await redis.set(key, 'pending', 'EX', pendingTtl);
    return { status: 'new' };
  }

  // Branch 4: stored result — parse and return
  try {
    const result = JSON.parse(value) as T;
    return { status: 'done', result };
  } catch {
    // Corrupt entry — treat as new and overwrite
    logger.warn({ key, value }, '[idempotency] corrupt stored value, resetting');
    await redis.set(key, 'pending', 'EX', pendingTtl);
    return { status: 'new' };
  }
}

// ── storeIdempotencyResult ────────────────────────────────────────────────────

/**
 * After a job completes successfully: stores the result so subsequent duplicate
 * retries (within ttlSeconds) can return the cached result instead of re-running.
 *
 * Overwrites any "pending" marker with the final JSON-encoded result.
 * No-op when Redis is unavailable (fail-open).
 *
 * @param key        Redis key
 * @param result     Serializable result value
 * @param ttlSeconds TTL in seconds (default: DEFAULT_TTL_LONG = 24h)
 */
export async function storeIdempotencyResult<T>(
  key: string,
  result: T,
  ttlSeconds: number = DEFAULT_TTL_LONG,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn({ key }, '[idempotency] Redis unavailable — cannot store idempotency result');
    return;
  }

  await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
}

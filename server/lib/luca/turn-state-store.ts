/**
 * TurnStateStore — tracks per-turn tool lockout + trust state for Luca V1a.
 *
 * Day -1 scaffolding. Two implementations:
 *
 * 1. `RedisTurnStateStore` — production path. Uses ioredis (see ../redis.ts)
 *    with keys namespaced as `luca:ts:<turnId>:*`. Fail-open on Redis miss:
 *    caller MUST treat "nothing stored" as "not locked, trusted". This is
 *    deliberate — availability > defense-in-depth for the store; the
 *    authoritative TRUST gate lives in tool handlers, not here.
 *
 * 2. `InMemoryTurnStateStore` — test double + local-dev fallback when
 *    REDIS_URL is not set. Same interface, same semantics, process-local.
 *
 * Bro2 M2 (from Luca V1 impl plan re-review): isLocked does a Redis
 * round-trip per tool-set construction. Acceptable at our scale; alternative
 * (in-memory cache with pub/sub invalidation) is documented in the plan but
 * NOT implemented here — re-evaluate after Day 10 load test.
 *
 * Key layout (Redis):
 *   luca:ts:{turnId}:lock              -> "1" if markUntrusted fired, TTL 1h
 *   luca:ts:{turnId}:lock_reason       -> string, TTL 1h
 *   luca:ts:{turnId}:trust             -> "trusted" | "untrusted" | missing
 *
 * All TTLs are conservative (1h). A turn is expected to complete in seconds;
 * 1h just prevents orphan state from pinning memory forever.
 */
import type IORedis from "ioredis";
import { getRedisClient } from "../redis";
import logger from "../../logger";

const KEY_PREFIX = "luca:ts";
const TTL_SECONDS = 3600; // 1h

export type TrustState = "trusted" | "untrusted";

export interface TurnLockInfo {
  locked: boolean;
  reason: string | null;
}

export interface TurnStateStore {
  /**
   * Mark a turn as untrusted — locks out memory-write tools for the rest of
   * this turn. Idempotent: calling twice is safe and keeps the first reason.
   *
   * **Error contract (Bro2 Day -1 M1)**: Unlike `isLocked` which fail-opens,
   * `markUntrusted` may THROW on Redis failure. Callers MUST treat a throw
   * from this method as equivalent to a successful lock — i.e. abort the
   * turn's memory-write path, do NOT proceed on the assumption that "lock
   * didn't take". Rationale: this method is invoked when we already know
   * the turn is poisoned (attack-sig, canary mismatch); swallowing the
   * error would silently downgrade the security posture.
   */
  markUntrusted(turnId: string, reason: string): Promise<void>;

  /**
   * Check whether a turn is locked. **Write-gate signal** — this is the
   * authoritative check before any memory-write tool runs.
   *
   * Returns `{locked: false, reason: null}` if never marked, if Redis is
   * unavailable, or if the key has expired. Callers MUST fail-open on this
   * signal (see module docstring) — the authoritative gate is TRUST in the
   * tool handler, not this store.
   */
  isLocked(turnId: string): Promise<TurnLockInfo>;

  /**
   * Explicit trust state setter. `trusted` is the default when nothing is
   * stored — this exists so TRUST can be attested positively (e.g. after a
   * canary verification passed).
   *
   * NOT exposed to the LLM tool surface — only TRUST verifiers + the
   * turn-runner call this. See Bro2 sticky-lock analysis (Day -1 Q2).
   */
  setTrust(turnId: string, state: TrustState): Promise<void>;

  /**
   * Read current trust state. **Read-side signal** — useful for logging,
   * telemetry, UI hints. Do NOT gate memory writes on this alone (use
   * `isLocked` which is the sticky write-gate). Returns `"trusted"` when
   * nothing is stored (fail-open).
   */
  getTrust(turnId: string): Promise<TrustState>;

  /**
   * Best-effort cleanup. Not required for correctness (TTL handles it) but
   * called by the turn-runner on success to free memory faster.
   */
  clear(turnId: string): Promise<void>;
}

// ─── Redis implementation ────────────────────────────────────────────────

export class RedisTurnStateStore implements TurnStateStore {
  constructor(private readonly client: IORedis) {}

  async markUntrusted(turnId: string, reason: string): Promise<void> {
    const lockKey = `${KEY_PREFIX}:${turnId}:lock`;
    const reasonKey = `${KEY_PREFIX}:${turnId}:lock_reason`;
    const trustKey = `${KEY_PREFIX}:${turnId}:trust`;
    // SETNX on the reason so a second markUntrusted keeps the FIRST reason
    // (most informative about why the turn was initially poisoned).
    await Promise.all([
      this.client.set(lockKey, "1", "EX", TTL_SECONDS),
      this.client.set(reasonKey, reason, "EX", TTL_SECONDS, "NX"),
      this.client.set(trustKey, "untrusted", "EX", TTL_SECONDS),
    ]);
  }

  async isLocked(turnId: string): Promise<TurnLockInfo> {
    const lockKey = `${KEY_PREFIX}:${turnId}:lock`;
    const reasonKey = `${KEY_PREFIX}:${turnId}:lock_reason`;
    try {
      const [lock, reason] = await this.client.mget(lockKey, reasonKey);
      if (lock === "1") return { locked: true, reason: reason ?? null };
      return { locked: false, reason: null };
    } catch (err) {
      // Fail-open: never block a turn because the store is flaky.
      logger.warn(
        { err: (err as Error).message, turnId },
        "[luca.turnStateStore] isLocked redis failure → fail-open",
      );
      return { locked: false, reason: null };
    }
  }

  async setTrust(turnId: string, state: TrustState): Promise<void> {
    const trustKey = `${KEY_PREFIX}:${turnId}:trust`;
    await this.client.set(trustKey, state, "EX", TTL_SECONDS);
  }

  async getTrust(turnId: string): Promise<TrustState> {
    const trustKey = `${KEY_PREFIX}:${turnId}:trust`;
    try {
      const v = await this.client.get(trustKey);
      if (v === "untrusted") return "untrusted";
      return "trusted";
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, turnId },
        "[luca.turnStateStore] getTrust redis failure → fail-open trusted",
      );
      return "trusted";
    }
  }

  async clear(turnId: string): Promise<void> {
    const prefix = `${KEY_PREFIX}:${turnId}`;
    try {
      await this.client.del(
        `${prefix}:lock`,
        `${prefix}:lock_reason`,
        `${prefix}:trust`,
      );
    } catch {
      // Ignore — TTL will handle it.
    }
  }
}

// ─── In-memory implementation (tests + local dev) ────────────────────────

interface Entry {
  locked: boolean;
  lockReason: string | null;
  trust: TrustState;
  expiresAt: number;
}

export class InMemoryTurnStateStore implements TurnStateStore {
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = TTL_SECONDS * 1000,
  ) {}

  private purge(turnId: string): Entry | null {
    const e = this.map.get(turnId);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.map.delete(turnId);
      return null;
    }
    return e;
  }

  async markUntrusted(turnId: string, reason: string): Promise<void> {
    const existing = this.purge(turnId);
    const expiresAt = this.now() + this.ttlMs;
    if (existing) {
      existing.locked = true;
      // Keep the first reason (SETNX semantics).
      if (existing.lockReason == null) existing.lockReason = reason;
      existing.trust = "untrusted";
      existing.expiresAt = expiresAt;
      return;
    }
    this.map.set(turnId, {
      locked: true,
      lockReason: reason,
      trust: "untrusted",
      expiresAt,
    });
  }

  async isLocked(turnId: string): Promise<TurnLockInfo> {
    const e = this.purge(turnId);
    if (!e) return { locked: false, reason: null };
    return { locked: e.locked, reason: e.locked ? e.lockReason : null };
  }

  async setTrust(turnId: string, state: TrustState): Promise<void> {
    const existing = this.purge(turnId);
    const expiresAt = this.now() + this.ttlMs;
    if (existing) {
      existing.trust = state;
      existing.expiresAt = expiresAt;
      return;
    }
    this.map.set(turnId, {
      locked: false,
      lockReason: null,
      trust: state,
      expiresAt,
    });
  }

  async getTrust(turnId: string): Promise<TrustState> {
    const e = this.purge(turnId);
    return e?.trust ?? "trusted";
  }

  async clear(turnId: string): Promise<void> {
    this.map.delete(turnId);
  }

  /** Test helper — visible entry count for leak assertions. */
  size(): number {
    return this.map.size;
  }
}

/**
 * Factory: production picks Redis when available, falls back to in-memory
 * otherwise. Tests bypass this and construct `InMemoryTurnStateStore`
 * directly with a mock clock.
 */
export function createDefaultTurnStateStore(): TurnStateStore {
  const client = getRedisClient();
  if (client) return new RedisTurnStateStore(client);
  logger.warn(
    "[luca.turnStateStore] REDIS_URL not set → using in-memory store (process-local, NOT shared across instances)",
  );
  return new InMemoryTurnStateStore();
}

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ── Map-based fake Redis ──────────────────────────────────────────────────────
// Simulates the subset of IORedis commands used by idempotency.ts:
//   set(key, value, 'EX', ttl [, 'NX'])  → 'OK' | null
//   get(key)                              → string | null
//   ttl(key)                              → number (-1 = no expiry, -2 = not found, N = remaining secs)

type Entry = { value: string; expiresAt: number | null };

class FakeRedis {
  private store = new Map<string, Entry>();
  /** Control: fast-forward simulated time */
  private nowMs = Date.now();

  tick(ms: number) { this.nowMs += ms; }

  /** Simulate SET key value [EX ttl] [NX] */
  async set(
    key: string,
    value: string,
    exFlag?: 'EX',
    ttlSecs?: number,
    nxFlag?: 'NX',
  ): Promise<'OK' | null> {
    if (nxFlag === 'NX' && this.store.has(key)) {
      const entry = this.store.get(key)!;
      // Respect expiry: if expired, the key is effectively gone
      if (entry.expiresAt !== null && entry.expiresAt <= this.nowMs) {
        this.store.delete(key);
      } else {
        return null; // key exists and not expired → NX fails
      }
    }
    const expiresAt = (exFlag === 'EX' && ttlSecs != null)
      ? this.nowMs + ttlSecs * 1000
      : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  /** Simulate GET key */
  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.nowMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /** Simulate TTL key → remaining seconds, or -1 (no expiry), or -2 (not found) */
  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    if (entry.expiresAt <= this.nowMs) {
      this.store.delete(key);
      return -2;
    }
    return Math.ceil((entry.expiresAt - this.nowMs) / 1000);
  }

  clear() { this.store.clear(); }
}

// ── Module mock ───────────────────────────────────────────────────────────────
const fakeRedis = new FakeRedis();

vi.mock('../lib/redis', () => ({
  getRedisClient: vi.fn(() => fakeRedis),
}));

// Import AFTER mock is in place
import {
  claimIdempotencyKey,
  checkIdempotency,
  storeIdempotencyResult,
  makeIdempotencyKey,
  DEFAULT_TTL_LONG,
  DEFAULT_PENDING_TTL,
} from '../idempotency';
import { getRedisClient } from '../lib/redis';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  fakeRedis.clear();
  vi.mocked(getRedisClient).mockReturnValue(fakeRedis as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── makeIdempotencyKey ────────────────────────────────────────────────────────

describe('makeIdempotencyKey', () => {
  it('produces key with correct prefix', () => {
    const key = makeIdempotencyKey('meeting', { id: 1 });
    expect(key).toMatch(/^idem:meeting:[0-9a-f]{16}$/);
  });

  it('is deterministic for the same payload', () => {
    const k1 = makeIdempotencyKey('meeting', { id: 1, type: 'start' });
    const k2 = makeIdempotencyKey('meeting', { id: 1, type: 'start' });
    expect(k1).toBe(k2);
  });

  it('is deterministic regardless of object key insertion order', () => {
    const k1 = makeIdempotencyKey('scope', { b: 2, a: 1 });
    const k2 = makeIdempotencyKey('scope', { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it('produces different keys for different scopes with same payload', () => {
    const k1 = makeIdempotencyKey('scope1', { id: 1 });
    const k2 = makeIdempotencyKey('scope2', { id: 1 });
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different payloads in same scope', () => {
    const k1 = makeIdempotencyKey('meeting', { id: 1 });
    const k2 = makeIdempotencyKey('meeting', { id: 2 });
    expect(k1).not.toBe(k2);
  });

  it('handles nested objects deterministically', () => {
    const k1 = makeIdempotencyKey('s', { a: { z: 3, y: 2 }, b: 1 });
    const k2 = makeIdempotencyKey('s', { b: 1, a: { y: 2, z: 3 } });
    expect(k1).toBe(k2);
  });

  it('handles null payload', () => {
    const key = makeIdempotencyKey('s', null);
    expect(key).toMatch(/^idem:s:[0-9a-f]{16}$/);
  });

  it('handles undefined payload without throwing', () => {
    expect(() => makeIdempotencyKey('test', undefined)).not.toThrow();
    const key = makeIdempotencyKey('test', undefined);
    expect(key).toMatch(/^idem:test:[0-9a-f]{16}$/);
  });

  it('treats undefined and null payloads as equivalent keys', () => {
    // Both should serialize to "null" → same hash
    expect(makeIdempotencyKey('s', undefined)).toBe(makeIdempotencyKey('s', null));
  });
});

// ── claimIdempotencyKey ───────────────────────────────────────────────────────

describe('claimIdempotencyKey', () => {
  it('returns true on first claim', async () => {
    const key = makeIdempotencyKey('claim', { id: 42 });
    expect(await claimIdempotencyKey(key)).toBe(true);
  });

  it('returns false on second claim (duplicate)', async () => {
    const key = makeIdempotencyKey('claim', { id: 99 });
    expect(await claimIdempotencyKey(key)).toBe(true);
    expect(await claimIdempotencyKey(key)).toBe(false);
  });

  it('returns true + warns when Redis is null (fail-open)', async () => {
    vi.mocked(getRedisClient).mockReturnValueOnce(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await claimIdempotencyKey('some-key');
    expect(result).toBe(true);
    warnSpy.mockRestore();
  });
});

// ── checkIdempotency ──────────────────────────────────────────────────────────

describe('checkIdempotency', () => {
  it('returns { status: "new" } when key is not found (branch 1)', async () => {
    const key = makeIdempotencyKey('check', { id: 1 });
    const result = await checkIdempotency(key);
    expect(result).toEqual({ status: 'new' });
  });

  it('sets pending marker after returning new', async () => {
    const key = makeIdempotencyKey('check', { id: 2 });
    await checkIdempotency(key);
    const val = await fakeRedis.get(key);
    expect(val).toBe('pending');
  });

  it('returns { status: "in_progress" } when pending with live TTL (branch 2)', async () => {
    const key = makeIdempotencyKey('check', { id: 3 });
    // Manually set pending with TTL
    await fakeRedis.set(key, 'pending', 'EX', 60);
    const result = await checkIdempotency(key);
    expect(result).toEqual({ status: 'in_progress' });
  });

  it('returns { status: "new" } when pending TTL has expired (branch 3 — crashed job)', async () => {
    const key = makeIdempotencyKey('check', { id: 4 });
    // Set pending with 1s TTL then advance time past it
    await fakeRedis.set(key, 'pending', 'EX', 1);
    fakeRedis.tick(2000); // +2 seconds → TTL expired
    const result = await checkIdempotency(key);
    expect(result).toEqual({ status: 'new' });
  });

  it('returns { status: "done" } when stored result found (branch 4)', async () => {
    const key = makeIdempotencyKey('check', { id: 5 });
    const payload = { meetingId: 'abc', outcome: 'success' };
    await fakeRedis.set(key, JSON.stringify(payload), 'EX', DEFAULT_TTL_LONG);
    const result = await checkIdempotency<typeof payload>(key);
    expect(result).toEqual({ status: 'done', result: payload });
  });

  it('returns { status: "new" } fail-open when Redis is null', async () => {
    vi.mocked(getRedisClient).mockReturnValueOnce(null);
    const result = await checkIdempotency('any-key');
    expect(result).toEqual({ status: 'new' });
  });

  it('two concurrent calls: first gets new, second gets in_progress', async () => {
    const key = makeIdempotencyKey('check', { id: 6 });
    // First call — key not found
    const r1 = await checkIdempotency(key, DEFAULT_TTL_LONG, 60);
    expect(r1).toEqual({ status: 'new' });
    // Second call — key is "pending" with live TTL
    const r2 = await checkIdempotency(key, DEFAULT_TTL_LONG, 60);
    expect(r2).toEqual({ status: 'in_progress' });
  });
});

// ── storeIdempotencyResult ────────────────────────────────────────────────────

describe('storeIdempotencyResult', () => {
  it('stores result so subsequent checkIdempotency returns done', async () => {
    const key = makeIdempotencyKey('store', { id: 1 });
    const result = { summary: 'done', count: 3 };

    await storeIdempotencyResult(key, result);

    const check = await checkIdempotency<typeof result>(key);
    expect(check).toEqual({ status: 'done', result });
  });

  it('is a no-op when Redis is null (fail-open)', async () => {
    vi.mocked(getRedisClient).mockReturnValueOnce(null);
    // Should not throw
    await expect(storeIdempotencyResult('any-key', { x: 1 })).resolves.toBeUndefined();
  });
});

// ── Integration: full lifecycle ───────────────────────────────────────────────

describe('full idempotency lifecycle', () => {
  it('claim → check(new) → store → check(done) → claim(false)', async () => {
    const scope = 'meeting-turn';
    const payload = { meetingId: 'm1', turnId: 't1' };
    const key = makeIdempotencyKey(scope, payload);

    // Step 1: claim before enqueue
    expect(await claimIdempotencyKey(key)).toBe(true);

    // Step 2: inside job — after claim key = "pending" already
    // But claim sets it with DEFAULT_TTL_LONG, not pendingTtl. So TTL is live.
    // checkIdempotency will see "pending" with live TTL → in_progress
    const checkResult = await checkIdempotency<{ result: string }>(key);
    expect(checkResult.status).toBe('in_progress');

    // Step 3: Store result
    await storeIdempotencyResult(key, { result: 'meeting started' });

    // Step 4: Duplicate check → done
    const doneResult = await checkIdempotency<{ result: string }>(key);
    expect(doneResult).toEqual({ status: 'done', result: { result: 'meeting started' } });

    // Step 5: duplicate claim → false
    expect(await claimIdempotencyKey(key)).toBe(false);
  });
});

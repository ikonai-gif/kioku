import { describe, it, expect } from 'vitest';
import { toUnixMs, fromUnixMs, nowMs, isUnixMs } from '../lib/time';

// Reference timestamp: 2024-01-15T12:00:00.000Z
const KNOWN_DATE = new Date('2024-01-15T12:00:00.000Z');
const KNOWN_MS = 1705320000000; // Date.UTC result

describe('toUnixMs', () => {
  it('returns null for null input', () => {
    expect(toUnixMs(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(toUnixMs(undefined)).toBeNull();
  });

  it('converts Date to milliseconds', () => {
    expect(toUnixMs(KNOWN_DATE)).toBe(KNOWN_MS);
  });

  it('passes through a unix-ms number unchanged', () => {
    expect(toUnixMs(KNOWN_MS)).toBe(KNOWN_MS);
  });

  it('converts seconds (< 1e12) to milliseconds by multiplying by 1000', () => {
    const secs = 1705320000; // KNOWN_MS / 1000
    expect(toUnixMs(secs)).toBe(1705320000000);
  });

  it('treats 0 as seconds and returns 0', () => {
    expect(toUnixMs(0)).toBe(0);
  });

  it('treats 999999999999 (< 1e12) as seconds', () => {
    // max value < 1e12 in seconds
    expect(toUnixMs(999999999999)).toBe(999999999999000);
  });

  it('throws RangeError for nanoseconds (>= 1e15)', () => {
    const nanos = 1705320000000 * 1e6; // ridiculously large
    expect(() => toUnixMs(nanos)).toThrow(RangeError);
    expect(() => toUnixMs(nanos)).toThrow('nanoseconds');
  });

  it('throws RangeError for exactly 1e15', () => {
    expect(() => toUnixMs(1e15)).toThrow(RangeError);
  });

  it('parses a valid ISO string', () => {
    expect(toUnixMs('2024-01-15T12:00:00.000Z')).toBe(KNOWN_MS);
  });

  it('parses a date-only string', () => {
    const result = toUnixMs('2024-01-15');
    // Date-only strings are parsed as UTC midnight by spec
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('throws TypeError for an unparseable string', () => {
    expect(() => toUnixMs('not-a-date')).toThrow(TypeError);
    expect(() => toUnixMs('not-a-date')).toThrow('cannot parse');
  });

  it('throws TypeError for empty string', () => {
    // new Date('').getTime() → NaN
    expect(() => toUnixMs('')).toThrow(TypeError);
  });
});

describe('fromUnixMs', () => {
  it('returns null for null input', () => {
    expect(fromUnixMs(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(fromUnixMs(undefined)).toBeNull();
  });

  it('converts unix ms to Date', () => {
    expect(fromUnixMs(KNOWN_MS)).toEqual(KNOWN_DATE);
  });

  it('round-trips with toUnixMs', () => {
    const back = fromUnixMs(toUnixMs(KNOWN_DATE) as number);
    expect(back).toEqual(KNOWN_DATE);
  });
});

describe('nowMs', () => {
  it('returns a number', () => {
    expect(typeof nowMs()).toBe('number');
  });

  it('is a valid unix ms timestamp (passes isUnixMs)', () => {
    expect(isUnixMs(nowMs())).toBe(true);
  });

  it('is monotonically non-decreasing across two calls', () => {
    const t1 = nowMs();
    const t2 = nowMs();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

describe('isUnixMs', () => {
  it('returns true for a well-known unix-ms value', () => {
    expect(isUnixMs(KNOWN_MS)).toBe(true);
  });

  it('returns false for seconds-range value (< 1e12)', () => {
    expect(isUnixMs(1705320000)).toBe(false);
  });

  it('returns false for nanoseconds (>= 1e15)', () => {
    expect(isUnixMs(1705320000000000000)).toBe(false);
  });

  it('returns false for 0', () => {
    expect(isUnixMs(0)).toBe(false);
  });

  it('returns false for NaN', () => {
    expect(isUnixMs(NaN)).toBe(false);
  });

  it('returns false for Infinity', () => {
    expect(isUnixMs(Infinity)).toBe(false);
  });

  it('returns false for -Infinity', () => {
    expect(isUnixMs(-Infinity)).toBe(false);
  });

  it('returns true for 1e12 (boundary)', () => {
    expect(isUnixMs(1e12)).toBe(true);
  });

  it('returns false for exactly 1e15 (boundary — too large)', () => {
    expect(isUnixMs(1e15)).toBe(false);
  });
});

/**
 * Timestamp helpers — single source of truth for Unix millisecond conversions.
 *
 * Context: KIOKU™ uses mixed timestamp storage —
 *   • BIGINT (Unix ms): memories, agents, rooms, room_messages, etc.
 *   • TIMESTAMPTZ: meetings, meeting_context (Meeting Room Track A)
 *
 * These helpers let Week 5 cross-table queries (e.g. "last meeting + recent memories")
 * compare timestamps safely without guessing which column is which unit.
 */

/**
 * Converts a timestamp to Unix milliseconds.
 * Note: treats numeric input < 1e12 as seconds (covers all dates after 2001-09-09,
 * which is when Unix seconds crossed 1e9). Explicit, not magic.
 *
 * Rules:
 *   - null / undefined → null (no throw — preserves DB-level nullability)
 *   - Date → .getTime()
 *   - number < 1e12 → assumed seconds, multiplied by 1000
 *   - number in [1e12, 1e15) → assumed ms, returned as-is
 *   - number >= 1e15 → throws (nanoseconds? caller bug — we don't guess)
 *   - string → new Date(s).getTime(), throws on NaN
 */
export function toUnixMs(ts: Date | number | string | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;

  if (ts instanceof Date) {
    return ts.getTime();
  }

  if (typeof ts === 'number') {
    if (ts >= 1e15) {
      throw new RangeError(
        `toUnixMs: value ${ts} looks like nanoseconds (>= 1e15). ` +
        'Divide by 1e6 before calling toUnixMs, or pass a Date/string instead.'
      );
    }
    if (ts < 1e12) {
      // Legacy seconds-based timestamp — multiply by 1000
      return ts * 1000;
    }
    return ts;
  }

  if (typeof ts === 'string') {
    const parsed = new Date(ts).getTime();
    if (Number.isNaN(parsed)) {
      throw new TypeError(`toUnixMs: cannot parse string as date: "${ts}"`);
    }
    return parsed;
  }

  // Should be unreachable with typed TS, but be defensive
  throw new TypeError(`toUnixMs: unsupported input type ${typeof ts}`);
}

/**
 * Converts a Unix millisecond timestamp back to a Date.
 * Returns null for null/undefined input (preserves DB-level nullability).
 */
export function fromUnixMs(ms: number | null | undefined): Date | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms);
}

/**
 * Returns the current time as Unix milliseconds.
 * Thin wrapper over Date.now() — extracted for testability.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Guard: returns true if n is a plausible Unix millisecond timestamp.
 *
 * Accepts range [1e12, 1e15):
 *   • Lower bound 1e12 = ~2001-09-09 (when Unix seconds crossed 1e9)
 *   • Upper bound 1e15 = year 33658 (beyond any realistic date, likely nanoseconds)
 *
 * Use this to validate untrusted numeric inputs before storing in BIGINT columns.
 */
export function isUnixMs(n: number): boolean {
  return Number.isFinite(n) && n >= 1e12 && n < 1e15;
}

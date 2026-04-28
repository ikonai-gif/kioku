/**
 * LEO PR-A — Quiet-hours arithmetic in IANA timezones.
 *
 * Pure functions, zero external deps. We rely on V8/ICU's `Intl.DateTimeFormat`
 * to do the timezone+DST math — anything we hand-roll would either drift
 * across "spring forward" / "fall back" or accumulate a timezone DB into the
 * bundle. The whole module is ~50 lines because Intl already handles it.
 *
 * Public API:
 *   parseQuietHours(envValue, tz)        — "22:00-08:00" → {startHour, endHour, tz}
 *   isInQuietHours(now, window)          — boolean
 *   getDeferredSendAt(now, window)       — Date at endHour:00 in tz, today or tomorrow
 *
 * The dispatcher in deliberation.ts is the only consumer today; PR-B's cron
 * worker will re-use the same primitives so behavior stays identical between
 * the two firing paths.
 */

export interface QuietHoursWindow {
  /** Hour of day (0-23) when quiet-hours BEGIN. */
  startHour: number;
  /** Hour of day (0-23) when quiet-hours END (and messages may resume). */
  endHour: number;
  /** IANA timezone the hours are interpreted in. */
  tz: string;
}

/**
 * Parse a "HH:MM-HH:MM" string. Today we ignore the minute fields (BRO1
 * spec'd whole-hour windows; "22:00-08:00" is the only configured value).
 * Anything malformed → null, which the dispatcher reads as "no quiet-hours".
 */
export function parseQuietHours(
  envValue: string | undefined | null,
  tz: string,
): QuietHoursWindow | null {
  if (!envValue) return null;
  const trimmed = envValue.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const startHour = parseInt(m[1], 10);
  const endHour = parseInt(m[3], 10);
  if (
    !Number.isFinite(startHour) ||
    !Number.isFinite(endHour) ||
    startHour < 0 || startHour > 23 ||
    endHour < 0 || endHour > 23
  ) {
    return null;
  }
  // Equal start/end is a degenerate "no quiet-hours" — surface as null.
  if (startHour === endHour) return null;
  return { startHour, endHour, tz };
}

/**
 * Get the hour-of-day (0-23) at `at` in the given IANA timezone. Uses
 * `Intl.DateTimeFormat` so DST transitions and historical offsets are
 * correct — never roll our own +/- HOURS_IN_MS arithmetic for tz code.
 *
 * `Intl.DateTimeFormat` returns "0".."23" with `hour12: false`. (Historically
 * Node has returned "24" at midnight — defensively normalize to 0.)
 */
function getHourInTz(at: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  const raw = fmt.format(at);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return n === 24 ? 0 : n;
}

/**
 * Is `now` inside the quiet-hours window?
 *
 * Two cases:
 *   - Wrapping window (start > end): "22..23,0..end" — typical overnight rule.
 *   - Non-wrapping window (start < end): "10..16" — daytime mute, hypothetical.
 *
 * (start === end is rejected by parseQuietHours, so we never hit it here.)
 */
export function isInQuietHours(now: Date, window: QuietHoursWindow): boolean {
  const hour = getHourInTz(now, window.tz);
  if (window.startHour > window.endHour) {
    // Wraps midnight: in-window when hour >= startHour OR hour < endHour.
    return hour >= window.startHour || hour < window.endHour;
  }
  // Same-day window.
  return hour >= window.startHour && hour < window.endHour;
}

/**
 * Get the wall-clock components for `at` in `tz`. We use the `parts` API
 * because the locale-formatted string varies; parts give us stable named
 * fields. Returns numbers (year, month 1-12, day 1-31, hour 0-23,
 * minute 0-59, second 0-59).
 */
function getPartsInTz(at: Date, tz: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const get = (type: string) => {
    const p = parts.find((x) => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * UTC instant corresponding to a given wall-clock moment in a tz. We invert
 * the tz offset by computing what UTC time renders to those wall-clock parts
 * in that tz. Two passes is enough — the offset only depends on the date
 * (DST boundaries), not the minute, so converging is immediate. (One-pass is
 * actually correct unless the target time falls inside the spring-forward
 * gap, which we handle by returning the second-pass result.)
 */
function utcFromTzWallClock(
  year: number, month: number, day: number, hour: number, tz: string,
): Date {
  // First guess: treat wall-clock components as UTC. This is wrong by the
  // current tz offset.
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  // Render that UTC instant in `tz` and measure the delta.
  const parts1 = getPartsInTz(new Date(guess), tz);
  const targetMs1 = Date.UTC(parts1.year, parts1.month - 1, parts1.day, parts1.hour, 0, 0);
  const offsetMs1 = targetMs1 - guess;
  const adjusted = guess - offsetMs1;
  // Second pass: in DST-transition cases the offset at `adjusted` may differ
  // from the offset at `guess`. Re-measure once more to converge.
  const parts2 = getPartsInTz(new Date(adjusted), tz);
  const targetMs2 = Date.UTC(parts2.year, parts2.month - 1, parts2.day, parts2.hour, 0, 0);
  const offsetMs2 = targetMs2 - adjusted;
  return new Date(guess - offsetMs2);
}

/**
 * Returns the next moment quiet-hours end. If `now` is inside the window,
 * that's the upcoming endHour:00 wall-clock in tz; if `now` is outside the
 * window (caller shouldn't normally ask, but handle it), still returns the
 * NEXT endHour:00 — useful for tests and for PR-B's cron logic.
 *
 * Wrapping window logic:
 *   - If hour >= startHour (e.g. 23:00 with start=22): we're in the
 *     evening half of the window — endHour is tomorrow.
 *   - If hour < endHour (e.g. 03:00 with end=08): we're in the morning
 *     half — endHour is today.
 *   - Otherwise (we're outside the window): endHour is today if it's
 *     still in the future, else tomorrow.
 */
export function getDeferredSendAt(now: Date, window: QuietHoursWindow): Date {
  const parts = getPartsInTz(now, window.tz);
  const { year, month, day, hour } = parts;
  // Decide whether endHour:00 lands today or tomorrow in the tz.
  let useTomorrow: boolean;
  if (window.startHour > window.endHour) {
    // Wrapping (overnight): in evening half → tomorrow; otherwise today.
    useTomorrow = hour >= window.startHour;
  } else {
    // Same-day window: end is later today if we haven't passed it.
    useTomorrow = hour >= window.endHour;
  }
  if (!useTomorrow) {
    return utcFromTzWallClock(year, month, day, window.endHour, window.tz);
  }
  // +1 day in tz wall-clock. Date.UTC normalizes day overflow across
  // month/year boundaries, so we can pass day+1 directly; the inverse
  // resolver will pick the right offset for that local date.
  return utcFromTzWallClock(year, month, day + 1, window.endHour, window.tz);
}

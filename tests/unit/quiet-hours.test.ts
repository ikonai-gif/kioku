/**
 * LEO PR-A — quiet-hours unit tests.
 *
 * Pure functions, no mocks needed. DST tests construct Date instances via
 * UTC strings so the test is deterministic regardless of the host's local
 * timezone.
 */
import { describe, expect, it } from "vitest";

import {
  parseQuietHours,
  isInQuietHours,
  getDeferredSendAt,
} from "../../server/lib/luca-checkin/quiet-hours";

const TZ_LA = "America/Los_Angeles";

describe("parseQuietHours", () => {
  it("parses '22:00-08:00' to {22, 8}", () => {
    expect(parseQuietHours("22:00-08:00", TZ_LA)).toEqual({
      startHour: 22,
      endHour: 8,
      tz: TZ_LA,
    });
  });

  it("returns null for null/empty", () => {
    expect(parseQuietHours(undefined, TZ_LA)).toBeNull();
    expect(parseQuietHours("", TZ_LA)).toBeNull();
    expect(parseQuietHours("   ", TZ_LA)).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseQuietHours("garbage", TZ_LA)).toBeNull();
    expect(parseQuietHours("22-08", TZ_LA)).toBeNull();
    expect(parseQuietHours("25:00-08:00", TZ_LA)).toBeNull();
    expect(parseQuietHours("22:00-30:00", TZ_LA)).toBeNull();
    expect(parseQuietHours("12:00-12:00", TZ_LA)).toBeNull();
  });

  it("accepts arbitrary same-day windows", () => {
    expect(parseQuietHours("10:00-16:00", TZ_LA)).toEqual({
      startHour: 10,
      endHour: 16,
      tz: TZ_LA,
    });
  });
});

describe("isInQuietHours — wrapping window 22:00-08:00 PT", () => {
  const w = parseQuietHours("22:00-08:00", TZ_LA)!;

  it("03:00 PT → true", () => {
    // 2026-04-23 03:00 PDT = 2026-04-23 10:00 UTC
    const d = new Date("2026-04-23T10:00:00Z");
    expect(isInQuietHours(d, w)).toBe(true);
  });

  it("09:00 PT → false", () => {
    // 2026-04-23 09:00 PDT = 2026-04-23 16:00 UTC
    const d = new Date("2026-04-23T16:00:00Z");
    expect(isInQuietHours(d, w)).toBe(false);
  });

  it("23:00 PT → true", () => {
    // 2026-04-23 23:00 PDT = 2026-04-24 06:00 UTC
    const d = new Date("2026-04-24T06:00:00Z");
    expect(isInQuietHours(d, w)).toBe(true);
  });

  it("21:00 PT → false (one hour before window)", () => {
    // 2026-04-23 21:00 PDT = 2026-04-24 04:00 UTC
    const d = new Date("2026-04-24T04:00:00Z");
    expect(isInQuietHours(d, w)).toBe(false);
  });

  it("exactly 22:00 PT → true (start of window)", () => {
    // 2026-04-23 22:00 PDT = 2026-04-24 05:00 UTC
    const d = new Date("2026-04-24T05:00:00Z");
    expect(isInQuietHours(d, w)).toBe(true);
  });

  it("exactly 08:00 PT → false (end of window, exclusive)", () => {
    // 2026-04-23 08:00 PDT = 2026-04-23 15:00 UTC
    const d = new Date("2026-04-23T15:00:00Z");
    expect(isInQuietHours(d, w)).toBe(false);
  });
});

describe("isInQuietHours — DST transitions", () => {
  const w = parseQuietHours("22:00-08:00", TZ_LA)!;

  it("spring-forward 2026: 03:00 PDT (after the 02→03 jump) is still in window", () => {
    // March 8, 2026 is the second Sunday — DST begins. 02:00 PST jumps to
    // 03:00 PDT. 03:30 PDT exists (PST didn't); UTC equivalent is 10:30Z.
    const dAfterJump = new Date("2026-03-08T10:30:00Z");
    expect(isInQuietHours(dAfterJump, w)).toBe(true);
    // 09:00 PDT after the jump = 16:00 UTC → outside window.
    const dAfterEnd = new Date("2026-03-08T16:00:00Z");
    expect(isInQuietHours(dAfterEnd, w)).toBe(false);
  });

  it("fall-back 2026: both 01:30 PDT and 01:30 PST land in window", () => {
    // November 1, 2026 — DST ends. 01:30 PDT happens at 08:30 UTC, then
    // again as 01:30 PST at 09:30 UTC. Both should be inside 22-08 window.
    const firstPass = new Date("2026-11-01T08:30:00Z"); // 01:30 PDT
    const secondPass = new Date("2026-11-01T09:30:00Z"); // 01:30 PST
    expect(isInQuietHours(firstPass, w)).toBe(true);
    expect(isInQuietHours(secondPass, w)).toBe(true);
  });
});

describe("getDeferredSendAt — basic cases (PDT, UTC-7)", () => {
  const w = parseQuietHours("22:00-08:00", TZ_LA)!;

  it("at 03:00 PDT → today 08:00 PDT (UTC = 15:00 same day)", () => {
    // 2026-04-23 03:00 PDT = 2026-04-23 10:00 UTC
    const at = new Date("2026-04-23T10:00:00Z");
    const deferred = getDeferredSendAt(at, w);
    // Expected: 2026-04-23 08:00 PDT = 2026-04-23 15:00 UTC.
    expect(deferred.toISOString()).toBe("2026-04-23T15:00:00.000Z");
  });

  it("at 23:00 PDT → tomorrow 08:00 PDT (UTC = 15:00 next day)", () => {
    // 2026-04-23 23:00 PDT = 2026-04-24 06:00 UTC
    const at = new Date("2026-04-24T06:00:00Z");
    const deferred = getDeferredSendAt(at, w);
    // Expected: 2026-04-24 08:00 PDT = 2026-04-24 15:00 UTC.
    expect(deferred.toISOString()).toBe("2026-04-24T15:00:00.000Z");
  });

  it("at 06:00 PDT (still in window) → today 08:00 PDT", () => {
    const at = new Date("2026-04-23T13:00:00Z"); // 06:00 PDT
    const deferred = getDeferredSendAt(at, w);
    expect(deferred.toISOString()).toBe("2026-04-23T15:00:00.000Z");
  });
});

describe("getDeferredSendAt — across DST boundary", () => {
  const w = parseQuietHours("22:00-08:00", TZ_LA)!;

  it("at 03:00 PST (Nov 1, after fall-back) → 08:00 PST (UTC-8 = 16:00 UTC)", () => {
    // After 02:00 PST repeats and we're past it: 03:00 PST = 11:00 UTC
    const at = new Date("2026-11-01T11:00:00Z");
    const deferred = getDeferredSendAt(at, w);
    // 08:00 PST on 2026-11-01 = 16:00 UTC.
    expect(deferred.toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });

  it("at 03:00 PDT (Mar 8, after spring-forward) → 08:00 PDT (UTC-7 = 15:00 UTC)", () => {
    // 03:00 PDT on 2026-03-08 = 10:00 UTC.
    const at = new Date("2026-03-08T10:00:00Z");
    const deferred = getDeferredSendAt(at, w);
    // 08:00 PDT on 2026-03-08 = 15:00 UTC.
    expect(deferred.toISOString()).toBe("2026-03-08T15:00:00.000Z");
  });
});

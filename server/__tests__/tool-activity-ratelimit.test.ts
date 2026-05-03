/**
 * BRO1 hot-fix #1 — per-user per-room rate-limit for /api/rooms/:id/tool-activity.
 *
 * The route uses checkAuthRateLimit(`tool-activity:${userId}:${roomId}`, 60, 60_000).
 * This test exercises the underlying limiter with the same key shape and
 * confirms:
 *   - up to 60 requests/min are allowed (default poll = 30/min, headroom 2x)
 *   - 61st request is denied
 *   - different rooms for the same user are independent (no global cap)
 *   - different users on the same room are independent
 */

import { describe, it, expect } from "vitest";
import { checkAuthRateLimit } from "../ratelimit";

const MAX = 60;
const WINDOW = 60_000;

function key(userId: number, roomId: number, salt: string) {
  // Salt makes each test isolated from siblings.
  return `tool-activity:${salt}:${userId}:${roomId}`;
}

describe("tool-activity rate-limit (per user × room, 60/min)", () => {
  it("allows exactly MAX requests then denies the next", () => {
    const k = key(1, 100, "iso1");
    for (let i = 0; i < MAX; i++) {
      expect(checkAuthRateLimit(k, MAX, WINDOW)).toBe(true);
    }
    expect(checkAuthRateLimit(k, MAX, WINDOW)).toBe(false);
  });

  it("different rooms for same user are independent", () => {
    const ka = key(2, 200, "iso2");
    const kb = key(2, 201, "iso2");
    for (let i = 0; i < MAX; i++) checkAuthRateLimit(ka, MAX, WINDOW);
    expect(checkAuthRateLimit(ka, MAX, WINDOW)).toBe(false);
    // Same user, different room → fresh bucket.
    expect(checkAuthRateLimit(kb, MAX, WINDOW)).toBe(true);
  });

  it("different users on same room are independent", () => {
    const k1 = key(3, 300, "iso3");
    const k2 = key(4, 300, "iso3");
    for (let i = 0; i < MAX; i++) checkAuthRateLimit(k1, MAX, WINDOW);
    expect(checkAuthRateLimit(k1, MAX, WINDOW)).toBe(false);
    expect(checkAuthRateLimit(k2, MAX, WINDOW)).toBe(true);
  });

  it("default poll cadence (30 req/min, one tab) stays well under cap", () => {
    const k = key(5, 500, "iso4");
    // Simulate 30 calls in the window (= 2s polling for 60s).
    for (let i = 0; i < 30; i++) {
      expect(checkAuthRateLimit(k, MAX, WINDOW)).toBe(true);
    }
    // Still room left.
    expect(checkAuthRateLimit(k, MAX, WINDOW)).toBe(true);
  });
});

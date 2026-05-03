/**
 * BRO1 hot-fix #2 — TTL reaper for tool_activity_log.
 *
 * Verifies:
 *   - sweep deletes rows with created_at < cutoff (now - ttlDays * 86400_000)
 *   - default TTL is 30 days; env override TOOL_ACTIVITY_TTL_DAYS works
 *   - TTL is hard-floored at 1 day (mis-config protection)
 *   - sweep returns 0 and does not throw on DB error
 *   - startToolActivityReaper returns no-op handle when env=false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  runToolActivitySweep,
  startToolActivityReaper,
} from "../lib/tool-activity-reaper";

function fakePool(rowCount: number, throws = false) {
  return {
    query: vi.fn(async () => {
      if (throws) throw new Error("db down");
      return { rowCount } as any;
    }),
  } as any;
}

beforeEach(() => {
  delete process.env.TOOL_ACTIVITY_TTL_DAYS;
  delete process.env.TOOL_ACTIVITY_TTL_REAPER_ENABLED;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runToolActivitySweep", () => {
  it("issues DELETE with cutoff = now - 30 days by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T00:00:00Z"));
    const pool = fakePool(7);
    const stats = await runToolActivitySweep({ pool });
    expect(stats.rowsDeleted).toBe(7);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM tool_activity_log/);
    const cutoffMs = params[0];
    const expected = Date.now() - 30 * 86400_000;
    expect(cutoffMs).toBe(expected);
  });

  it("respects env override TOOL_ACTIVITY_TTL_DAYS", async () => {
    process.env.TOOL_ACTIVITY_TTL_DAYS = "7";
    const pool = fakePool(0);
    await runToolActivitySweep({ pool });
    const cutoffMs = pool.query.mock.calls[0][1][0];
    const expected = Date.now() - 7 * 86400_000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(1000);
  });

  it("falls back to default 30d when env says 0 (safe-by-default)", async () => {
    process.env.TOOL_ACTIVITY_TTL_DAYS = "0";
    const pool = fakePool(0);
    await runToolActivitySweep({ pool });
    const cutoffMs = pool.query.mock.calls[0][1][0];
    // 0 is rejected as invalid → default 30d, NOT 1d floor.
    // This is a safer behaviour: a typo of '0' must not aggressively delete.
    const expected = Date.now() - 30 * 86400_000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(1000);
  });

  it("hard-floors TTL at 1 day when explicit ttlDays is sub-1", async () => {
    const pool = fakePool(0);
    await runToolActivitySweep({ pool, ttlDays: 0.5 });
    const cutoffMs = pool.query.mock.calls[0][1][0];
    const expected = Date.now() - 1 * 86400_000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(1000);
  });

  it("returns 0 and does not throw on DB error", async () => {
    const pool = fakePool(0, true);
    const stats = await runToolActivitySweep({ pool });
    expect(stats.rowsDeleted).toBe(0);
  });
});

describe("startToolActivityReaper", () => {
  it("returns a no-op handle when env disables it", async () => {
    process.env.TOOL_ACTIVITY_TTL_REAPER_ENABLED = "false";
    const pool = fakePool(0);
    const h = startToolActivityReaper({ pool, intervalMs: 1000 });
    const stats = await h.sweepOnce();
    expect(stats.rowsDeleted).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
    h.stop();
  });

  it("sweepOnce executes the DELETE when enabled", async () => {
    const pool = fakePool(3);
    const h = startToolActivityReaper({ pool, intervalMs: 999_999 });
    const stats = await h.sweepOnce();
    expect(stats.rowsDeleted).toBe(3);
    h.stop();
  });
});

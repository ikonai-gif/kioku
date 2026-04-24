/**
 * Self-Monitoring — internal jobs tick logic.
 *
 * Uses vitest fake timers + mocked Date.now / Date ctor to drive the tick
 * across UTC time windows. Asserts:
 *   - Job fires when UTC hour:minute matches target.
 *   - Job does NOT fire outside the target window.
 *   - Job fires at most once per UTC day (de-dupe via firedToday Set).
 *   - firedToday set is pruned when a new UTC day begins.
 *   - Exception in a job does NOT break subsequent ticks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We intentionally mock the two heavy dependencies so tick() becomes pure.
// vi.mock is hoisted, so factories must be self-contained. Handles are
// retrieved via vi.mocked() after imports resolve.
vi.mock("../../lib/self-monitoring/health-job", () => ({
  runHealthCheck: vi.fn(async () => ({
    ok: true,
    baseline_seeded: false,
    drift_count: 0,
    blocking_drift_count: 0,
    baseline_id: 1,
    drift_ids: [],
    truth_generated_at: new Date().toISOString(),
  })),
  acceptCurrentTruthAsBaseline: vi.fn(async () => ({ baseline_id: 1, acked_drift_ids: [] })),
}));
vi.mock("../../lib/self-monitoring/fabrication", () => ({
  runFabricationSelfTest: vi.fn(async () => ({
    runAt: Date.now(),
    total: 0, pass: 0, fail: 0, error: 0,
    results: [],
  })),
  ensureSelfMonitoringRoom: vi.fn(async () => 999),
  evaluateVerdict: (actual: any) => actual,
}));

import { __test__ } from "../../lib/self-monitoring/jobs";
import { runHealthCheck } from "../../lib/self-monitoring/health-job";
import { runFabricationSelfTest } from "../../lib/self-monitoring/fabrication";

function setNowUTC(y: number, m: number, d: number, hh: number, mm: number) {
  const t = Date.UTC(y, m - 1, d, hh, mm, 0);
  vi.setSystemTime(new Date(t));
}

describe("self-monitoring/jobs.tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (runHealthCheck as any).mockClear();
    (runFabricationSelfTest as any).mockClear();
    __test__.firedToday.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    __test__.firedToday.clear();
  });

  it("fires health-check at 14:00 UTC", async () => {
    setNowUTC(2026, 4, 23, 14, 0);
    await __test__.tick();
    expect(runHealthCheck).toHaveBeenCalledTimes(1);
    expect(runFabricationSelfTest).not.toHaveBeenCalled();
  });

  it("fires fabrication at 15:00 UTC", async () => {
    setNowUTC(2026, 4, 23, 15, 0);
    await __test__.tick();
    expect(runFabricationSelfTest).toHaveBeenCalledTimes(1);
    expect(runHealthCheck).not.toHaveBeenCalled();
  });

  it("does NOT fire outside the target window (13:59, 14:02)", async () => {
    setNowUTC(2026, 4, 23, 13, 59);
    await __test__.tick();
    setNowUTC(2026, 4, 23, 14, 2);
    await __test__.tick();
    expect(runHealthCheck).not.toHaveBeenCalled();
  });

  it("fires at HH:00 and HH:01 (tick jitter tolerance) but only once per day", async () => {
    setNowUTC(2026, 4, 23, 14, 0);
    await __test__.tick();
    setNowUTC(2026, 4, 23, 14, 1);
    await __test__.tick();
    expect(runHealthCheck).toHaveBeenCalledTimes(1);
  });

  it("fires again the next UTC day (de-dupe is per-day)", async () => {
    setNowUTC(2026, 4, 23, 14, 0);
    await __test__.tick();
    setNowUTC(2026, 4, 24, 14, 0);
    await __test__.tick();
    expect(runHealthCheck).toHaveBeenCalledTimes(2);
  });

  it("prunes firedToday keys from older UTC days", async () => {
    setNowUTC(2026, 4, 23, 14, 0);
    await __test__.tick();
    expect(__test__.firedToday.size).toBeGreaterThan(0);

    // Jump to a later day at an off-window minute — pruning still happens.
    setNowUTC(2026, 4, 25, 3, 0);
    await __test__.tick();
    // No entries for today, old entries pruned.
    for (const k of __test__.firedToday) {
      expect(k.startsWith("2026-04-25")).toBe(true);
    }
  });

  it("catches job exceptions so the tick loop keeps running", async () => {
    (runHealthCheck as any).mockRejectedValueOnce(new Error("db unreachable"));
    setNowUTC(2026, 4, 23, 14, 0);
    await expect(__test__.tick()).resolves.not.toThrow();
    // Dedupe still marked so we don't retry same day until tomorrow.
    expect([...__test__.firedToday].some((k) => k.includes("health-check"))).toBe(true);
  });
});

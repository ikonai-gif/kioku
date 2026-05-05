/**
 * R473-full (BRO2) — fail-streak helper unit tests
 *
 * The 8-day false-red incident slipped past us because the daily
 * dashboard only showed today's pass/fail. computeStreak counts how
 * many of the most-recent runs were non-pass before the next pass —
 * which is what the admin detail endpoint surfaces so a stuck probe
 * stays loud until it goes green again.
 */

import { describe, it, expect } from "vitest";
import { computeStreak } from "../../lib/self-monitoring/fabrication";

const probe = { id: 7, name: "demo", category: "test" };

describe("R473-full: computeStreak", () => {
  it("returns streak=0 when there are no runs", () => {
    const r = computeStreak(probe, []);
    expect(r.streak).toBe(0);
    expect(r.lastVerdict).toBe("error"); // sentinel for missing history
    expect(r.lastRunAt).toBeNull();
  });

  it("returns streak=0 when the latest run is a pass", () => {
    const r = computeStreak(probe, [
      { verdict: "pass", runAt: 1000 },
      { verdict: "fail", runAt: 999 },
      { verdict: "fail", runAt: 998 },
    ]);
    expect(r.streak).toBe(0);
    expect(r.lastVerdict).toBe("pass");
    expect(r.lastRunAt).toBe(1000);
  });

  it("counts consecutive non-pass runs at the head", () => {
    const r = computeStreak(probe, [
      { verdict: "fail", runAt: 1003 },
      { verdict: "fail", runAt: 1002 },
      { verdict: "fail", runAt: 1001 },
      { verdict: "pass", runAt: 1000 },
      { verdict: "fail", runAt: 999 },
    ]);
    expect(r.streak).toBe(3);
    expect(r.lastVerdict).toBe("fail");
    expect(r.lastRunAt).toBe(1003);
  });

  it("treats 'error' as a non-pass for streak purposes", () => {
    const r = computeStreak(probe, [
      { verdict: "error", runAt: 1002 },
      { verdict: "fail", runAt: 1001 },
      { verdict: "pass", runAt: 1000 },
    ]);
    expect(r.streak).toBe(2);
  });

  it("caps at the supplied lookback window (no pass in window)", () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      verdict: "fail",
      runAt: 2000 - i,
    }));
    const r = computeStreak(probe, runs);
    expect(r.streak).toBe(10);
    expect(r.lastVerdict).toBe("fail");
  });
});

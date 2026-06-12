/**
 * [LUCA-088] CRON PR2 — startup missed-run checker unit tests.
 * Deterministic: `now` is injected, no fake timers; prev fire derived by
 * cron-parser in America/Los_Angeles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { __poolQuery, __runMB, __logWarn, __logInfo } = vi.hoisted(() => ({
  __poolQuery: vi.fn(),
  __runMB: vi.fn(async () => ({ status: "sent" })),
  __logWarn: vi.fn(),
  __logInfo: vi.fn(),
}));

vi.mock("../../server/storage", () => ({ pool: { query: __poolQuery } }));
vi.mock("../../server/cron/morning-brief", () => ({
  runMorningBrief: __runMB,
  CRON1_JOB_ID: "CRON-1",
}));
vi.mock("../../server/logger", () => {
  const l = { info: __logInfo, warn: __logWarn, error: vi.fn() };
  return { logger: l, default: l };
});

import { checkMissedMorningBrief } from "../../server/cron/index";

// 2026-06-12 11:00 PDT — previous scheduled fire (0 9 * * * LA) was 2h ago.
const NOW_WITHIN_WINDOW = Date.parse("2026-06-12T18:00:00Z");
// 2026-06-12 23:00 PDT — previous fire 14h ago, outside the 6h window.
const NOW_OUTSIDE_WINDOW = Date.parse("2026-06-13T06:00:00Z");

beforeEach(() => {
  __poolQuery.mockReset();
  __runMB.mockClear();
  __logWarn.mockClear();
  __logInfo.mockClear();
});

describe("checkMissedMorningBrief (LUCA-088)", () => {
  it("telegram row after the expected fire → accounted for, no warn, no run", async () => {
    __poolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    await checkMissedMorningBrief({} as NodeJS.ProcessEnv, NOW_WITHIN_WINDOW);
    expect(__poolQuery).toHaveBeenCalledTimes(1);
    expect(__logWarn).not.toHaveBeenCalled();
    expect(__runMB).not.toHaveBeenCalled();
  });

  it("no row + flag off (default) → warns, does NOT auto-run", async () => {
    __poolQuery.mockResolvedValue({ rows: [] });
    await checkMissedMorningBrief({} as NodeJS.ProcessEnv, NOW_WITHIN_WINDOW);
    expect(__logWarn).toHaveBeenCalledTimes(1);
    expect(String(__logWarn.mock.calls[0][1])).toContain("missed run detected");
    expect(__runMB).not.toHaveBeenCalled();
  });

  it("no row + LUCA_CRON_RUN_MISSED_ON_STARTUP=true → runs the brief once", async () => {
    __poolQuery.mockResolvedValue({ rows: [] });
    await checkMissedMorningBrief(
      { LUCA_CRON_RUN_MISSED_ON_STARTUP: "true" } as any,
      NOW_WITHIN_WINDOW,
    );
    expect(__logWarn).toHaveBeenCalledTimes(1);
    expect(__runMB).toHaveBeenCalledTimes(1);
  });

  it("expected fire older than the 6h window → skip without querying", async () => {
    await checkMissedMorningBrief({} as NodeJS.ProcessEnv, NOW_OUTSIDE_WINDOW);
    expect(__poolQuery).not.toHaveBeenCalled();
    expect(__logWarn).not.toHaveBeenCalled();
    expect(__runMB).not.toHaveBeenCalled();
  });

  it("pool failure is swallowed as non-fatal warn", async () => {
    __poolQuery.mockRejectedValue(new Error("db not ready"));
    await checkMissedMorningBrief({} as NodeJS.ProcessEnv, NOW_WITHIN_WINDOW);
    expect(__logWarn).toHaveBeenCalledTimes(1);
    expect(String(__logWarn.mock.calls[0][1])).toContain("non-fatal");
    expect(__runMB).not.toHaveBeenCalled();
  });
});

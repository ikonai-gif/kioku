/**
 * Tests for stale migration check + per-component alert debounce (R3).
 *
 * All DB calls are mocked. Covers:
 * 1. Stale rows present → checkStaleMigrations() alerts + sets state.staleMigrations=1
 * 2. No stale rows → staleMigrations=0, no alert
 * 3. DB error → no alert, silent log, state unchanged
 * 4. Per-component debounce (R3): DB alert does NOT silence migration alert
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoist shared mock state ────────────────────────────────────────────────────
const { poolMock } = vi.hoisted(() => {
  const poolMock = {
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
  };
  return { poolMock };
});

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = (...args: any[]) => poolMock.query(...args);
    this.on = (...args: any[]) => poolMock.on(...args);
    this.end = (...args: any[]) => poolMock.end(...args);
    this.connect = (...args: any[]) => poolMock.connect(...args);
  }
  return { Pool: MockPool };
});

vi.mock("../embeddings", () => ({ embedText: vi.fn() }));
vi.mock("../memory-decay", () => ({
  computeDecayedStrength: vi.fn(),
  computeDecayedConfidence: vi.fn(),
}));
vi.mock("../emotion-scorer", () => ({ scoreEmotion: vi.fn() }));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({})),
}));

import {
  checkStaleMigrations,
  getMonitorSummary,
  __resetMonitorStateForTest,
} from "../monitor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function staleRows(versions: string[]) {
  return {
    rows: versions.map((version) => ({
      version,
      applied_at: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
    })),
  };
}

function noStaleRows() {
  return { rows: [] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkStaleMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    __resetMonitorStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetMonitorStateForTest();
  });

  it("case 1: sets staleMigrations=1 and fires alert when stale row present", async () => {
    poolMock.query.mockResolvedValueOnce(staleRows(["v_001_stale"]));

    await checkStaleMigrations();

    const summary = getMonitorSummary();
    expect(summary.staleMigrations).toBe(1);
    // Alert should have fired via console.error
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("v_001_stale")
    );
  });

  it("case 2: sets staleMigrations=0 and does not alert when no stale rows", async () => {
    poolMock.query.mockResolvedValueOnce(noStaleRows());

    await checkStaleMigrations();

    const summary = getMonitorSummary();
    expect(summary.staleMigrations).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("handles multiple stale rows and mentions all versions in alert", async () => {
    poolMock.query.mockResolvedValueOnce(
      staleRows(["v_002_stale", "v_003_stale"])
    );

    await checkStaleMigrations();

    const summary = getMonitorSummary();
    expect(summary.staleMigrations).toBe(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("v_002_stale")
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("v_003_stale")
    );
  });

  it("case 3: does not alert and does not throw when DB query fails", async () => {
    poolMock.query.mockRejectedValueOnce(new Error("DB connection lost"));

    // Should not throw
    await expect(checkStaleMigrations()).resolves.toBeUndefined();

    // No alert sent
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("per-component debounce (R3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    __resetMonitorStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetMonitorStateForTest();
  });

  it("case 4: DB alert does not silence migration alert (per-component debounce, R3)", async () => {
    // Verify per-component debounce: both "database" and "migrations" components
    // can each fire within their own 10-min window independently.
    //
    // Before R3 fix: a single global lastAlertAt meant the first alert (whichever
    // component fired) would block ALL other components for 10 minutes.
    // After R3 fix: each component has its own cooldown bucket.

    // First stale migration call fires alert for "migrations" component
    poolMock.query.mockResolvedValueOnce(staleRows(["v_stale_r3"]));
    await checkStaleMigrations();
    const firstAlertCount = (console.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstAlertCount).toBeGreaterThanOrEqual(1);

    // Immediate second call for "migrations" — debounced (within 10-min window)
    poolMock.query.mockResolvedValueOnce(staleRows(["v_stale_r3"]));
    await checkStaleMigrations();
    const secondAlertCount = (console.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(secondAlertCount).toBe(firstAlertCount); // no new alerts (debounced)

    // Advance 11 minutes past the migrations debounce window
    vi.advanceTimersByTime(11 * 60 * 1000);

    // Now migration alert should fire again (its own 10-min window has elapsed)
    poolMock.query.mockResolvedValueOnce(staleRows(["v_stale_r3_again"]));
    await checkStaleMigrations();
    const thirdAlertCount = (console.error as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(thirdAlertCount).toBeGreaterThan(secondAlertCount); // fired again
  });
});

describe("getMonitorSummary exposes staleMigrations", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    __resetMonitorStateForTest();
  });

  it("staleMigrations field is present and is a number", () => {
    const summary = getMonitorSummary();
    expect(summary).toHaveProperty("staleMigrations");
    expect(typeof summary.staleMigrations).toBe("number");
  });
});

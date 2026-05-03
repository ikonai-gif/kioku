/**
 * Phase 5 PR-B (R-luca-computer-ui) — luca-takeover state module.
 *
 * Pure in-memory module — no mocks needed. Tests:
 *   1. acquire on empty stepId returns ok + state
 *   2. acquire conflict from other connection returns locked + current
 *   3. acquire from same connection re-up's mode
 *   4. release by holder clears state
 *   5. release by non-holder is rejected (state unchanged)
 *   6. clearTakeover wipes regardless of holder (used by agent-browser finally)
 *   7. isTakeoverActive false on cleared / passive / expired
 *   8. isTakeoverActive true only on interactive + alive
 *   9. TTL expiry triggers lazy eviction in getTakeover
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireTakeover,
  releaseTakeover,
  clearTakeover,
  getTakeover,
  isTakeoverActive,
  __clearTakeoverStateForTests,
  TAKEOVER_TTL_MS,
} from "../../lib/luca-takeover";

beforeEach(() => {
  __clearTakeoverStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("luca-takeover", () => {
  it("acquireTakeover on empty stepId returns ok + state", () => {
    const r = acquireTakeover({
      stepId: "step-1",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.stepId).toBe("step-1");
      expect(r.state.mode).toBe("interactive");
      expect(r.state.lockedByConnectionId).toBe("c-A");
      expect(r.state.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it("rejects acquire from a second connection while held", () => {
    acquireTakeover({
      stepId: "step-2",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    const second = acquireTakeover({
      stepId: "step-2",
      roomId: 10,
      userId: 8,
      mode: "interactive",
      connectionId: "c-B",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("locked");
      expect(second.current.lockedByConnectionId).toBe("c-A");
      expect(second.current.userId).toBe(7);
    }
  });

  it("same connection can upgrade passive → interactive", () => {
    acquireTakeover({
      stepId: "step-3",
      roomId: 10,
      userId: 7,
      mode: "passive",
      connectionId: "c-A",
    });
    const upgrade = acquireTakeover({
      stepId: "step-3",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    expect(upgrade.ok).toBe(true);
    if (upgrade.ok) expect(upgrade.state.mode).toBe("interactive");
  });

  it("releaseTakeover by holder clears state", () => {
    acquireTakeover({
      stepId: "step-4",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    const after = releaseTakeover("step-4", "c-A");
    expect(after).toBeNull();
    expect(getTakeover("step-4")).toBeNull();
  });

  it("releaseTakeover by non-holder leaves state intact", () => {
    acquireTakeover({
      stepId: "step-5",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    const after = releaseTakeover("step-5", "c-OTHER");
    expect(after).not.toBeNull();
    expect(after?.lockedByConnectionId).toBe("c-A");
    expect(getTakeover("step-5")?.lockedByConnectionId).toBe("c-A");
  });

  it("clearTakeover wipes regardless of holder", () => {
    acquireTakeover({
      stepId: "step-6",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    clearTakeover("step-6");
    expect(getTakeover("step-6")).toBeNull();
    expect(isTakeoverActive("step-6")).toBe(false);
  });

  it("isTakeoverActive returns false for passive mode", () => {
    acquireTakeover({
      stepId: "step-7",
      roomId: 10,
      userId: 7,
      mode: "passive",
      connectionId: "c-A",
    });
    expect(isTakeoverActive("step-7")).toBe(false);
  });

  it("isTakeoverActive returns true only for live interactive holds", () => {
    expect(isTakeoverActive("step-none")).toBe(false);
    acquireTakeover({
      stepId: "step-8",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    expect(isTakeoverActive("step-8")).toBe(true);
  });

  it("TTL expiry causes lazy eviction in getTakeover + isTakeoverActive", () => {
    const t0 = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(t0));
    acquireTakeover({
      stepId: "step-9",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    expect(isTakeoverActive("step-9")).toBe(true);

    // Advance past TTL.
    vi.setSystemTime(new Date(t0 + TAKEOVER_TTL_MS + 1));
    expect(isTakeoverActive("step-9")).toBe(false);
    expect(getTakeover("step-9")).toBeNull();
  });

  it("steps are isolated — releasing one does not touch another", () => {
    acquireTakeover({
      stepId: "step-A",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    acquireTakeover({
      stepId: "step-B",
      roomId: 10,
      userId: 7,
      mode: "interactive",
      connectionId: "c-A",
    });
    releaseTakeover("step-A", "c-A");
    expect(getTakeover("step-A")).toBeNull();
    expect(getTakeover("step-B")).not.toBeNull();
  });
});

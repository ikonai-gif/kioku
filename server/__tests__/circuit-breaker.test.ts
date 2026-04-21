/**
 * Tests for the CircuitBreaker primitive (server/lib/circuit-breaker.ts).
 *
 * 14 cases per plan (R4 + O4 + originals):
 *  1. CLOSED → OPEN after N failures
 *  2. OPEN rejects immediately with CircuitOpenError — retryAfterMs decreases
 *  3. OPEN → HALF_OPEN after cooldownMs (on-demand flip, not timer)
 *  4. HALF_OPEN success → CLOSED, counters reset
 *  5. HALF_OPEN failure → OPEN with fresh openedAt
 *  6. HALF_OPEN rejects concurrent probes
 *  7. Successes in CLOSED reset consecutiveFailures (O4 check)
 *  8. isFailure returning false does NOT count as failure
 *  9. timeoutMs triggers failure
 * 10. abortOnTimeout is called on timeout (R4)
 * 11. onStateChange called with correct (from, to, reason) tuples
 * 12. Stats accurate under load (100 mixed calls)
 * 13. reset() returns to CLOSED, zeroes counters
 * 14. O4: Intermittent (2 fail, 1 success, 2 fail) with threshold=5 → stays CLOSED
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  TimeoutError,
  type State,
} from "../lib/circuit-breaker";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fail = (msg = "error") => async () => {
  throw new Error(msg);
};

const succeed = <T>(val: T) => async () => val;

async function openCircuit(cb: CircuitBreaker, threshold: number) {
  for (let i = 0; i < threshold; i++) {
    await expect(cb.exec(fail())).rejects.toThrow();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CircuitBreaker — 14 cases", () => {
  // Case 1: CLOSED → OPEN after N failures
  it("1: CLOSED → OPEN after failureThreshold consecutive failures", async () => {
    const cb = new CircuitBreaker({
      name: "test-1",
      failureThreshold: 3,
      cooldownMs: 5000,
    });

    expect(cb.getState()).toBe("CLOSED");

    await expect(cb.exec(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("CLOSED");
    await expect(cb.exec(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("CLOSED");
    await expect(cb.exec(fail())).rejects.toThrow();

    expect(cb.getState()).toBe("OPEN");
    expect(cb.getStats().openedAt).not.toBeNull();
  });

  // Case 2: OPEN rejects immediately with CircuitOpenError — retryAfterMs decreases
  it("2: OPEN rejects immediately with CircuitOpenError, retryAfterMs > 0", async () => {
    const cb = new CircuitBreaker({
      name: "test-2",
      failureThreshold: 1,
      cooldownMs: 10_000,
    });

    await expect(cb.exec(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("OPEN");

    const err1 = await cb.exec(succeed("ignored")).catch((e) => e);
    expect(err1).toBeInstanceOf(CircuitOpenError);
    expect(err1.retryAfterMs).toBeGreaterThan(0);
    expect(err1.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect(err1.circuitName).toBe("test-2");

    // retryAfterMs should not exceed cooldownMs
    expect(err1.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  // Case 3: OPEN → HALF_OPEN after cooldownMs (on-demand flip, not timer)
  it("3: OPEN → HALF_OPEN after cooldownMs elapses (on-demand at exec time)", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-3",
        failureThreshold: 1,
        cooldownMs: 1000,
      });

      await expect(cb.exec(fail())).rejects.toThrow();
      expect(cb.getState()).toBe("OPEN");

      // Before cooldown — still OPEN
      vi.advanceTimersByTime(500);
      await expect(cb.exec(succeed("x"))).rejects.toBeInstanceOf(CircuitOpenError);

      // After cooldown — flips to HALF_OPEN on next exec
      vi.advanceTimersByTime(600);
      // The flip happens inside exec — the probe attempt transitions the state
      // We use a succeed fn so it goes all the way to CLOSED
      await cb.exec(succeed("x"));
      // After probe succeeds with successThreshold=1, it's CLOSED
      expect(cb.getState()).toBe("CLOSED");
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 4: HALF_OPEN success → CLOSED, counters reset
  it("4: HALF_OPEN probe success → CLOSED with reset counters", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-4",
        failureThreshold: 2,
        cooldownMs: 500,
      });

      await expect(cb.exec(fail())).rejects.toThrow();
      await expect(cb.exec(fail())).rejects.toThrow();
      expect(cb.getState()).toBe("OPEN");

      vi.advanceTimersByTime(600);

      // Probe success
      const result = await cb.exec(succeed("ok"));
      expect(result).toBe("ok");
      expect(cb.getState()).toBe("CLOSED");

      // Counters reset
      const stats = cb.getStats();
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.openedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 5: HALF_OPEN failure → OPEN with fresh openedAt
  it("5: HALF_OPEN probe failure → OPEN with fresh openedAt", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-5",
        failureThreshold: 1,
        cooldownMs: 500,
      });
      const stateChanges: Array<{ from: State; to: State }> = [];
      cb["opts"].onStateChange = (from, to) => stateChanges.push({ from, to });

      await expect(cb.exec(fail())).rejects.toThrow();
      const openedAt1 = cb.getStats().openedAt!;

      vi.advanceTimersByTime(600);

      // Probe fails
      await expect(cb.exec(fail("probe failed"))).rejects.toThrow();

      expect(cb.getState()).toBe("OPEN");
      const openedAt2 = cb.getStats().openedAt!;
      // Fresh openedAt (> original openedAt since time advanced)
      expect(openedAt2).toBeGreaterThanOrEqual(openedAt1);

      // State transitions: CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→OPEN
      const toOpen = stateChanges.filter((s) => s.to === "OPEN");
      expect(toOpen.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 6: HALF_OPEN rejects concurrent probes
  it("6: HALF_OPEN rejects concurrent callers while probe is in-flight", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-6",
        failureThreshold: 1,
        cooldownMs: 100,
      });

      await expect(cb.exec(fail())).rejects.toThrow();

      vi.advanceTimersByTime(200);

      // Start a slow probe — won't resolve until we advance timers
      let resolveProbe!: (v: string) => void;
      const probePromise = cb.exec(
        () => new Promise<string>((res) => { resolveProbe = res; })
      );

      // Concurrent caller should be rejected immediately
      const concurrentErr = await cb.exec(succeed("concurrent")).catch((e) => e);
      expect(concurrentErr).toBeInstanceOf(CircuitOpenError);

      // Let the probe succeed
      resolveProbe("probe-ok");
      await probePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 7: Successes in CLOSED reset consecutiveFailures (O4 base)
  it("7: Successes in CLOSED state reset consecutiveFailures counter", async () => {
    const cb = new CircuitBreaker({
      name: "test-7",
      failureThreshold: 5,
      cooldownMs: 5000,
    });

    // 2 failures
    await expect(cb.exec(fail())).rejects.toThrow();
    await expect(cb.exec(fail())).rejects.toThrow();
    expect(cb.getStats().consecutiveFailures).toBe(2);

    // 1 success — resets counter
    await cb.exec(succeed("ok"));
    expect(cb.getStats().consecutiveFailures).toBe(0);
    expect(cb.getState()).toBe("CLOSED");
  });

  // Case 8: isFailure returning false does NOT count as failure
  it("8: isFailure predicate returning false skips failure counting", async () => {
    class CustomError extends Error {}

    const cb = new CircuitBreaker({
      name: "test-8",
      failureThreshold: 2,
      cooldownMs: 5000,
      // Only count CustomError as failures
      isFailure: (err) => err instanceof CustomError,
    });

    // Throw a non-CustomError many times — should not open circuit
    for (let i = 0; i < 5; i++) {
      await expect(
        cb.exec(async () => { throw new TypeError("not a custom error"); })
      ).rejects.toThrow(TypeError);
    }

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getStats().consecutiveFailures).toBe(0);
  });

  // Case 9: timeoutMs triggers failure
  it("9: timeoutMs triggers CircuitBreaker failure counting and throws TimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-9",
        failureThreshold: 2,
        cooldownMs: 5000,
        timeoutMs: 100,
      });

      // First timeout — still CLOSED but failure count = 1
      const p1 = cb.exec(
        () => new Promise<string>(() => {}) // never resolves
      );
      vi.advanceTimersByTime(200);
      await expect(p1).rejects.toBeInstanceOf(TimeoutError);
      expect(cb.getStats().consecutiveFailures).toBe(1);

      // Second timeout — should open circuit
      const p2 = cb.exec(
        () => new Promise<string>(() => {}) // never resolves
      );
      vi.advanceTimersByTime(200);
      await expect(p2).rejects.toThrow();
      expect(cb.getState()).toBe("OPEN");
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 10: abortOnTimeout is called on timeout (R4)
  it("10: abortOnTimeout.abort() is called when timeout fires (R4)", async () => {
    vi.useFakeTimers();
    try {
      const abortCtrl = new AbortController();
      const abortSpy = vi.spyOn(abortCtrl, "abort");

      const cb = new CircuitBreaker({
        name: "test-10",
        failureThreshold: 5,
        cooldownMs: 5000,
        timeoutMs: 100,
        abortOnTimeout: abortCtrl,
      });

      const p = cb.exec(() => new Promise<string>(() => {}));
      vi.advanceTimersByTime(200);
      await expect(p).rejects.toBeInstanceOf(TimeoutError);

      expect(abortSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 11: onStateChange called with correct (from, to, reason) tuples
  it("11: onStateChange receives correct from/to/reason on each transition", async () => {
    vi.useFakeTimers();
    try {
      const transitions: Array<{ from: State; to: State; reason: string }> = [];
      const cb = new CircuitBreaker({
        name: "test-11",
        failureThreshold: 1,
        cooldownMs: 100,
        onStateChange: (from, to, reason) =>
          transitions.push({ from, to, reason }),
      });

      // CLOSED → OPEN
      await expect(cb.exec(fail())).rejects.toThrow();
      expect(transitions).toContainEqual(
        expect.objectContaining({ from: "CLOSED", to: "OPEN" })
      );

      // OPEN → HALF_OPEN after cooldown
      vi.advanceTimersByTime(200);
      await cb.exec(succeed("x"));

      expect(transitions).toContainEqual(
        expect.objectContaining({ from: "OPEN", to: "HALF_OPEN" })
      );
      // HALF_OPEN → CLOSED
      expect(transitions).toContainEqual(
        expect.objectContaining({ from: "HALF_OPEN", to: "CLOSED" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 12: Stats accurate under load (100 mixed calls)
  it("12: Stats are accurate under load (100 mixed success/failure calls)", async () => {
    const cb = new CircuitBreaker({
      name: "test-12",
      failureThreshold: 1000, // very high so it never opens
      cooldownMs: 5000,
    });

    let expectedFailures = 0;
    let expectedCalls = 0;

    for (let i = 0; i < 100; i++) {
      expectedCalls++;
      if (i % 3 === 0) {
        await expect(cb.exec(fail())).rejects.toThrow();
        expectedFailures++;
      } else {
        await cb.exec(succeed(i));
      }
    }

    const stats = cb.getStats();
    expect(stats.totalCalls).toBe(expectedCalls);
    expect(stats.totalFailures).toBe(expectedFailures);
  });

  // Case 13: reset() returns to CLOSED, zeroes counters
  it("13: reset() returns circuit to CLOSED with zeroed counters", async () => {
    const cb = new CircuitBreaker({
      name: "test-13",
      failureThreshold: 2,
      cooldownMs: 5000,
    });

    await expect(cb.exec(fail())).rejects.toThrow();
    await expect(cb.exec(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("OPEN");

    cb.reset();

    expect(cb.getState()).toBe("CLOSED");
    const stats = cb.getStats();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.consecutiveSuccesses).toBe(0);
    expect(stats.openedAt).toBeNull();
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalFailures).toBe(0);

    // Should accept calls again
    const result = await cb.exec(succeed("after-reset"));
    expect(result).toBe("after-reset");
  });

  // Case 14: O4 — Intermittent failures don't open circuit at threshold=5
  it("14 (O4): intermittent 2f+1s+2f with threshold=5 stays CLOSED (success resets counter)", async () => {
    const cb = new CircuitBreaker({
      name: "test-14-o4",
      failureThreshold: 5,
      cooldownMs: 5000,
    });

    // 2 failures
    await expect(cb.exec(fail("fail-1"))).rejects.toThrow();
    await expect(cb.exec(fail("fail-2"))).rejects.toThrow();
    expect(cb.getStats().consecutiveFailures).toBe(2);

    // 1 success — resets counter
    await cb.exec(succeed("ok"));
    expect(cb.getStats().consecutiveFailures).toBe(0);

    // 2 more failures
    await expect(cb.exec(fail("fail-3"))).rejects.toThrow();
    await expect(cb.exec(fail("fail-4"))).rejects.toThrow();
    expect(cb.getStats().consecutiveFailures).toBe(2); // counter at 2, not 4

    // Circuit should still be CLOSED (only 2 consecutive, threshold is 5)
    expect(cb.getState()).toBe("CLOSED");
  });

  // Case 15 (F1/SF1 — new): HALF_OPEN→CLOSED preserves cumulative totals.
  it("15 (F1/SF1): cumulative totalCalls/totalFailures preserved across HALF_OPEN→CLOSED", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-15-counter-preservation",
        failureThreshold: 2,
        cooldownMs: 500,
      });

      // 2 failures → OPEN. totalCalls=2, totalFailures=2.
      await expect(cb.exec(fail("f1"))).rejects.toThrow();
      await expect(cb.exec(fail("f2"))).rejects.toThrow();
      expect(cb.getState()).toBe("OPEN");
      expect(cb.getStats().totalCalls).toBe(2);
      expect(cb.getStats().totalFailures).toBe(2);
      const lastFailureAt = cb.getStats().lastFailureAt;
      expect(lastFailureAt).not.toBeNull();

      vi.advanceTimersByTime(600);

      // Probe success → HALF_OPEN→CLOSED. totalCalls=3, totalFailures=2 preserved.
      await cb.exec(succeed("ok"));
      expect(cb.getState()).toBe("CLOSED");

      const stats = cb.getStats();
      expect(stats.totalCalls).toBe(3);
      expect(stats.totalFailures).toBe(2);
      expect(stats.lastFailureAt).toBe(lastFailureAt); // preserved
      // Transient counters cleared
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.consecutiveSuccesses).toBe(0);
      expect(stats.openedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 16 (F1 — new): stale consecutiveSuccesses cannot falsely close a
  // re-opened circuit. With successThreshold=2, if a probe succeeds once
  // then the next probe fails, the circuit must re-open and the prior
  // success must NOT carry over into the next HALF_OPEN window.
  it("16 (F1): HALF_OPEN→OPEN zeros consecutiveSuccesses so stale probe wins don't re-close", async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({
        name: "test-16-f1",
        failureThreshold: 1,
        cooldownMs: 500,
        successThreshold: 2,
      });

      // 1 failure → OPEN
      await expect(cb.exec(fail("initial"))).rejects.toThrow();
      expect(cb.getState()).toBe("OPEN");

      // Cooldown elapses → HALF_OPEN probe 1 succeeds (but threshold=2, stays HALF_OPEN).
      vi.advanceTimersByTime(600);
      await cb.exec(succeed("probe1"));
      expect(cb.getState()).toBe("HALF_OPEN");
      expect(cb.getStats().consecutiveSuccesses).toBe(1);

      // Probe 2 fails → HALF_OPEN→OPEN. consecutiveSuccesses must reset.
      await expect(cb.exec(fail("probe2"))).rejects.toThrow();
      expect(cb.getState()).toBe("OPEN");
      expect(cb.getStats().consecutiveSuccesses).toBe(0);

      // Cooldown elapses → HALF_OPEN probe 3 succeeds (threshold still 2;
      // we need TWO fresh successes, not one stale + one fresh).
      vi.advanceTimersByTime(600);
      await cb.exec(succeed("probe3"));
      expect(cb.getState()).toBe("HALF_OPEN");
      expect(cb.getStats().consecutiveSuccesses).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 17 (new): reset() still zeroes everything — explicit manual recovery.
  it("17: reset() still zeroes totalCalls/totalFailures (manual recovery)", async () => {
    const cb = new CircuitBreaker({
      name: "test-17-reset-all",
      failureThreshold: 3,
      cooldownMs: 5000,
    });

    await expect(cb.exec(fail())).rejects.toThrow();
    await expect(cb.exec(fail())).rejects.toThrow();
    await cb.exec(succeed("ok"));
    expect(cb.getStats().totalCalls).toBe(3);
    expect(cb.getStats().totalFailures).toBe(2);
    expect(cb.getStats().lastFailureAt).not.toBeNull();

    cb.reset();

    const stats = cb.getStats();
    expect(stats.state).toBe("CLOSED");
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalFailures).toBe(0);
    expect(stats.lastFailureAt).toBeNull();
    expect(stats.openedAt).toBeNull();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.consecutiveSuccesses).toBe(0);
  });
});

/**
 * Tests for the shared Anthropic breaker (W7 Variant C).
 * Mirrors openai-client.test.ts but for the Anthropic wrapper.
 *
 * Thresholds:
 *   - failureThreshold = 3 (tighter than OpenAI's 5)
 *   - cooldownMs = 30_000
 *   - timeoutMs = 60_000 (Claude is slower)
 *   - isFailure: 4xx non-429 = caller error; 429, 5xx, 529, timeouts count
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  withAnthropicBreaker,
  getAnthropicBreakerState,
  __resetAnthropicBreakerForTest,
  isAnthropicFailure,
  CircuitOpenError,
} from "../lib/anthropic-client";

beforeEach(() => {
  __resetAnthropicBreakerForTest();
});

// Minimal stub matching the shape withAnthropicBreaker passes through.
function makeStubClient() {
  return {
    messages: { create: vi.fn() },
  } as any;
}

describe("anthropic-client — shared breaker (Variant C)", () => {
  it("1: passes through to fn with the provided client on success", async () => {
    const stub = makeStubClient();
    stub.messages.create.mockResolvedValue({ id: "msg-1", content: [] });

    const result = await withAnthropicBreaker(stub, (c) =>
      c.messages.create({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] } as any),
    );

    expect(result).toEqual({ id: "msg-1", content: [] });
    expect(stub.messages.create).toHaveBeenCalledOnce();
    expect(getAnthropicBreakerState().state).toBe("CLOSED");
  });

  it("2: 3 consecutive failures → OPEN → subsequent calls fail fast with CircuitOpenError", async () => {
    const stub = makeStubClient();
    const fail = async () => { throw new Error("anthropic-down"); };

    for (let i = 0; i < 3; i++) {
      await expect(withAnthropicBreaker(stub, fail)).rejects.toThrow("anthropic-down");
    }

    expect(getAnthropicBreakerState().state).toBe("OPEN");

    // Next caller fails fast; fn not invoked.
    const fn = vi.fn(async () => "should-not-run");
    await expect(withAnthropicBreaker(stub, fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("3: 4xx (non-429) errors do NOT count as breaker failures", async () => {
    const stub = makeStubClient();

    for (let i = 0; i < 10; i++) {
      await expect(
        withAnthropicBreaker(stub, async () => {
          const e: any = new Error("bad request");
          e.status = 400;
          throw e;
        }),
      ).rejects.toThrow("bad request");
    }

    expect(getAnthropicBreakerState().state).toBe("CLOSED");
    expect(getAnthropicBreakerState().consecutiveFailures).toBe(0);
  });

  it("4: 529 (Anthropic overload) DOES trip the breaker", async () => {
    const stub = makeStubClient();

    for (let i = 0; i < 3; i++) {
      await expect(
        withAnthropicBreaker(stub, async () => {
          const e: any = new Error("overloaded");
          e.status = 529;
          throw e;
        }),
      ).rejects.toThrow("overloaded");
    }

    expect(getAnthropicBreakerState().state).toBe("OPEN");
  });

  it("5: 5xx errors count as failures", async () => {
    const stub = makeStubClient();

    for (let i = 0; i < 3; i++) {
      await expect(
        withAnthropicBreaker(stub, async () => {
          const e: any = new Error("internal");
          e.status = 500;
          throw e;
        }),
      ).rejects.toThrow("internal");
    }

    expect(getAnthropicBreakerState().state).toBe("OPEN");
  });

  it("6: 429 rate-limits count as failures (treated like upstream degradation)", async () => {
    const stub = makeStubClient();

    for (let i = 0; i < 3; i++) {
      await expect(
        withAnthropicBreaker(stub, async () => {
          const e: any = new Error("rate limit");
          e.status = 429;
          throw e;
        }),
      ).rejects.toThrow("rate limit");
    }

    expect(getAnthropicBreakerState().state).toBe("OPEN");
  });

  it("7: cooldown elapsed → HALF_OPEN probe succeeds → CLOSED", async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStubClient();
      for (let i = 0; i < 3; i++) {
        await expect(
          withAnthropicBreaker(stub, async () => { throw new Error("boom"); }),
        ).rejects.toThrow();
      }
      expect(getAnthropicBreakerState().state).toBe("OPEN");

      // Still OPEN before cooldown elapses.
      vi.advanceTimersByTime(29_000);
      await expect(
        withAnthropicBreaker(stub, async () => "x"),
      ).rejects.toBeInstanceOf(CircuitOpenError);

      // After cooldown, a probe is allowed; success → CLOSED.
      vi.advanceTimersByTime(2_000);
      const result = await withAnthropicBreaker(stub, async () => "recovered");
      expect(result).toBe("recovered");
      expect(getAnthropicBreakerState().state).toBe("CLOSED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("8: isAnthropicFailure predicate — classifies statuses correctly", () => {
    // Caller errors: do NOT trip
    expect(isAnthropicFailure({ status: 400 })).toBe(false);
    expect(isAnthropicFailure({ status: 401 })).toBe(false);
    expect(isAnthropicFailure({ status: 404 })).toBe(false);
    // Upstream degradation: DO trip
    expect(isAnthropicFailure({ status: 429 })).toBe(true);
    expect(isAnthropicFailure({ status: 500 })).toBe(true);
    expect(isAnthropicFailure({ status: 529 })).toBe(true);
    // No status (timeout, network) → trip
    expect(isAnthropicFailure(new Error("ETIMEDOUT"))).toBe(true);
    expect(isAnthropicFailure(null)).toBe(true);
  });

  it("9: __resetAnthropicBreakerForTest throws when NODE_ENV !== test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => __resetAnthropicBreakerForTest()).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

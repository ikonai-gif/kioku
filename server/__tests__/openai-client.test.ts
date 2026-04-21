/**
 * Tests for the shared OpenAI client factory + process-wide breaker
 * (server/lib/openai-client.ts). See Week 5 plan Item 1.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  withOpenAIBreaker,
  getOpenAIBreakerState,
  __resetOpenAIBreakerForTest,
  __setOpenAIClientForTest,
  CircuitOpenError,
} from "../lib/openai-client";

beforeEach(() => {
  // @ts-ignore — tests always run under NODE_ENV=test
  __resetOpenAIBreakerForTest();
});

// Minimal stub that looks enough like an OpenAI client for our call sites.
function makeStubClient() {
  return {
    chat: { completions: { create: vi.fn() } },
  } as any;
}

describe("openai-client — shared factory + breaker", () => {
  it("1: withOpenAIBreaker invokes fn with injected stub client (happy path)", async () => {
    const stub = makeStubClient();
    stub.chat.completions.create.mockResolvedValue({ id: "cmpl-1" });
    __setOpenAIClientForTest(stub);

    const result = await withOpenAIBreaker((c) =>
      c.chat.completions.create({ model: "x", messages: [] } as any),
    );

    expect(result).toEqual({ id: "cmpl-1" });
    expect(stub.chat.completions.create).toHaveBeenCalledOnce();
    expect(getOpenAIBreakerState().state).toBe("CLOSED");
  });

  it("2: factory returns same client across calls (singleton)", async () => {
    const stub = makeStubClient();
    stub.chat.completions.create.mockResolvedValue("ok");
    __setOpenAIClientForTest(stub);

    const seen: unknown[] = [];
    await withOpenAIBreaker(async (c) => { seen.push(c); return "a"; });
    await withOpenAIBreaker(async (c) => { seen.push(c); return "b"; });
    await withOpenAIBreaker(async (c) => { seen.push(c); return "c"; });

    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
  });

  it("3: 5 consecutive failures → OPEN → subsequent calls throw CircuitOpenError", async () => {
    __setOpenAIClientForTest(makeStubClient());

    const fail = async () => { throw new Error("backend-down"); };

    for (let i = 0; i < 5; i++) {
      await expect(withOpenAIBreaker(fail)).rejects.toThrow("backend-down");
    }

    expect(getOpenAIBreakerState().state).toBe("OPEN");

    // Next caller fails fast with CircuitOpenError (fn not invoked).
    const fn = vi.fn(async () => "should-not-run");
    await expect(withOpenAIBreaker(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("4: 4xx (non-429) errors do NOT count as breaker failures", async () => {
    __setOpenAIClientForTest(makeStubClient());

    // 10 x 400 errors — should never open the circuit.
    for (let i = 0; i < 10; i++) {
      await expect(
        withOpenAIBreaker(async () => {
          const e: any = new Error("bad request");
          e.status = 400;
          throw e;
        }),
      ).rejects.toThrow("bad request");
    }

    expect(getOpenAIBreakerState().state).toBe("CLOSED");
    expect(getOpenAIBreakerState().consecutiveFailures).toBe(0);
  });

  it("5: 429 rate-limits DO count as failures", async () => {
    __setOpenAIClientForTest(makeStubClient());

    for (let i = 0; i < 5; i++) {
      await expect(
        withOpenAIBreaker(async () => {
          const e: any = new Error("rate limit");
          e.status = 429;
          throw e;
        }),
      ).rejects.toThrow("rate limit");
    }

    expect(getOpenAIBreakerState().state).toBe("OPEN");
  });

  it("6: 5xx errors count as failures", async () => {
    __setOpenAIClientForTest(makeStubClient());

    for (let i = 0; i < 5; i++) {
      await expect(
        withOpenAIBreaker(async () => {
          const e: any = new Error("internal");
          e.status = 503;
          throw e;
        }),
      ).rejects.toThrow("internal");
    }

    expect(getOpenAIBreakerState().state).toBe("OPEN");
  });

  it("7: __resetOpenAIBreakerForTest clears breaker + stub client", async () => {
    __setOpenAIClientForTest(makeStubClient());
    for (let i = 0; i < 5; i++) {
      await expect(
        withOpenAIBreaker(async () => { throw new Error("x"); }),
      ).rejects.toThrow();
    }
    expect(getOpenAIBreakerState().state).toBe("OPEN");

    __resetOpenAIBreakerForTest();
    expect(getOpenAIBreakerState().state).toBe("CLOSED");
    expect(getOpenAIBreakerState().consecutiveFailures).toBe(0);
    expect(getOpenAIBreakerState().totalCalls).toBe(0);
  });

  it("8: __resetOpenAIBreakerForTest throws when NODE_ENV !== test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => __resetOpenAIBreakerForTest()).toThrow(/NODE_ENV=test/);
      expect(() => __setOpenAIClientForTest(null)).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

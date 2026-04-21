/**
 * Tests for server/lib/openai-per-agent-breaker.ts (W6 Item 1a).
 *
 * Coverage (18 cases):
 *   Delegation — shared-key agents must NOT populate the per-agent registry
 *     1. agent with no llmApiKey → delegates to shared breaker, registry empty
 *     2. agent with llmApiKey but non-openai provider → also delegates
 *     3. agent with empty-string llmApiKey → also treated as shared-key
 *   Per-agent path — custom-key agents get an isolated breaker
 *     4. first call creates registry entry + reuses on second call
 *     5. injected client is passed to fn
 *   Isolation — the core value prop
 *     6. agent A fails 5x → only A's breaker OPEN, B and C CLOSED
 *     7. failures on custom-key agent do NOT affect shared breaker
 *   CircuitOpenError propagation (N2)
 *     8. breaker OPEN → next call throws with name=CircuitOpenError AND
 *        code=CIRCUIT_OPEN (so callers identify it without instanceof)
 *   LRU eviction
 *     9. fill to MAX_AGENTS, add one more → size still MAX_AGENTS
 *    10. eviction prefers non-OPEN entries when available
 *    11. pathological all-OPEN → evicts true oldest
 *    12. creating an agent that already exists does NOT trigger eviction
 *   Observability exports
 *    13. getAllAgentBreakerStates returns accurate snapshot (mixed CLOSED/OPEN)
 *    14. getAgentBreakerSummary reports correct {total, open}
 *    15. both exports ignore shared-key traffic (agents never entered registry)
 *   Test hooks
 *    16. __setAgentClientForTest injects mock
 *    17. __resetAllAgentBreakersForTest clears both maps
 *    18. __set/__reset guard NODE_ENV
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// vi.mock hoists — the factory runs before imports below. Return a default
// export constructor so `new OpenAI({ apiKey })` in the module under test
// produces our stub instead of the real SDK.
vi.mock("openai", () => {
  // The module under test calls `new OpenAI({ apiKey })`. vi.fn's default
  // implementation is callable but not newable, so hand-roll a ctor stub.
  function FakeOpenAI(this: any, _opts?: { apiKey?: string }) {
    this.chat = { completions: { create: vi.fn() } };
  }
  return { default: FakeOpenAI };
});

import {
  withAgentBreaker,
  getAllAgentBreakerStates,
  getAgentBreakerSummary,
  isCustomKeyAgent,
  MAX_AGENTS,
  __setAgentClientForTest,
  __resetAllAgentBreakersForTest,
  __getAgentBreakerMapSizeForTest,
  __getTrackedAgentIdsForTest,
} from "../lib/openai-per-agent-breaker";
import {
  getOpenAIBreakerState,
  __resetOpenAIBreakerForTest,
  __setOpenAIClientForTest,
  CircuitOpenError,
} from "../lib/openai-client";

function makeStubClient() {
  return {
    chat: { completions: { create: vi.fn() } },
  } as any;
}

const sharedKeyAgent = (id: number) => ({ id, llmApiKey: null, llmProvider: null });
const customKeyAgent = (id: number) => ({
  id,
  llmApiKey: `sk-agent-${id}`,
  llmProvider: "openai" as const,
});

beforeEach(() => {
  __resetAllAgentBreakersForTest();
  __resetOpenAIBreakerForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openai-per-agent-breaker — delegation (shared-key path)", () => {
  it("1: shared-key agent (no llmApiKey) delegates to shared breaker; registry stays empty", async () => {
    __setOpenAIClientForTest(makeStubClient());

    const result = await withAgentBreaker(sharedKeyAgent(42), async () => "ok");

    expect(result).toBe("ok");
    expect(__getAgentBreakerMapSizeForTest()).toBe(0);
  });

  it("2: custom-key but non-openai provider (e.g. anthropic) also delegates", async () => {
    __setOpenAIClientForTest(makeStubClient());

    const agent = { id: 7, llmApiKey: "sk-ant-123", llmProvider: "anthropic" };
    await withAgentBreaker(agent, async () => "ok");

    expect(__getAgentBreakerMapSizeForTest()).toBe(0);
    expect(isCustomKeyAgent(agent)).toBe(false);
  });

  it("3: empty-string llmApiKey treated as shared-key", async () => {
    __setOpenAIClientForTest(makeStubClient());

    const agent = { id: 8, llmApiKey: "", llmProvider: "openai" };
    await withAgentBreaker(agent, async () => "ok");

    expect(__getAgentBreakerMapSizeForTest()).toBe(0);
  });
});

describe("openai-per-agent-breaker — custom-key path", () => {
  it("4: first call creates registry entry; second call for same agent reuses it", async () => {
    await withAgentBreaker(customKeyAgent(1), async () => "a");
    expect(__getAgentBreakerMapSizeForTest()).toBe(1);
    expect(__getTrackedAgentIdsForTest()).toEqual([1]);

    await withAgentBreaker(customKeyAgent(1), async () => "b");
    expect(__getAgentBreakerMapSizeForTest()).toBe(1);
  });

  it("5: injected client is what fn receives", async () => {
    // First call constructs the real (mocked) client and stores it.
    let receivedFirst: any;
    await withAgentBreaker(customKeyAgent(99), async (c) => {
      receivedFirst = c;
      return "ok";
    });

    // Override with __setAgentClientForTest — subsequent calls should see it.
    const stub = makeStubClient();
    __setAgentClientForTest(99, stub);

    let receivedSecond: any;
    await withAgentBreaker(customKeyAgent(99), async (c) => {
      receivedSecond = c;
      return "ok";
    });

    expect(receivedSecond).toBe(stub);
    expect(receivedSecond).not.toBe(receivedFirst);
  });
});

describe("openai-per-agent-breaker — isolation invariant", () => {
  it("6: agent A fails 5x → A OPEN, B and C CLOSED", async () => {
    const fail = async () => {
      const e: any = new Error("boom");
      e.status = 503;
      throw e;
    };

    // A: 5 failures → OPEN
    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(1), fail)).rejects.toThrow("boom");
    }

    // B and C: one successful call each → CLOSED
    await withAgentBreaker(customKeyAgent(2), async () => "ok");
    await withAgentBreaker(customKeyAgent(3), async () => "ok");

    const states = new Map(getAllAgentBreakerStates().map((s) => [s.agentId, s.state]));
    expect(states.get(1)).toBe("OPEN");
    expect(states.get(2)).toBe("CLOSED");
    expect(states.get(3)).toBe("CLOSED");

    // Agents B and C must still be usable.
    const bResult = await withAgentBreaker(customKeyAgent(2), async () => "b-ok");
    expect(bResult).toBe("b-ok");
  });

  it("7: custom-key agent failures do NOT trip the shared breaker", async () => {
    __setOpenAIClientForTest(makeStubClient());
    const fail = async () => {
      const e: any = new Error("boom");
      e.status = 503;
      throw e;
    };

    // Trip agent 1's breaker fully.
    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(1), fail)).rejects.toThrow("boom");
    }

    expect(getOpenAIBreakerState().state).toBe("CLOSED");
    expect(getOpenAIBreakerState().consecutiveFailures).toBe(0);
  });
});

describe("openai-per-agent-breaker — CircuitOpenError propagation (N2)", () => {
  it("8: OPEN breaker throws error with name=CircuitOpenError AND code=CIRCUIT_OPEN", async () => {
    const fail = async () => {
      const e: any = new Error("backend-down");
      e.status = 503;
      throw e;
    };

    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(1), fail)).rejects.toThrow();
    }

    const notInvoked = vi.fn(async () => "should-not-run");
    let caught: any;
    try {
      await withAgentBreaker(customKeyAgent(1), notInvoked);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CircuitOpenError);
    expect(caught.name).toBe("CircuitOpenError");
    expect(caught.code).toBe("CIRCUIT_OPEN");
    expect(notInvoked).not.toHaveBeenCalled();
  });
});

describe("openai-per-agent-breaker — LRU eviction", () => {
  it("9: adding a new agent past MAX_AGENTS does not grow the registry", async () => {
    // Create MAX_AGENTS entries, all CLOSED.
    for (let i = 1; i <= MAX_AGENTS; i++) {
      await withAgentBreaker(customKeyAgent(i), async () => "ok");
    }
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);

    // One more — must evict.
    await withAgentBreaker(customKeyAgent(MAX_AGENTS + 1), async () => "ok");
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);
  });

  it("10: eviction prefers non-OPEN entries over OPEN ones", async () => {
    const fail = async () => {
      const e: any = new Error("x");
      e.status = 503;
      throw e;
    };

    // Agent 1: trip OPEN.
    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(1), fail)).rejects.toThrow();
    }

    // Fill to MAX_AGENTS total — ids 2..MAX_AGENTS are all CLOSED.
    for (let i = 2; i <= MAX_AGENTS; i++) {
      await withAgentBreaker(customKeyAgent(i), async () => "ok");
    }
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);
    expect(__getTrackedAgentIdsForTest()[0]).toBe(1); // agent 1 is oldest

    // Add one more — should evict a CLOSED entry (the oldest CLOSED = id 2),
    // NOT agent 1 which is OPEN.
    await withAgentBreaker(customKeyAgent(MAX_AGENTS + 1), async () => "ok");
    const tracked = new Set(__getTrackedAgentIdsForTest());
    expect(tracked.has(1)).toBe(true); // OPEN entry preserved
    expect(tracked.has(2)).toBe(false); // oldest non-OPEN evicted
    expect(tracked.has(MAX_AGENTS + 1)).toBe(true);
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);
  });

  it("11: pathological all-OPEN → evicts true oldest", async () => {
    const fail = async () => {
      const e: any = new Error("x");
      e.status = 503;
      throw e;
    };

    // Fill registry with MAX_AGENTS agents, all OPEN. Insertion order == LRU.
    for (let i = 1; i <= MAX_AGENTS; i++) {
      for (let j = 0; j < 5; j++) {
        await expect(withAgentBreaker(customKeyAgent(i), fail)).rejects.toThrow();
      }
    }
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);

    // One more new agent — nothing is non-OPEN to evict, so oldest (id=1) goes.
    await withAgentBreaker(customKeyAgent(MAX_AGENTS + 1), async () => "ok");
    const tracked = new Set(__getTrackedAgentIdsForTest());
    expect(tracked.has(1)).toBe(false);
    expect(tracked.has(MAX_AGENTS + 1)).toBe(true);
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);
  });

  it("12: creating an agent that already exists does NOT trigger eviction", async () => {
    for (let i = 1; i <= MAX_AGENTS; i++) {
      await withAgentBreaker(customKeyAgent(i), async () => "ok");
    }
    const initialTracked = __getTrackedAgentIdsForTest().slice();
    expect(initialTracked).toContain(1);

    // Second call for agent 1 — should NOT evict anyone since agent 1 already
    // has a breaker.
    await withAgentBreaker(customKeyAgent(1), async () => "ok");
    expect(__getAgentBreakerMapSizeForTest()).toBe(MAX_AGENTS);
    const tracked = new Set(__getTrackedAgentIdsForTest());
    for (let i = 1; i <= MAX_AGENTS; i++) {
      expect(tracked.has(i)).toBe(true);
    }
  });
});

describe("openai-per-agent-breaker — observability exports", () => {
  it("13: getAllAgentBreakerStates returns accurate mixed snapshot", async () => {
    const fail = async () => {
      const e: any = new Error("x");
      e.status = 503;
      throw e;
    };

    // Agent 1: OPEN (5 failures).
    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(1), fail)).rejects.toThrow();
    }
    // Agent 2: 3 failures then a success — should still be CLOSED (reset on ok).
    // Actually: 3 failures in CLOSED + success resets consecutiveFailures to 0.
    for (let i = 0; i < 3; i++) {
      await expect(withAgentBreaker(customKeyAgent(2), fail)).rejects.toThrow();
    }
    await withAgentBreaker(customKeyAgent(2), async () => "ok");
    // Agent 3: plain CLOSED.
    await withAgentBreaker(customKeyAgent(3), async () => "ok");

    const snap = getAllAgentBreakerStates();
    const byId = new Map(snap.map((s) => [s.agentId, s]));
    expect(byId.get(1)?.state).toBe("OPEN");
    expect(byId.get(1)?.failures).toBe(5);
    expect(byId.get(2)?.state).toBe("CLOSED");
    expect(byId.get(2)?.failures).toBe(0);
    expect(byId.get(3)?.state).toBe("CLOSED");
    expect(byId.get(3)?.failures).toBe(0);
  });

  it("14: getAgentBreakerSummary counts total + open correctly", async () => {
    const fail = async () => {
      const e: any = new Error("x");
      e.status = 503;
      throw e;
    };

    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(1), fail)).rejects.toThrow();
    }
    for (let i = 0; i < 5; i++) {
      await expect(withAgentBreaker(customKeyAgent(2), fail)).rejects.toThrow();
    }
    await withAgentBreaker(customKeyAgent(3), async () => "ok");

    expect(getAgentBreakerSummary()).toEqual({ total: 3, open: 2 });
  });

  it("15: shared-key traffic is not visible in per-agent observability exports", async () => {
    __setOpenAIClientForTest(makeStubClient());

    // Two shared-key calls and one custom-key call.
    await withAgentBreaker(sharedKeyAgent(100), async () => "ok");
    await withAgentBreaker(sharedKeyAgent(101), async () => "ok");
    await withAgentBreaker(customKeyAgent(5), async () => "ok");

    expect(getAgentBreakerSummary()).toEqual({ total: 1, open: 0 });
    const ids = getAllAgentBreakerStates().map((s) => s.agentId);
    expect(ids).toEqual([5]);
  });
});

describe("openai-per-agent-breaker — test hooks", () => {
  it("16: __setAgentClientForTest injects a stub that subsequent calls receive", async () => {
    // Seed agent 7 so clients map has a fresh (mock-SDK-constructed) entry.
    await withAgentBreaker(customKeyAgent(7), async () => "ok");

    const stub = makeStubClient();
    __setAgentClientForTest(7, stub);

    let received: any;
    await withAgentBreaker(customKeyAgent(7), async (c) => {
      received = c;
      return "ok";
    });
    expect(received).toBe(stub);
  });

  it("17: __resetAllAgentBreakersForTest clears both breakers + clients maps", async () => {
    await withAgentBreaker(customKeyAgent(1), async () => "ok");
    await withAgentBreaker(customKeyAgent(2), async () => "ok");
    expect(__getAgentBreakerMapSizeForTest()).toBe(2);

    __resetAllAgentBreakersForTest();
    expect(__getAgentBreakerMapSizeForTest()).toBe(0);
    expect(__getTrackedAgentIdsForTest()).toEqual([]);
    expect(getAgentBreakerSummary()).toEqual({ total: 0, open: 0 });

    // Calling again should construct a fresh breaker, not reuse old state.
    await withAgentBreaker(customKeyAgent(1), async () => "ok");
    expect(__getAgentBreakerMapSizeForTest()).toBe(1);
  });

  it("18: test hooks throw under NODE_ENV != test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => __setAgentClientForTest(1, {} as any)).toThrow(/NODE_ENV=test/);
      expect(() => __resetAllAgentBreakersForTest()).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

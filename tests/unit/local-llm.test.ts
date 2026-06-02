/**
 * [BRO2-320] Local LLM client + breaker — unit tests (no real Ollama).
 * Verifies: inert-in-prod gate (HAS_LOCAL_LLM false when env unset), the breaker
 * wrapper runs the fn with the injected client, and failures propagate (so
 * callers ABSTAIN rather than silently falling back to a cloud provider).
 */
process.env.NODE_ENV = "test";

import { describe, it, expect, beforeEach } from "vitest";
import {
  HAS_LOCAL_LLM,
  withLocalBreaker,
  getLocalBreakerState,
  __setLocalClientForTest,
  __resetLocalBreakerForTest,
} from "../../server/lib/local-llm";

beforeEach(() => {
  __resetLocalBreakerForTest();
});

describe("local-llm client + breaker", () => {
  it("HAS_LOCAL_LLM is false when LOCAL_LLM_BASE_URL is unset (inert in prod)", () => {
    expect(HAS_LOCAL_LLM).toBe(false);
  });

  it("withLocalBreaker runs the fn with the injected client and returns its result", async () => {
    const stub: any = { id: "stub-client" };
    __setLocalClientForTest(stub);
    const out = await withLocalBreaker(async (client) => {
      expect(client).toBe(stub);
      return "ok";
    });
    expect(out).toBe("ok");
  });

  it("getLocalBreakerState returns a stats object", () => {
    expect(getLocalBreakerState()).toBeTruthy();
  });

  it("a failing local call propagates (no swallow) so callers can ABSTAIN", async () => {
    __setLocalClientForTest({} as any);
    await expect(
      withLocalBreaker(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

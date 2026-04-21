/**
 * Integration test — shared breaker in OPEN state drives graceful fallbacks
 * at each wired call site. See Week 5 plan Item 2.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetOpenAIBreakerForTest,
  __setOpenAIClientForTest,
  withOpenAIBreaker,
  getOpenAIBreakerState,
} from "../lib/openai-client";

async function openCircuit() {
  // Drive 5 consecutive failures (our default failureThreshold).
  for (let i = 0; i < 5; i++) {
    await expect(
      withOpenAIBreaker(async () => { throw new Error("induced"); }),
    ).rejects.toThrow();
  }
  expect(getOpenAIBreakerState().state).toBe("OPEN");
}

describe("cb-integration — breaker OPEN → graceful fallbacks", () => {
  beforeEach(() => {
    __resetOpenAIBreakerForTest();
    __setOpenAIClientForTest({
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: vi.fn() },
    } as any);
  });

  it("embedText returns null when circuit is OPEN", async () => {
    const { embedText } = await import("../embeddings");
    await openCircuit();
    const r = await embedText("hello world");
    expect(r).toBeNull();
  });

  it("scoreEmotion returns null when circuit is OPEN", async () => {
    const { scoreEmotion } = await import("../emotion-scorer");
    await openCircuit();
    const r = await scoreEmotion("content");
    expect(r).toBeNull();
  });

  it("checkSycophancy fails open when circuit is OPEN", async () => {
    const { checkSycophancy } = await import("../sycophancy-checker");
    await openCircuit();
    const r = await checkSycophancy("user msg", "draft reply");
    expect(r).toEqual({ score: 0, issue: null, revised: null });
  });
});

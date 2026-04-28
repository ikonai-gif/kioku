/**
 * LEO PR-A — urgency classifier unit tests.
 *
 * Hard rules (deterministic) MUST run before any LLM call. The LLM seam is
 * replaced with `__setUrgencyLlmForTests` so we never hit the real
 * Anthropic SDK from a unit test. The default-low fallback is the safety
 * blanket — every error path lands on `low`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyUrgency,
  __setUrgencyLlmForTests,
} from "../../server/lib/luca-checkin/urgency";

beforeEach(() => {
  __setUrgencyLlmForTests(null);
  process.env.LUCA_VIP_SENDERS = "kotkave@example.com,boss@example.com";
});

afterEach(() => {
  __setUrgencyLlmForTests(null);
  delete process.env.LUCA_VIP_SENDERS;
});

describe("classifyUrgency — hard rules (no LLM)", () => {
  it("VIP sender → high (no LLM call)", async () => {
    const llmSpy = vi.fn(async () => "low");
    __setUrgencyLlmForTests(llmSpy);
    const result = await classifyUrgency({
      source: "gmail",
      senderEmail: "kotkave@example.com",
      subject: "lunch?",
    });
    expect(result.urgency).toBe("high");
    expect(result.reason).toContain("vip_sender:");
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("VIP match is case-insensitive", async () => {
    const llmSpy = vi.fn(async () => "low");
    __setUrgencyLlmForTests(llmSpy);
    const result = await classifyUrgency({
      source: "gmail",
      senderEmail: "KOTKAVE@EXAMPLE.COM",
    });
    expect(result.urgency).toBe("high");
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("calendar conflict 1h → high (no LLM call)", async () => {
    const llmSpy = vi.fn(async () => "low");
    __setUrgencyLlmForTests(llmSpy);
    const result = await classifyUrgency({
      source: "gcal",
      calendarConflictWithinHours: 1,
    });
    expect(result.urgency).toBe("high");
    expect(result.reason).toBe("calendar_conflict_2h");
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("calendar conflict 4h → no hard rule fires (defers to LLM)", async () => {
    const llmSpy = vi.fn(async () => "low");
    __setUrgencyLlmForTests(llmSpy);
    const result = await classifyUrgency({
      source: "gcal",
      calendarConflictWithinHours: 4,
    });
    expect(result.urgency).toBe("low");
    expect(llmSpy).toHaveBeenCalledTimes(1);
  });

  it("emergency keyword in subject → high", async () => {
    const llmSpy = vi.fn(async () => "low");
    __setUrgencyLlmForTests(llmSpy);
    const result = await classifyUrgency({
      source: "gmail",
      senderEmail: "alice@example.com",
      subject: "URGENT: server is DOWN",
      bodyExcerpt: "deploy is broken",
    });
    expect(result.urgency).toBe("high");
    expect(result.reason).toMatch(/^emergency_keyword:/);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it("emergency keyword in body works too (case-insensitive)", async () => {
    const result = await classifyUrgency({
      source: "gmail",
      subject: "fyi",
      bodyExcerpt: "Production is down right now, need help",
    });
    expect(result.urgency).toBe("high");
    expect(result.reason).toMatch(/^emergency_keyword:/);
  });
});

describe("classifyUrgency — LLM fallback path", () => {
  it("LLM returns 'high' cleanly → high", async () => {
    __setUrgencyLlmForTests(async () => "high");
    const result = await classifyUrgency({
      source: "gmail",
      senderEmail: "alice@example.com",
      subject: "quarterly review",
    });
    expect(result.urgency).toBe("high");
    expect(result.reason).toBe("llm:high");
  });

  it("LLM returns garbled output → low (default)", async () => {
    __setUrgencyLlmForTests(async () => "frobnicate the widget");
    const result = await classifyUrgency({
      source: "manual",
      bodyExcerpt: "hello",
    });
    expect(result.urgency).toBe("low");
    expect(result.reason).toBe("llm_unparseable");
  });

  it("LLM throws → low (default)", async () => {
    __setUrgencyLlmForTests(async () => {
      throw new Error("anthropic_api_500");
    });
    const result = await classifyUrgency({
      source: "manual",
      bodyExcerpt: "hi",
    });
    expect(result.urgency).toBe("low");
    expect(result.reason).toMatch(/^llm_error:/);
  });

  it("LLM returns 'high\\nbecause...' → parses first line as high", async () => {
    __setUrgencyLlmForTests(async () => "high\nbecause it looks urgent");
    const result = await classifyUrgency({
      source: "gmail",
      bodyExcerpt: "review needed",
    });
    expect(result.urgency).toBe("high");
    expect(result.reason).toBe("llm:high");
  });

  it("LLM respects 2s timeout — long delays resolve to low via abort", async () => {
    __setUrgencyLlmForTests((_, __, ___, signal) => {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("high"), 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          (err as any).name = "AbortError";
          reject(err);
        });
      });
    });
    const start = Date.now();
    const result = await classifyUrgency({
      source: "manual",
      bodyExcerpt: "review needed",
    });
    const elapsed = Date.now() - start;
    expect(result.urgency).toBe("low");
    expect(result.reason).toMatch(/^llm_error:/);
    // Allow some scheduling slack but the 2s timeout must clearly cap the wait.
    expect(elapsed).toBeLessThan(3500);
  });

  it("LLM returns case-mixed answer → normalized to lowercase", async () => {
    __setUrgencyLlmForTests(async () => "  Normal\n");
    const result = await classifyUrgency({
      source: "manual",
      bodyExcerpt: "ok",
    });
    expect(result.urgency).toBe("normal");
    expect(result.reason).toBe("llm:normal");
  });
});

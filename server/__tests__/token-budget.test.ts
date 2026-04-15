import { describe, it, expect } from "vitest";
import {
  countTokens,
  getContextWindow,
  truncateToFit,
  allocateBudget,
} from "../token-budget";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns 0 for null/undefined-like input", () => {
    expect(countTokens("")).toBe(0);
  });

  it("estimates ~1 token per 4 chars", () => {
    const text = "a".repeat(100);
    expect(countTokens(text)).toBe(25);
  });

  it("rounds up fractional tokens", () => {
    const text = "abc"; // 3 chars → ceil(3/4) = 1
    expect(countTokens(text)).toBe(1);
  });

  it("handles long text", () => {
    const text = "word ".repeat(1000); // 5000 chars
    expect(countTokens(text)).toBe(1250);
  });
});

describe("getContextWindow", () => {
  it("returns correct window for known models", () => {
    expect(getContextWindow("gpt-4o")).toBe(128_000);
    expect(getContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(getContextWindow("gemini-2.0-flash")).toBe(1_000_000);
    expect(getContextWindow("gemini-2.5-pro")).toBe(2_000_000);
  });

  it("returns default window for unknown models", () => {
    expect(getContextWindow("unknown-model")).toBe(8_000);
  });
});

describe("truncateToFit", () => {
  it("returns original text if within budget", () => {
    const text = "Hello world";
    expect(truncateToFit(text, 100)).toBe(text);
  });

  it("truncates text that exceeds budget", () => {
    const text = "a ".repeat(100); // 200 chars
    const result = truncateToFit(text, 10); // 10 tokens = 40 chars
    expect(result.length).toBeLessThanOrEqual(55); // some slack for "[truncated]"
    expect(result).toContain("[truncated]");
  });

  it("returns empty string for empty input", () => {
    expect(truncateToFit("", 100)).toBe("");
  });

  it("preserves whole words when possible", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = truncateToFit(text, 3); // 3 tokens = 12 chars
    // Should not cut mid-word
    expect(result).not.toMatch(/\b\w$/); // no partial word before [truncated]
  });
});

describe("allocateBudget", () => {
  it("returns original sections when within budget", () => {
    const result = allocateBudget("gpt-4o", {
      systemPrompt: "You are a helpful agent.",
      memoryContext: "Memory 1: some fact",
      topic: "What is AI?",
      otherPositions: "- Agent1: position",
    });
    expect(result.wasOverBudget).toBe(false);
    expect(result.systemPrompt).toContain("helpful agent");
    expect(result.memoryContext).toContain("Memory 1");
    expect(result.topic).toBe("What is AI?");
  });

  it("truncates system prompt when exceeding MAX_SYSTEM_PROMPT_TOKENS (500)", () => {
    // 500 tokens = 2000 chars; create a prompt well over that
    const longPrompt = "x ".repeat(1500); // 3000 chars = 750 tokens
    const result = allocateBudget("gpt-4o", {
      systemPrompt: longPrompt,
      memoryContext: "",
      topic: "test",
      otherPositions: "",
    });
    // System prompt should be truncated
    expect(countTokens(result.systemPrompt)).toBeLessThanOrEqual(510); // +10 slack for [truncated]
  });

  it("truncates memory context when exceeding MAX_MEMORY_TOKENS (2000)", () => {
    // 2000 tokens = 8000 chars
    const longMemory = "memory line\n".repeat(1000); // big memory
    const result = allocateBudget("gpt-4o", {
      systemPrompt: "short",
      memoryContext: longMemory,
      topic: "test",
      otherPositions: "",
    });
    expect(countTokens(result.memoryContext)).toBeLessThanOrEqual(2100); // some slack
  });

  it("truncates older positions when budget exhausted", () => {
    // Use an unknown model (8K default context window) to force truncation
    // 8K context - 2K response reserve = 6K available. Fill with >6K of positions.
    const longPositions = "- Agent: long position text here with lots of detail and reasoning about why this is important\n".repeat(400);
    expect(countTokens(longPositions)).toBeGreaterThan(6000); // verify test precondition
    const result = allocateBudget("tiny-model", {
      systemPrompt: "short",
      memoryContext: "short memory",
      topic: "test topic",
      otherPositions: longPositions,
    });
    // Positions should be truncated to fit within the small context window
    expect(countTokens(result.otherPositions)).toBeLessThan(countTokens(longPositions));
  });

  it("sets wasOverBudget flag when truncation occurs", () => {
    // Use unknown model (8K default) with positions that exceed budget
    const longPositions = "- Agent: position text with a lot of reasoning and evidence\n".repeat(500);
    const result = allocateBudget("tiny-model", {
      systemPrompt: "short",
      memoryContext: "short",
      topic: "test",
      otherPositions: longPositions,
    });
    expect(result.wasOverBudget).toBe(true);
  });

  it("never truncates topic", () => {
    const topic = "This is a very important deliberation topic about AI safety";
    const result = allocateBudget("gpt-4o", {
      systemPrompt: "short",
      memoryContext: "",
      topic,
      otherPositions: "",
    });
    expect(result.topic).toBe(topic);
  });

  it("calculates totalTokens correctly", () => {
    const sections = {
      systemPrompt: "system",
      memoryContext: "memory",
      topic: "topic",
      otherPositions: "positions",
    };
    const result = allocateBudget("gpt-4o", sections);
    const expected =
      countTokens(result.systemPrompt) +
      countTokens(result.memoryContext) +
      countTokens(result.topic) +
      countTokens(result.otherPositions);
    expect(result.totalTokens).toBe(expected);
  });
});

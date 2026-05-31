/**
 * [BRO2-315 #170] Heterogeneity warning (Test E).
 * Pure-function unit tests. Imports the dependency-free helper module
 * directly, so no DB / LLM-client mocks are required.
 */
import { describe, it, expect } from "vitest";
import { assessRoomHeterogeneity } from "../../server/lib/heterogeneity";

const a = (llmProvider: string | null, llmModel: string | null = null) => ({ llmProvider, llmModel });

describe("assessRoomHeterogeneity (#170)", () => {
  it("Test E: 3 agents on the same provider+model → low diversity warning", () => {
    const r = assessRoomHeterogeneity([
      a("openrouter", "anthropic/claude-sonnet-4.6"),
      a("openrouter", "anthropic/claude-sonnet-4.6"),
      a("openrouter", "anthropic/claude-sonnet-4.6"),
    ]);
    expect(r).toEqual({ configured: 3, distinct: 1, low: true });
  });

  it("3 agents across 2+ models → not low", () => {
    const r = assessRoomHeterogeneity([
      a("openai", "gpt-4o"),
      a("openrouter", "anthropic/claude-sonnet-4.6"),
      a("openrouter", "moonshotai/kimi-k2.6"),
    ]);
    expect(r.distinct).toBe(3);
    expect(r.low).toBe(false);
  });

  it("only 2 configured agents (same) → not low (need >= 3)", () => {
    const r = assessRoomHeterogeneity([a("openai", "gpt-4o"), a("openai", "gpt-4o")]);
    expect(r.low).toBe(false);
  });

  it("agents with NULL provider are excluded from the count", () => {
    const r = assessRoomHeterogeneity([
      a("openrouter", "anthropic/claude-sonnet-4.6"),
      a("openrouter", "anthropic/claude-sonnet-4.6"),
      a("openrouter", "anthropic/claude-sonnet-4.6"),
      a(null, null),
      a(null, null),
    ]);
    expect(r).toEqual({ configured: 3, distinct: 1, low: true });
  });

  it("fewer than 3 once NULLs excluded → not low", () => {
    const r = assessRoomHeterogeneity([a("openai", "gpt-4o"), a("openai", "gpt-4o"), a(null, null)]);
    expect(r.low).toBe(false);
  });

  it("empty room → not low, no crash", () => {
    expect(assessRoomHeterogeneity([])).toEqual({ configured: 0, distinct: 0, low: false });
  });
});

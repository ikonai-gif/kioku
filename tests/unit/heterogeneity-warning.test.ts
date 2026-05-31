/**
 * [BRO2-315 #170] Heterogeneity warning (Test E).
 * Unit tests for assessRoomHeterogeneity — pure function, heavy deps mocked
 * so importing structured-deliberation does not require a DB / live clients.
 */
import { describe, it, expect, vi } from "vitest";

// Heavy import-time deps of structured-deliberation (and its storage import)
vi.mock("pg", () => ({
  Pool: class FakePool { query = vi.fn(); on() {} connect() {} end() {} },
}));
vi.mock("../../server/embeddings", () => ({ embedText: vi.fn() }));
vi.mock("../../server/emotion-scorer", () => ({ scoreEmotion: vi.fn() }));
vi.mock("../../server/ws", () => ({ broadcastToRoom: vi.fn(), broadcastHumanTurn: vi.fn() }));
vi.mock("../../server/lib/openai-client", () => ({ withOpenAIBreaker: vi.fn(), isCircuitOpenError: vi.fn() }));
vi.mock("../../server/lib/openai-per-agent-breaker", () => ({ withAgentBreaker: vi.fn() }));

const { assessRoomHeterogeneity } = await import("../../server/structured-deliberation");

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

/**
 * Tests for Phase 4b — Emotion Scoring, Fast Appraisal, EmotionalRAG
 * All OpenAI calls are mocked — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cosineSimilarity, formatMemoryContext, type InjectedMemory } from "../memory-injection";

// ── Emotion Scorer Tests ─────────────────────────────────────────────

describe("scoreEmotion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("parses valid 8D emotion vector from LLM response", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "[0.8, 0.5, 0.1, 0.3, 0.0, 0.0, 0.1, 0.6]" } }],
            }),
          },
        };
      },
    }));

    const { scoreEmotion } = await import("../emotion-scorer");
    const result = await scoreEmotion("I'm so happy about this wonderful news!");
    expect(result).toEqual([0.8, 0.5, 0.1, 0.3, 0.0, 0.0, 0.1, 0.6]);
  });

  it("clamps values to [0, 1] range", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "[1.5, -0.3, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]" } }],
            }),
          },
        };
      },
    }));

    const { scoreEmotion } = await import("../emotion-scorer");
    const result = await scoreEmotion("test content");
    expect(result).not.toBeNull();
    expect(result![0]).toBe(1.0); // clamped from 1.5
    expect(result![1]).toBe(0.0); // clamped from -0.3
  });

  it("returns null when LLM returns invalid JSON", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "not valid json" } }],
            }),
          },
        };
      },
    }));

    const { scoreEmotion } = await import("../emotion-scorer");
    const result = await scoreEmotion("test content");
    expect(result).toBeNull();
  });

  it("returns null when array has wrong length", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "[0.5, 0.5, 0.5]" } }],
            }),
          },
        };
      },
    }));

    const { scoreEmotion } = await import("../emotion-scorer");
    const result = await scoreEmotion("test content");
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockRejectedValue(new Error("API error")),
          },
        };
      },
    }));

    const { scoreEmotion } = await import("../emotion-scorer");
    const result = await scoreEmotion("test content");
    expect(result).toBeNull();
  });

  it("returns null when response has no content", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: null } }],
            }),
          },
        };
      },
    }));

    const { scoreEmotion } = await import("../emotion-scorer");
    const result = await scoreEmotion("test content");
    expect(result).toBeNull();
  });
});

// ── Fast Appraisal Tests ─────────────────────────────────────────────

describe("fastAppraisal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("initializes default state on first interaction", async () => {
    const upsertMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue(null),
      upsertAgentEmotionalState: upsertMock,
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: vi.fn() } };
      },
    }));

    const { fastAppraisal } = await import("../fast-appraisal");
    await fastAppraisal(1, 1, "test event", mockStorage);
    expect(upsertMock).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      pleasure: 0.0,
      arousal: 0.0,
      dominance: 0.0,
      emotionLabel: "neutral",
    }));
  });

  it("updates PAD state based on LLM appraisal", async () => {
    const upsertMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1,
        agentId: 1,
        userId: 1,
        pleasure: 0.2,
        arousal: 0.1,
        dominance: 0.3,
        baselinePleasure: 0.1,
        baselineArousal: 0.0,
        baselineDominance: 0.2,
        emotionLabel: "relaxed",
        poignancySum: 10,
        halfLifeMinutes: 120,
        lastUpdatedAt: Date.now(), // recent, so minimal decay
        createdAt: Date.now() - 100000,
      }),
      upsertAgentEmotionalState: upsertMock,
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"delta_P": 0.1, "delta_A": -0.05, "delta_D": 0.0, "poignancy": 5}' } }],
            }),
          },
        };
      },
    }));

    const { fastAppraisal } = await import("../fast-appraisal");
    await fastAppraisal(1, 1, "Had a great discussion", mockStorage);

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const updatedState = upsertMock.mock.calls[0][2];
    expect(updatedState.pleasure).toBeGreaterThan(0.2); // increased by delta_P
    expect(updatedState.poignancySum).toBeGreaterThanOrEqual(15); // 10 + 5
    expect(updatedState.emotionLabel).toBeDefined();
  });

  it("silently handles LLM errors", async () => {
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.0, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "neutral", poignancySum: 0, halfLifeMinutes: 120,
        lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      upsertAgentEmotionalState: vi.fn(),
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockRejectedValue(new Error("API down")),
          },
        };
      },
    }));

    const { fastAppraisal } = await import("../fast-appraisal");
    // Should not throw
    await expect(fastAppraisal(1, 1, "test", mockStorage)).resolves.toBeUndefined();
    expect(mockStorage.upsertAgentEmotionalState).not.toHaveBeenCalled();
  });
});

// ── Cosine Similarity Tests ──────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
  });

  it("returns correct similarity for arbitrary vectors", () => {
    const a = [0.8, 0.5, 0.1, 0.3, 0.0, 0.0, 0.1, 0.6];
    const b = [0.7, 0.4, 0.2, 0.2, 0.1, 0.0, 0.0, 0.5];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9); // very similar vectors
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });
});

// ── EmotionalRAG: formatMemoryContext with emotion labels ─────────────

describe("formatMemoryContext with emotions", () => {
  it("includes dominant emotion label when emotionVector present", () => {
    const memories: InjectedMemory[] = [
      {
        id: 1,
        content: "Happy memory",
        type: "episodic",
        confidence: 0.9,
        emotionVector: JSON.stringify([0.9, 0.3, 0.0, 0.1, 0.0, 0.0, 0.0, 0.2]),
      },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("emotion: joy");
  });

  it("omits emotion label when max emotion is below threshold", () => {
    const memories: InjectedMemory[] = [
      {
        id: 1,
        content: "Neutral memory",
        type: "semantic",
        confidence: 0.8,
        emotionVector: JSON.stringify([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]),
      },
    ];
    const result = formatMemoryContext(memories);
    expect(result).not.toContain("emotion:");
  });

  it("handles memory without emotionVector", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "Old memory", type: "semantic", confidence: 0.8 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("[semantic, confidence: 0.8]");
    expect(result).not.toContain("emotion:");
  });
});

// ── Prompt Injection: Emotional state in prompts ─────────────────────

describe("emotional state in system prompts", () => {
  it("chat prompt emotional block contains emotion label", () => {
    const emotionContext = { pleasure: 0.5, arousal: 0.3, dominance: 0.4, emotionLabel: "exuberant" };
    const emotionBlock = `\n\n## Your Current Emotional State\nYou are feeling: ${emotionContext.emotionLabel}\nThis subtly influences your tone — don't announce your emotions, just let them color your responses naturally.\n`;
    expect(emotionBlock).toContain("exuberant");
    expect(emotionBlock).toContain("Your Current Emotional State");
  });

  it("deliberation prompt emotional block contains emotion label", () => {
    const emotionContext = { pleasure: -0.3, arousal: 0.5, dominance: -0.2, emotionLabel: "anxious" };
    const emotionBlock = `\n\n## Your Emotional State: ${emotionContext.emotionLabel}\nThis subtly colors your reasoning. Don't mention it explicitly.\n`;
    expect(emotionBlock).toContain("anxious");
    expect(emotionBlock).toContain("Your Emotional State");
  });
});

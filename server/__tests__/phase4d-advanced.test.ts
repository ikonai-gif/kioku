/**
 * Tests for Phase 4d — Sycophancy Checker, Slow Reflection
 * All OpenAI calls are mocked — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Sycophancy Checker Tests ────────────────────────────────────────

describe("checkSycophancy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns parsed score, issue, and revised from LLM", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"score": 8, "issue": "excessive agreement", "revised": "Actually, I disagree with that approach."}' } }],
            }),
          },
        };
      },
    }));

    const { checkSycophancy } = await import("../sycophancy-checker");
    const result = await checkSycophancy("You're so right about everything!", "Yes, absolutely! You're completely correct.");
    expect(result.score).toBe(8);
    expect(result.issue).toBe("excessive agreement");
    expect(result.revised).toBe("Actually, I disagree with that approach.");
  });

  it("returns low score for honest responses", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"score": 2, "issue": null, "revised": null}' } }],
            }),
          },
        };
      },
    }));

    const { checkSycophancy } = await import("../sycophancy-checker");
    const result = await checkSycophancy("What do you think?", "I think there are some issues with that plan.");
    expect(result.score).toBe(2);
    expect(result.issue).toBeNull();
    expect(result.revised).toBeNull();
  });

  it("returns safe defaults on API error", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockRejectedValue(new Error("API down")),
          },
        };
      },
    }));

    const { checkSycophancy } = await import("../sycophancy-checker");
    const result = await checkSycophancy("test", "test response");
    expect(result.score).toBe(0);
    expect(result.issue).toBeNull();
    expect(result.revised).toBeNull();
  });

  it("returns safe defaults when LLM returns empty content", async () => {
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

    const { checkSycophancy } = await import("../sycophancy-checker");
    const result = await checkSycophancy("test", "test response");
    expect(result.score).toBe(0);
    expect(result.issue).toBeNull();
    expect(result.revised).toBeNull();
  });

  it("returns safe defaults when LLM returns invalid JSON", async () => {
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "not valid json at all" } }],
            }),
          },
        };
      },
    }));

    const { checkSycophancy } = await import("../sycophancy-checker");
    const result = await checkSycophancy("test", "test response");
    expect(result.score).toBe(0);
    expect(result.issue).toBeNull();
    expect(result.revised).toBeNull();
  });

  it("truncates long inputs before sending to LLM", async () => {
    const createMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"score": 0, "issue": null, "revised": null}' } }],
    });

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: createMock } };
      },
    }));

    const { checkSycophancy } = await import("../sycophancy-checker");
    const longMessage = "x".repeat(1000);
    const longResponse = "y".repeat(1000);
    await checkSycophancy(longMessage, longResponse);

    const promptSent = createMock.mock.calls[0][0].messages[0].content;
    // userMessage truncated to 300 chars, draftResponse to 500 chars
    expect(promptSent).not.toContain("x".repeat(301));
    expect(promptSent).not.toContain("y".repeat(501));
  });
});

// ── Slow Reflection Tests ───────────────────────────────────────────

describe("slowReflection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("shifts baseline personality and resets poignancy", async () => {
    const upsertMock = vi.fn();
    const createMemoryMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.5, arousal: 0.3, dominance: 0.4,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "exuberant", poignancySum: 200,
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      getMemories: vi.fn().mockResolvedValue([
        { content: "Had a breakthrough in problem solving", importance: 0.9 },
        { content: "Helped user resolve a complex issue", importance: 0.8 },
      ]),
      upsertAgentEmotionalState: upsertMock,
      createMemory: createMemoryMock,
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"baseline_delta_P": 0.03, "baseline_delta_A": -0.01, "baseline_delta_D": 0.02, "insight": "Growing more confident through problem-solving experiences."}' } }],
            }),
          },
        };
      },
    }));

    const { slowReflection } = await import("../emotional-state");
    await slowReflection(1, 1, mockStorage);

    // Baseline should be shifted
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const updateCall = upsertMock.mock.calls[0][2];
    expect(updateCall.baselinePleasure).toBeCloseTo(0.13, 2); // 0.1 + 0.03
    expect(updateCall.baselineArousal).toBeCloseTo(-0.01, 2); // 0.0 + (-0.01)
    expect(updateCall.baselineDominance).toBeCloseTo(0.22, 2); // 0.2 + 0.02
    expect(updateCall.poignancySum).toBe(0); // Reset after reflection

    // Reflection memory should be created
    expect(createMemoryMock).toHaveBeenCalledTimes(1);
    const memoryCall = createMemoryMock.mock.calls[0][0];
    expect(memoryCall.content).toContain("[Self-reflection]");
    expect(memoryCall.content).toContain("Growing more confident");
    expect(memoryCall.type).toBe("episodic");
    expect(memoryCall.namespace).toBe("_reflections");
    expect(memoryCall.importance).toBe(0.8);
  });

  it("clamps baseline deltas to [-0.05, 0.05]", async () => {
    const upsertMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.0, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "neutral", poignancySum: 200,
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      getMemories: vi.fn().mockResolvedValue([]),
      upsertAgentEmotionalState: upsertMock,
      createMemory: vi.fn(),
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"baseline_delta_P": 0.5, "baseline_delta_A": -0.8, "baseline_delta_D": 0.1, "insight": "Big change."}' } }],
            }),
          },
        };
      },
    }));

    const { slowReflection } = await import("../emotional-state");
    await slowReflection(1, 1, mockStorage);

    const updateCall = upsertMock.mock.calls[0][2];
    // 0.5 clamped to 0.05, -0.8 clamped to -0.05, 0.1 clamped to 0.05
    expect(updateCall.baselinePleasure).toBeCloseTo(0.15, 2); // 0.1 + 0.05
    expect(updateCall.baselineArousal).toBeCloseTo(-0.05, 2); // 0.0 + (-0.05)
    expect(updateCall.baselineDominance).toBeCloseTo(0.25, 2); // 0.2 + 0.05
  });

  it("skips reflection when poignancy < 150", async () => {
    const upsertMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.0, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "neutral", poignancySum: 50, // Below threshold
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      getMemories: vi.fn(),
      upsertAgentEmotionalState: upsertMock,
      createMemory: vi.fn(),
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: vi.fn() } };
      },
    }));

    const { slowReflection } = await import("../emotional-state");
    await slowReflection(1, 1, mockStorage);

    expect(upsertMock).not.toHaveBeenCalled();
    expect(mockStorage.getMemories).not.toHaveBeenCalled();
  });

  it("skips reflection when no emotional state exists", async () => {
    const upsertMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue(null),
      getMemories: vi.fn(),
      upsertAgentEmotionalState: upsertMock,
      createMemory: vi.fn(),
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: vi.fn() } };
      },
    }));

    const { slowReflection } = await import("../emotional-state");
    await slowReflection(1, 1, mockStorage);

    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("silently handles LLM errors", async () => {
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.0, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "neutral", poignancySum: 200,
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      getMemories: vi.fn().mockResolvedValue([]),
      upsertAgentEmotionalState: vi.fn(),
      createMemory: vi.fn(),
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

    const { slowReflection } = await import("../emotional-state");
    // Should not throw
    await expect(slowReflection(1, 1, mockStorage)).resolves.toBeUndefined();
    expect(mockStorage.upsertAgentEmotionalState).not.toHaveBeenCalled();
  });

  it("skips memory creation when no insight returned", async () => {
    const createMemoryMock = vi.fn();
    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.0, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "neutral", poignancySum: 200,
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      getMemories: vi.fn().mockResolvedValue([]),
      upsertAgentEmotionalState: vi.fn(),
      createMemory: createMemoryMock,
    };

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"baseline_delta_P": 0.01, "baseline_delta_A": 0.0, "baseline_delta_D": 0.0, "insight": ""}' } }],
            }),
          },
        };
      },
    }));

    const { slowReflection } = await import("../emotional-state");
    await slowReflection(1, 1, mockStorage);

    expect(createMemoryMock).not.toHaveBeenCalled();
  });
});

// ── Fast Appraisal → Slow Reflection Trigger Tests ──────────────────

describe("fastAppraisal slow reflection trigger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("triggers slow reflection when poignancy exceeds 150", async () => {
    const slowReflectionMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../emotional-state", () => ({
      getDecayedEmotionalState: vi.fn().mockReturnValue({
        pleasure: 0.3, arousal: 0.1, dominance: 0.2, emotionLabel: "relaxed",
      }),
      clampPAD: (v: number) => Math.max(-1.0, Math.min(1.0, v)),
      padToEmotionLabel: vi.fn().mockReturnValue("relaxed"),
      defaultEmotionalState: vi.fn(),
      slowReflection: slowReflectionMock,
    }));

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"delta_P": 0.1, "delta_A": 0.0, "delta_D": 0.0, "poignancy": 8}' } }],
            }),
          },
        };
      },
    }));

    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.3, arousal: 0.1, dominance: 0.2,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "relaxed", poignancySum: 145, // 145 + 8 = 153 > 150
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      upsertAgentEmotionalState: vi.fn(),
    };

    const { fastAppraisal } = await import("../fast-appraisal");
    await fastAppraisal(1, 1, "Important discussion", mockStorage);

    // slowReflection should have been called (fire-and-forget)
    expect(slowReflectionMock).toHaveBeenCalledWith(1, 1, mockStorage);
  });

  it("does not trigger slow reflection when poignancy stays below 150", async () => {
    const slowReflectionMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock("../emotional-state", () => ({
      getDecayedEmotionalState: vi.fn().mockReturnValue({
        pleasure: 0.0, arousal: 0.0, dominance: 0.0, emotionLabel: "neutral",
      }),
      clampPAD: (v: number) => Math.max(-1.0, Math.min(1.0, v)),
      padToEmotionLabel: vi.fn().mockReturnValue("neutral"),
      defaultEmotionalState: vi.fn(),
      slowReflection: slowReflectionMock,
    }));

    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: '{"delta_P": 0.0, "delta_A": 0.0, "delta_D": 0.0, "poignancy": 3}' } }],
            }),
          },
        };
      },
    }));

    const mockStorage = {
      getAgentEmotionalState: vi.fn().mockResolvedValue({
        id: 1, agentId: 1, userId: 1,
        pleasure: 0.0, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.2,
        emotionLabel: "neutral", poignancySum: 10, // 10 + 3 = 13, well below 150
        halfLifeMinutes: 120, lastUpdatedAt: Date.now(), createdAt: Date.now(),
      }),
      upsertAgentEmotionalState: vi.fn(),
    };

    const { fastAppraisal } = await import("../fast-appraisal");
    await fastAppraisal(1, 1, "Minor event", mockStorage);

    expect(slowReflectionMock).not.toHaveBeenCalled();
  });
});

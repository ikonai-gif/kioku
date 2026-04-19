/**
 * KIOKU™ Memory Core — Unit Tests
 *
 * Tests memory decay, confidence decay, cosine similarity,
 * memory injection scoring/filtering, and memory context formatting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeDecayedStrength, computeDecayedConfidence } from "../../server/memory-decay";
import { cosineSimilarity, formatMemoryContext, type InjectedMemory, type MemoryLink } from "../../server/memory-injection";
import { DAY_MS, HOUR_MS, createMockMemory } from "../helpers/setup";

// ── Strength Decay ──────────────────────────────────────────────────

describe("Memory Strength Decay", () => {
  const baseTime = 1700000000000; // fixed timestamp for reproducibility

  describe("type-specific half-lives", () => {
    const types = [
      { type: "emotional", halfLife: 30 },
      { type: "semantic", halfLife: 14 },
      { type: "episodic", halfLife: 7 },
      { type: "temporal", halfLife: 14 },
      { type: "causal", halfLife: 14 },
      { type: "contextual", halfLife: 14 },
      { type: "aesthetic", halfLife: 365 },
    ];

    for (const { type, halfLife } of types) {
      it(`${type} memories halve after ${halfLife} days`, () => {
        const result = computeDecayedStrength(1.0, type, baseTime, null, 0, baseTime + halfLife * DAY_MS);
        expect(result).toBeCloseTo(0.5, 1);
      });
    }

    it("procedural memories never decay", () => {
      const result = computeDecayedStrength(0.9, "procedural", baseTime, null, 0, baseTime + 1000 * DAY_MS);
      expect(result).toBe(0.9);
    });

    it("unknown types default to 14-day half-life", () => {
      const result = computeDecayedStrength(1.0, "made_up_type", baseTime, null, 0, baseTime + 14 * DAY_MS);
      expect(result).toBeCloseTo(0.5, 1);
    });
  });

  describe("decay over simulated time periods", () => {
    it("1 day: semantic memory retains ~95%", () => {
      const s = computeDecayedStrength(1.0, "semantic", baseTime, null, 0, baseTime + 1 * DAY_MS);
      expect(s).toBeGreaterThan(0.9);
      expect(s).toBeLessThan(1.0);
    });

    it("7 days: episodic memory at ~50%", () => {
      const s = computeDecayedStrength(1.0, "episodic", baseTime, null, 0, baseTime + 7 * DAY_MS);
      expect(s).toBeCloseTo(0.5, 1);
    });

    it("30 days: semantic memory at ~22%", () => {
      // 30/14 ≈ 2.14 half-lives → 0.5^2.14 ≈ 0.227
      const s = computeDecayedStrength(1.0, "semantic", baseTime, null, 0, baseTime + 30 * DAY_MS);
      expect(s).toBeCloseTo(Math.pow(0.5, 30 / 14), 2);
    });

    it("90 days: emotional memory at ~12.5%", () => {
      // 90/30 = 3 half-lives → 0.5^3 = 0.125
      const s = computeDecayedStrength(1.0, "emotional", baseTime, null, 0, baseTime + 90 * DAY_MS);
      expect(s).toBeCloseTo(0.125, 2);
    });

    it("converges to zero after many half-lives", () => {
      const s = computeDecayedStrength(1.0, "episodic", baseTime, null, 0, baseTime + 100 * DAY_MS);
      expect(s).toBeLessThan(0.0001);
    });
  });

  describe("access reinforcement", () => {
    it("0 accesses: reinforcement factor = 1.0", () => {
      const s = computeDecayedStrength(0.5, "semantic", baseTime, null, 0, baseTime);
      expect(s).toBeCloseTo(0.5, 5);
    });

    it("5 accesses: reinforcement factor = 1.5", () => {
      const s = computeDecayedStrength(0.5, "semantic", baseTime, null, 5, baseTime);
      expect(s).toBeCloseTo(0.75, 5);
    });

    it("10 accesses: reinforcement caps at 2.0", () => {
      const s10 = computeDecayedStrength(0.5, "semantic", baseTime, null, 10, baseTime);
      const s20 = computeDecayedStrength(0.5, "semantic", baseTime, null, 20, baseTime);
      expect(s10).toBeCloseTo(1.0, 5);
      expect(s20).toBeCloseTo(1.0, 5); // capped
    });

    it("reinforcement combines with decay", () => {
      // 14 days semantic: decay=0.5, 5 accesses reinforcement=1.5
      // 1.0 * 0.5 * 1.5 = 0.75
      const s = computeDecayedStrength(1.0, "semantic", baseTime, null, 5, baseTime + 14 * DAY_MS);
      expect(s).toBeCloseTo(0.75, 1);
    });
  });

  describe("lastAccessedAt reference", () => {
    it("uses lastAccessedAt over createdAt when available", () => {
      const accessed = baseTime + 10 * DAY_MS;
      const now = accessed + 14 * DAY_MS;
      const s = computeDecayedStrength(1.0, "semantic", baseTime, accessed, 0, now);
      // 14 days from last access → ~0.5
      expect(s).toBeCloseTo(0.5, 1);
    });

    it("falls back to createdAt when lastAccessedAt is null", () => {
      const now = baseTime + 14 * DAY_MS;
      const s = computeDecayedStrength(1.0, "semantic", baseTime, null, 0, now);
      expect(s).toBeCloseTo(0.5, 1);
    });
  });

  describe("output clamping", () => {
    it("never returns negative values", () => {
      const s = computeDecayedStrength(0.01, "episodic", baseTime, null, 0, baseTime + 500 * DAY_MS);
      expect(s).toBeGreaterThanOrEqual(0);
    });

    it("never returns values above 1.0", () => {
      // High reinforcement: 1.0 * 1.0 * 2.0 = 2.0 → clamped to 1.0
      const s = computeDecayedStrength(1.0, "semantic", baseTime, null, 15, baseTime);
      expect(s).toBeLessThanOrEqual(1.0);
    });
  });
});

// ── Confidence Decay ────────────────────────────────────────────────

describe("Memory Confidence Decay", () => {
  const baseTime = 1700000000000;

  describe("7-type decay simulation", () => {
    // Each memory type can have different decay rates set per-memory.
    // These tests simulate realistic decay rates for each type.

    const typeDecayRates = [
      { type: "semantic", decayRate: 0.01, description: "semantic: slow decay" },
      { type: "episodic", decayRate: 0.03, description: "episodic: moderate decay" },
      { type: "procedural", decayRate: 0.001, description: "procedural: near-zero decay" },
      { type: "temporal", decayRate: 0.05, description: "temporal: fast decay" },
      { type: "causal", decayRate: 0.02, description: "causal: moderate decay" },
      { type: "contextual", decayRate: 0.04, description: "contextual: faster decay" },
      { type: "emotional", decayRate: 0.005, description: "emotional: very slow decay" },
    ];

    for (const { type, decayRate, description } of typeDecayRates) {
      it(`${description} — 1 day`, () => {
        const c = computeDecayedConfidence(1.0, decayRate, null, baseTime, baseTime + 1 * DAY_MS);
        const expected = Math.exp(-decayRate * 1);
        expect(c).toBeCloseTo(expected, 4);
      });

      it(`${description} — 7 days`, () => {
        const c = computeDecayedConfidence(1.0, decayRate, null, baseTime, baseTime + 7 * DAY_MS);
        const expected = Math.exp(-decayRate * 7);
        expect(c).toBeCloseTo(expected, 4);
      });

      it(`${description} — 30 days`, () => {
        const c = computeDecayedConfidence(1.0, decayRate, null, baseTime, baseTime + 30 * DAY_MS);
        const expected = Math.exp(-decayRate * 30);
        expect(c).toBeCloseTo(expected, 4);
      });
    }
  });

  describe("decay rate edge cases", () => {
    it("decayRate=0 means no decay", () => {
      const c = computeDecayedConfidence(0.9, 0, null, baseTime, baseTime + 365 * DAY_MS);
      expect(c).toBe(0.9);
    });

    it("negative decayRate returns original confidence", () => {
      const c = computeDecayedConfidence(0.8, -0.1, null, baseTime, baseTime + 100 * DAY_MS);
      expect(c).toBe(0.8);
    });

    it("very high decayRate approaches zero quickly", () => {
      const c = computeDecayedConfidence(1.0, 1.0, null, baseTime, baseTime + 5 * DAY_MS);
      expect(c).toBeLessThan(0.01);
    });
  });

  describe("reinforcement resets decay reference", () => {
    it("uses lastReinforcedAt as reference time", () => {
      const reinforced = baseTime + 50 * DAY_MS;
      const now = reinforced + 10 * DAY_MS; // only 10 days since reinforcement
      const c = computeDecayedConfidence(0.9, 0.01, reinforced, baseTime, now);
      expect(c).toBeCloseTo(0.9 * Math.exp(-0.01 * 10), 3);
    });

    it("falls back to createdAt when no reinforcement", () => {
      const c = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 30 * DAY_MS);
      expect(c).toBeCloseTo(0.9 * Math.exp(-0.01 * 30), 3);
    });
  });

  describe("confidence threshold (0.3) boundary", () => {
    // This is the threshold used in memory injection filtering
    it("confidence stays above 0.3 for ~100 days at rate 0.01", () => {
      const c100 = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 100 * DAY_MS);
      expect(c100).toBeGreaterThan(0.3);
    });

    it("confidence drops below 0.3 by ~120 days at rate 0.01", () => {
      const c120 = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 120 * DAY_MS);
      expect(c120).toBeLessThan(0.3);
    });
  });

  describe("output clamping", () => {
    it("clamps to [0, 1]", () => {
      const c = computeDecayedConfidence(1.0, 0.01, null, baseTime, baseTime + 1 * DAY_MS);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1.0);
    });
  });
});

// ── Cosine Similarity ───────────────────────────────────────────────

describe("Cosine Similarity", () => {
  it("identical vectors have similarity 1.0", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
  });

  it("opposite vectors have similarity -1.0", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it("orthogonal vectors have similarity 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("handles zero vectors gracefully", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("handles mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("handles empty arrays", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("computes correctly for arbitrary vectors", () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const dot = 1 * 4 + 2 * 5 + 3 * 6; // 32
    const magA = Math.sqrt(1 + 4 + 9); // sqrt(14)
    const magB = Math.sqrt(16 + 25 + 36); // sqrt(77)
    const expected = dot / (magA * magB);
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
  });

  it("8D emotion vectors", () => {
    const joyful = [0.9, 0.7, 0.1, 0.2, 0.0, 0.0, 0.0, 0.5];
    const sad = [0.0, 0.1, 0.3, 0.0, 0.9, 0.2, 0.1, 0.0];
    const sim = cosineSimilarity(joyful, sad);
    // Very different emotional states — should be low similarity
    expect(sim).toBeLessThan(0.5);
    expect(sim).toBeGreaterThan(-0.5);
  });
});

// ── Memory Context Formatting ───────────────────────────────────────

describe("formatMemoryContext", () => {
  it("returns empty string for no memories", () => {
    expect(formatMemoryContext([])).toBe("");
  });

  it("formats identity memories in WHO YOU ARE section", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "I am a security analyst", type: "identity", confidence: 1.0 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("WHO YOU ARE");
    expect(result).toContain("I am a security analyst");
  });

  it("formats episode summaries in RECENT CONVERSATIONS section", () => {
    const memories: InjectedMemory[] = [
      { id: 2, content: "We discussed API design patterns", type: "episodic", confidence: 1.0, namespace: "_episode_summaries" },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("RECENT CONVERSATIONS");
    expect(result).toContain("API design patterns");
  });

  it("formats topic-relevant memories with type and confidence tags", () => {
    const memories: InjectedMemory[] = [
      { id: 3, content: "PostgreSQL index optimization", type: "semantic", confidence: 0.85 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("Your Memories");
    expect(result).toContain("[semantic, confidence: 0.85]");
    expect(result).toContain("PostgreSQL index optimization");
  });

  it("includes emotion tag for high-intensity emotion vectors", () => {
    const memories: InjectedMemory[] = [
      {
        id: 4,
        content: "The project launch was exciting",
        type: "episodic",
        confidence: 0.9,
        emotionVector: JSON.stringify([0.9, 0.5, 0.0, 0.4, 0.0, 0.0, 0.0, 0.7]),
      },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("emotion: joy");
  });

  it("includes expiry date for temporal memories", () => {
    const memories: InjectedMemory[] = [
      {
        id: 5,
        content: "Sprint deadline approaching",
        type: "temporal",
        confidence: 0.7,
        expiresAt: new Date("2025-12-31").getTime(),
      },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("expires: 2025-12-31");
  });

  it("formats associative links between memories", () => {
    const memories: InjectedMemory[] = [
      { id: 10, content: "Memory A about databases", type: "semantic", confidence: 0.8 },
      { id: 11, content: "Memory B about indexing", type: "semantic", confidence: 0.7 },
    ];
    const links: MemoryLink[] = [
      { sourceId: 10, targetId: 11, type: "related", strength: 0.85 },
    ];
    const result = formatMemoryContext(memories, links);
    expect(result).toContain("related");
    expect(result).toContain("Memory B about indexing");
  });

  it("separates identity, episodes, and topic memories correctly", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "My core identity", type: "identity", confidence: 1.0 },
      { id: 2, content: "Recent chat about X", type: "episodic", confidence: 1.0, namespace: "_episode_summaries" },
      { id: 3, content: "Relevant fact", type: "semantic", confidence: 0.9 },
    ];
    const result = formatMemoryContext(memories);
    const whoYouAre = result.indexOf("WHO YOU ARE");
    const recent = result.indexOf("RECENT CONVERSATIONS");
    const topic = result.indexOf("Your Memories");
    expect(whoYouAre).toBeLessThan(recent);
    expect(recent).toBeLessThan(topic);
  });
});

// ── Bi-directional Memory Coupling ──────────────────────────────────

describe("Memory Coupling (conceptual)", () => {
  it("memories created during deliberation get contextTrigger linking them back", () => {
    const sessionId = "dlb_1_1700000000000";
    const memory = createMockMemory({
      type: "procedural",
      namespace: "decisions",
      contextTrigger: `deliberation:${sessionId}`,
    });
    expect(memory.contextTrigger).toBe(`deliberation:${sessionId}`);
    expect(memory.namespace).toBe("decisions");
  });

  it("per-agent position memories link to deliberation session", () => {
    const sessionId = "dlb_1_1700000000000";
    const memory = createMockMemory({
      type: "episodic",
      namespace: "deliberation_positions",
      contextTrigger: `deliberation:${sessionId}`,
      importance: 0.64, // confidence * 0.8
    });
    expect(memory.contextTrigger).toContain("deliberation:");
    expect(memory.namespace).toBe("deliberation_positions");
  });
});

/**
 * Tests for Partner API — emotional state endpoint logic, relationship mapping,
 * and partner status combined endpoint behavior.
 */
import { describe, it, expect } from "vitest";
import {
  getDecayedEmotionalState,
  padToEmotionLabel,
  defaultEmotionalState,
} from "../emotional-state";
import type { EmotionalState } from "../emotional-state";

// ── Emotional State Endpoint Logic ──────────────────────────────

describe("GET /api/agents/:agentId/emotional-state logic", () => {
  it("returns decayed state for a given emotional state", () => {
    const state: EmotionalState = {
      id: 1,
      agentId: 1,
      userId: 1,
      pleasure: 0.8,
      arousal: 0.5,
      dominance: 0.3,
      baselinePleasure: 0.1,
      baselineArousal: 0.0,
      baselineDominance: 0.2,
      emotionLabel: "exuberant",
      poignancySum: 42.5,
      halfLifeMinutes: 120,
      lastUpdatedAt: Date.now() - 120 * 60 * 1000, // 1 half-life ago
      createdAt: Date.now() - 86400000,
    };

    const decayed = getDecayedEmotionalState(state);
    // After one half-life, pleasure should be ~baseline + 0.5*(current-baseline)
    expect(decayed.pleasure).toBeCloseTo(0.45, 1);
    expect(decayed.arousal).toBeCloseTo(0.25, 1);
    expect(decayed.dominance).toBeCloseTo(0.25, 1);
    expect(typeof decayed.emotionLabel).toBe("string");
  });

  it("returns neutral for default emotional state", () => {
    const defaults = defaultEmotionalState();
    expect(defaults.emotionLabel).toBe("neutral");
    expect(defaults.pleasure).toBe(0.0);
    expect(defaults.arousal).toBe(0.0);
    expect(defaults.dominance).toBe(0.0);
  });

  it("returns original state when no time has passed", () => {
    const now = Date.now();
    const state: EmotionalState = {
      id: 1,
      agentId: 1,
      userId: 1,
      pleasure: 0.6,
      arousal: 0.4,
      dominance: 0.3,
      baselinePleasure: 0.1,
      baselineArousal: 0.0,
      baselineDominance: 0.2,
      emotionLabel: "exuberant",
      poignancySum: 10,
      halfLifeMinutes: 120,
      lastUpdatedAt: now,
      createdAt: now,
    };

    const decayed = getDecayedEmotionalState(state, now);
    expect(decayed.pleasure).toBeCloseTo(0.6, 5);
    expect(decayed.arousal).toBeCloseTo(0.4, 5);
    expect(decayed.dominance).toBeCloseTo(0.3, 5);
  });
});

// ── Relationship Endpoint Logic ─────────────────────────────────

describe("GET /api/agents/:agentId/relationship/:userId logic", () => {
  it("returns default values when no relationship exists", () => {
    const defaults = {
      trustLevel: 0,
      familiarity: 0,
      interactionCount: 0,
      sharedReferences: [],
      emotionalHistory: [],
    };

    expect(defaults.trustLevel).toBe(0);
    expect(defaults.familiarity).toBe(0);
    expect(defaults.interactionCount).toBe(0);
    expect(Array.isArray(defaults.sharedReferences)).toBe(true);
    expect(Array.isArray(defaults.emotionalHistory)).toBe(true);
  });

  it("returns populated relationship data", () => {
    const rel = {
      trustLevel: 0.45,
      familiarity: 0.67,
      interactionCount: 134,
      sharedReferences: [1, 2, 3],
      emotionalHistory: [{ emotion: "relaxed", timestamp: Date.now() }],
    };

    expect(rel.trustLevel).toBe(0.45);
    expect(rel.familiarity).toBe(0.67);
    expect(rel.interactionCount).toBe(134);
    expect(rel.sharedReferences).toHaveLength(3);
    expect(rel.emotionalHistory).toHaveLength(1);
  });
});

// ── Partner Status Endpoint Logic ───────────────────────────────

describe("GET /api/partner/status logic", () => {
  it("maps trust level to correct label", () => {
    const mapTrust = (t: number) => t > 0.7 ? "high" : t > 0.3 ? "moderate" : "new";

    expect(mapTrust(0.8)).toBe("high");
    expect(mapTrust(0.71)).toBe("high");
    expect(mapTrust(0.7)).toBe("moderate");
    expect(mapTrust(0.5)).toBe("moderate");
    expect(mapTrust(0.31)).toBe("moderate");
    expect(mapTrust(0.3)).toBe("new");
    expect(mapTrust(0.1)).toBe("new");
    expect(mapTrust(0)).toBe("new");
  });

  it("maps familiarity level to correct label", () => {
    const mapFam = (f: number) => f > 0.7 ? "close" : f > 0.3 ? "familiar" : "stranger";

    expect(mapFam(0.9)).toBe("close");
    expect(mapFam(0.71)).toBe("close");
    expect(mapFam(0.5)).toBe("familiar");
    expect(mapFam(0.31)).toBe("familiar");
    expect(mapFam(0.3)).toBe("stranger");
    expect(mapFam(0.1)).toBe("stranger");
    expect(mapFam(0)).toBe("stranger");
  });

  it("returns correct structure for partner with no emotional state", () => {
    const response = {
      emotion: "neutral",
      pad: { p: 0, a: 0, d: 0 },
      trust: "new",
      familiarity: "stranger",
      interactions: 0,
      personality: "honest, direct, slightly playful",
    };

    expect(response.emotion).toBe("neutral");
    expect(response.pad.p).toBe(0);
    expect(response.pad.a).toBe(0);
    expect(response.pad.d).toBe(0);
    expect(response.trust).toBe("new");
    expect(response.familiarity).toBe("stranger");
    expect(response.interactions).toBe(0);
    expect(response.personality).toContain("honest");
  });

  it("returns correct structure for partner with active emotional state", () => {
    // Simulate decayed state
    const decayed = { pleasure: 0.4, arousal: 0.3, dominance: 0.5 };
    const emotion = padToEmotionLabel(decayed.pleasure, decayed.arousal, decayed.dominance);

    const response = {
      emotion,
      pad: { p: decayed.pleasure, a: decayed.arousal, d: decayed.dominance },
      trust: "moderate",
      familiarity: "familiar",
      interactions: 42,
      personality: "honest, direct, slightly playful",
    };

    expect(response.emotion).toBe("exuberant");
    expect(response.pad.p).toBe(0.4);
    expect(response.interactions).toBe(42);
  });

  it("handles agent with no agents gracefully", () => {
    // When no agents exist, should return neutral defaults
    const noAgentResponse = {
      emotion: "neutral",
      pad: { p: 0, a: 0, d: 0 },
      trust: "new",
      familiarity: "stranger",
      interactions: 0,
      personality: "honest, direct, slightly playful",
    };

    expect(noAgentResponse.emotion).toBe("neutral");
    expect(noAgentResponse.trust).toBe("new");
  });
});

// ── Emotion glow color mapping ──────────────────────────────────

describe("emotion to glow color mapping", () => {
  const EMOTION_GLOW: Record<string, string> = {
    relaxed: "#60A5FA",
    neutral: "#60A5FA",
    docile: "#60A5FA",
    exuberant: "#C9A340",
    dependent: "#C9A340",
    anxious: "#A855F7",
    hostile: "#EF4444",
    disdainful: "#EF4444",
    sad: "#6B7280",
  };

  it("maps relaxed to soft blue", () => {
    expect(EMOTION_GLOW["relaxed"]).toBe("#60A5FA");
  });

  it("maps exuberant to warm gold", () => {
    expect(EMOTION_GLOW["exuberant"]).toBe("#C9A340");
  });

  it("maps anxious to cool purple", () => {
    expect(EMOTION_GLOW["anxious"]).toBe("#A855F7");
  });

  it("maps hostile to soft red", () => {
    expect(EMOTION_GLOW["hostile"]).toBe("#EF4444");
  });

  it("maps sad to desaturated blue", () => {
    expect(EMOTION_GLOW["sad"]).toBe("#6B7280");
  });

  it("maps neutral to soft blue", () => {
    expect(EMOTION_GLOW["neutral"]).toBe("#60A5FA");
  });

  it("all 8 PAD octant emotions have a color", () => {
    const labels = ["exuberant", "dependent", "relaxed", "docile", "hostile", "anxious", "disdainful", "sad"];
    labels.forEach((label) => {
      expect(EMOTION_GLOW[label]).toBeDefined();
      expect(EMOTION_GLOW[label]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });
});

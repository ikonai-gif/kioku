/**
 * KIOKU™ Emotional State Engine — Unit Tests
 *
 * Tests PAD vector decay, emotion label mapping,
 * PAD clamping/deltas, and decayed emotional state computation.
 */

import { describe, it, expect } from "vitest";
import {
  decayPAD,
  decayPADVector,
  padToEmotionLabel,
  clampPAD,
  applyPADDeltas,
  getDecayedEmotionalState,
  defaultEmotionalState,
  type PADVector,
  type EmotionalState,
} from "../../server/emotional-state";
import { MINUTE_MS, createMockEmotionalState } from "../helpers/setup";

// ── PAD Decay ───────────────────────────────────────────────────────

describe("decayPAD", () => {
  it("returns current value when no time has passed", () => {
    expect(decayPAD(0.8, 0.1, 120, 0)).toBe(0.8);
  });

  it("returns baseline when halfLife is 0", () => {
    expect(decayPAD(0.8, 0.1, 0, 60)).toBe(0.1);
  });

  it("halves distance to baseline after one half-life", () => {
    // current=0.8, baseline=0.0, halfLife=120min, delta=120min
    // result = 0.0 + (0.8 - 0.0) * 0.5 = 0.4
    const result = decayPAD(0.8, 0.0, 120, 120);
    expect(result).toBeCloseTo(0.4, 5);
  });

  it("approaches baseline after many half-lives", () => {
    const result = decayPAD(1.0, 0.1, 120, 1200); // 10 half-lives
    expect(result).toBeCloseTo(0.1, 1);
  });

  it("works with negative values", () => {
    // current=-0.8, baseline=0.0, halfLife=120min, delta=120min
    const result = decayPAD(-0.8, 0.0, 120, 120);
    expect(result).toBeCloseTo(-0.4, 5);
  });

  it("works when current equals baseline", () => {
    expect(decayPAD(0.5, 0.5, 120, 60)).toBeCloseTo(0.5, 5);
  });

  it("returns current value when deltaMinutes is negative", () => {
    expect(decayPAD(0.8, 0.1, 120, -10)).toBe(0.8);
  });
});

describe("decayPADVector", () => {
  it("decays all three dimensions independently", () => {
    const current: PADVector = { pleasure: 0.8, arousal: -0.6, dominance: 0.4 };
    const baseline: PADVector = { pleasure: 0.1, arousal: 0.0, dominance: 0.2 };
    const result = decayPADVector(current, baseline, 120, 120);

    // After one half-life, each dimension should be halfway to baseline
    expect(result.pleasure).toBeCloseTo(0.1 + (0.8 - 0.1) * 0.5, 4);
    expect(result.arousal).toBeCloseTo(0.0 + (-0.6 - 0.0) * 0.5, 4);
    expect(result.dominance).toBeCloseTo(0.2 + (0.4 - 0.2) * 0.5, 4);
  });

  it("returns current when no time has passed", () => {
    const current: PADVector = { pleasure: 0.5, arousal: 0.3, dominance: -0.2 };
    const baseline: PADVector = { pleasure: 0.0, arousal: 0.0, dominance: 0.0 };
    const result = decayPADVector(current, baseline, 120, 0);

    expect(result.pleasure).toBe(0.5);
    expect(result.arousal).toBe(0.3);
    expect(result.dominance).toBe(-0.2);
  });
});

// ── PAD Clamping ────────────────────────────────────────────────────

describe("clampPAD", () => {
  it("clamps values above 1.0", () => {
    expect(clampPAD(1.5)).toBe(1.0);
  });

  it("clamps values below -1.0", () => {
    expect(clampPAD(-1.5)).toBe(-1.0);
  });

  it("passes through values in range", () => {
    expect(clampPAD(0.5)).toBe(0.5);
    expect(clampPAD(-0.5)).toBe(-0.5);
    expect(clampPAD(0)).toBe(0);
  });

  it("handles boundary values", () => {
    expect(clampPAD(1.0)).toBe(1.0);
    expect(clampPAD(-1.0)).toBe(-1.0);
  });
});

// ── PAD Deltas ──────────────────────────────────────────────────────

describe("applyPADDeltas", () => {
  it("applies positive deltas", () => {
    const current: PADVector = { pleasure: 0.0, arousal: 0.0, dominance: 0.0 };
    const result = applyPADDeltas(current, 0.3, 0.2, 0.1);
    expect(result.pleasure).toBeCloseTo(0.3, 5);
    expect(result.arousal).toBeCloseTo(0.2, 5);
    expect(result.dominance).toBeCloseTo(0.1, 5);
  });

  it("applies negative deltas", () => {
    const current: PADVector = { pleasure: 0.5, arousal: 0.5, dominance: 0.5 };
    const result = applyPADDeltas(current, -0.3, -0.2, -0.1);
    expect(result.pleasure).toBeCloseTo(0.2, 5);
    expect(result.arousal).toBeCloseTo(0.3, 5);
    expect(result.dominance).toBeCloseTo(0.4, 5);
  });

  it("clamps results to [-1.0, 1.0]", () => {
    const current: PADVector = { pleasure: 0.9, arousal: -0.9, dominance: 0.0 };
    const result = applyPADDeltas(current, 0.3, -0.3, 0.0);
    expect(result.pleasure).toBe(1.0); // clamped
    expect(result.arousal).toBe(-1.0); // clamped
    expect(result.dominance).toBe(0.0);
  });
});

// ── Emotion Label Mapping ───────────────────────────────────────────

describe("padToEmotionLabel", () => {
  describe("8 octants", () => {
    it("+P +A +D = exuberant", () => {
      expect(padToEmotionLabel(0.5, 0.5, 0.5)).toBe("exuberant");
    });

    it("+P +A -D = dependent", () => {
      expect(padToEmotionLabel(0.5, 0.5, -0.5)).toBe("dependent");
    });

    it("+P -A +D = relaxed", () => {
      expect(padToEmotionLabel(0.5, -0.5, 0.5)).toBe("relaxed");
    });

    it("+P -A -D = docile", () => {
      expect(padToEmotionLabel(0.5, -0.5, -0.5)).toBe("docile");
    });

    it("-P +A +D = hostile", () => {
      expect(padToEmotionLabel(-0.5, 0.5, 0.5)).toBe("hostile");
    });

    it("-P +A -D = anxious", () => {
      expect(padToEmotionLabel(-0.5, 0.5, -0.5)).toBe("anxious");
    });

    it("-P -A +D = disdainful", () => {
      expect(padToEmotionLabel(-0.5, -0.5, 0.5)).toBe("disdainful");
    });

    it("-P -A -D = sad", () => {
      expect(padToEmotionLabel(-0.5, -0.5, -0.5)).toBe("sad");
    });
  });

  describe("neutral zone", () => {
    it("all values within +-0.15 → neutral", () => {
      expect(padToEmotionLabel(0.0, 0.0, 0.0)).toBe("neutral");
      expect(padToEmotionLabel(0.1, -0.1, 0.05)).toBe("neutral");
      expect(padToEmotionLabel(0.14, 0.14, 0.14)).toBe("neutral");
    });

    it("values at threshold boundary (0.15) are NOT neutral", () => {
      // At exactly 0.15, >= 0 is true, so it goes to an octant
      expect(padToEmotionLabel(0.15, 0.15, 0.15)).toBe("exuberant");
    });
  });

  describe("boundary conditions", () => {
    it("handles extreme values", () => {
      expect(padToEmotionLabel(1.0, 1.0, 1.0)).toBe("exuberant");
      expect(padToEmotionLabel(-1.0, -1.0, -1.0)).toBe("sad");
    });

    it("zero on boundary defaults to positive side", () => {
      // P=0, A=0, D=0.5 → P>=0 (true), A>=0 (true), D>=0 (true) but within neutral threshold for P,A
      // Actually, 0 is within threshold, but D=0.5 is not
      // P=0 < 0.15 abs, A=0 < 0.15 abs, D=0.5 > 0.15 abs
      // NOT all within threshold, so goes to octant: P>=0, A>=0, D>=0 → exuberant
      expect(padToEmotionLabel(0, 0, 0.5)).toBe("exuberant");
    });
  });
});

// ── Decayed Emotional State ─────────────────────────────────────────

describe("getDecayedEmotionalState", () => {
  it("returns current state when no time has passed", () => {
    const now = Date.now();
    const state = createMockEmotionalState({
      pleasure: 0.8,
      arousal: 0.5,
      dominance: 0.3,
      lastUpdatedAt: now,
    }) as EmotionalState;

    const result = getDecayedEmotionalState(state, now);
    expect(result.pleasure).toBeCloseTo(0.8, 4);
    expect(result.arousal).toBeCloseTo(0.5, 4);
    expect(result.dominance).toBeCloseTo(0.3, 4);
  });

  it("decays toward baseline over time", () => {
    const now = Date.now();
    const state = createMockEmotionalState({
      pleasure: 0.8,
      arousal: 0.6,
      dominance: -0.4,
      baselinePleasure: 0.1,
      baselineArousal: 0.0,
      baselineDominance: 0.2,
      halfLifeMinutes: 120,
      lastUpdatedAt: now - 120 * MINUTE_MS, // 120 min ago = 1 half-life
    }) as EmotionalState;

    const result = getDecayedEmotionalState(state, now);
    // After 1 half-life, distance to baseline halves
    expect(result.pleasure).toBeCloseTo(0.1 + (0.8 - 0.1) * 0.5, 3);
    expect(result.arousal).toBeCloseTo(0.0 + (0.6 - 0.0) * 0.5, 3);
    expect(result.dominance).toBeCloseTo(0.2 + (-0.4 - 0.2) * 0.5, 3);
  });

  it("updates emotion label after decay", () => {
    const now = Date.now();
    // Start with exuberant (high P, A, D) but baseline is neutral-ish
    const state = createMockEmotionalState({
      pleasure: 0.8,
      arousal: 0.8,
      dominance: 0.8,
      baselinePleasure: 0.0,
      baselineArousal: 0.0,
      baselineDominance: 0.0,
      halfLifeMinutes: 60,
      lastUpdatedAt: now - 600 * MINUTE_MS, // 10 half-lives ago
    }) as EmotionalState;

    const result = getDecayedEmotionalState(state, now);
    // After 10 half-lives, values should be very close to baseline (0, 0, 0)
    expect(result.emotionLabel).toBe("neutral");
  });

  it("remains stable at baseline", () => {
    const now = Date.now();
    const state = createMockEmotionalState({
      pleasure: 0.1,
      arousal: 0.0,
      dominance: 0.2,
      baselinePleasure: 0.1,
      baselineArousal: 0.0,
      baselineDominance: 0.2,
      halfLifeMinutes: 120,
      lastUpdatedAt: now - 1000 * MINUTE_MS,
    }) as EmotionalState;

    const result = getDecayedEmotionalState(state, now);
    expect(result.pleasure).toBeCloseTo(0.1, 3);
    expect(result.arousal).toBeCloseTo(0.0, 3);
    expect(result.dominance).toBeCloseTo(0.2, 3);
  });
});

// ── Default Emotional State ─────────────────────────────────────────

describe("defaultEmotionalState", () => {
  it("returns neutral starting state", () => {
    const def = defaultEmotionalState();
    expect(def.pleasure).toBe(0.0);
    expect(def.arousal).toBe(0.0);
    expect(def.dominance).toBe(0.0);
    expect(def.emotionLabel).toBe("neutral");
    expect(def.poignancySum).toBe(0.0);
  });

  it("has slightly positive baseline (optimistic default)", () => {
    const def = defaultEmotionalState();
    expect(def.baselinePleasure).toBe(0.1);
    expect(def.baselineArousal).toBe(0.0);
    expect(def.baselineDominance).toBe(0.2);
  });

  it("has 120-minute half-life", () => {
    const def = defaultEmotionalState();
    expect(def.halfLifeMinutes).toBe(120);
  });
});

// ── Emotional State Lifecycle ───────────────────────────────────────

describe("Emotional State Lifecycle", () => {
  it("agent starts neutral → event triggers emotion → decays back to baseline", () => {
    const now = Date.now();

    // 1. Start neutral
    const initial = createMockEmotionalState({
      pleasure: 0.0,
      arousal: 0.0,
      dominance: 0.0,
      baselinePleasure: 0.1,
      baselineArousal: 0.0,
      baselineDominance: 0.2,
      halfLifeMinutes: 120,
      lastUpdatedAt: now,
    }) as EmotionalState;

    const r1 = getDecayedEmotionalState(initial, now);
    expect(r1.emotionLabel).toBe("neutral");

    // 2. After emotional event: pleasure=0.8, arousal=0.7, dominance=0.6
    const afterEvent = createMockEmotionalState({
      ...initial,
      pleasure: 0.8,
      arousal: 0.7,
      dominance: 0.6,
      lastUpdatedAt: now,
    }) as EmotionalState;

    const r2 = getDecayedEmotionalState(afterEvent, now);
    expect(r2.emotionLabel).toBe("exuberant");

    // 3. After 2 hours (1 half-life): decayed toward baseline
    const r3 = getDecayedEmotionalState(afterEvent, now + 120 * MINUTE_MS);
    expect(r3.pleasure).toBeLessThan(0.8);
    expect(r3.pleasure).toBeGreaterThan(0.1);

    // 4. After 100 hours (~50 half-lives): essentially at baseline
    const r4 = getDecayedEmotionalState(afterEvent, now + 6000 * MINUTE_MS);
    expect(r4.pleasure).toBeCloseTo(0.1, 2);
    expect(r4.arousal).toBeCloseTo(0.0, 2);
    expect(r4.dominance).toBeCloseTo(0.2, 2);
    // Baseline is P=0.1, A=0.0, D=0.2 — all within neutral threshold (0.15)
    // except D=0.2 > 0.15, so label depends on octant mapping
    const label = r4.emotionLabel;
    // At baseline, P=0.1 < 0.15, A=0.0 < 0.15, D=0.2 > 0.15
    // Not all within threshold → goes to octant: P>=0, A>=0, D>0 → exuberant
    // This is expected: the baseline personality is slightly dominant/positive
    expect(["neutral", "exuberant", "relaxed"]).toContain(label);
  });
});

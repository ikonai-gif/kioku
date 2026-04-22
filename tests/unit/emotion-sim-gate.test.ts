/**
 * W8 Voice-PR step E (Luca's N12) — tests for applyEmotionSimGate.
 *
 * Semantics: below threshold → neutral 1.0 (no boost, no penalty).
 *            at/above threshold → (1 + emotionSim * coeff).
 * Non-finite input → neutral 1.0 (defensive).
 */

import { describe, it, expect } from "vitest";
import {
  applyEmotionSimGate,
  EMOTION_SIM_GATE_THRESHOLD,
  EMOTION_SIM_BOOST_COEFF,
} from "../../server/memory-injection";

describe("applyEmotionSimGate — constants sanity", () => {
  it("threshold is 0.30", () => {
    expect(EMOTION_SIM_GATE_THRESHOLD).toBe(0.30);
  });
  it("boost coefficient is 0.20", () => {
    expect(EMOTION_SIM_BOOST_COEFF).toBe(0.20);
  });
});

describe("applyEmotionSimGate — below threshold", () => {
  it("returns 1.0 for sim=0", () => {
    expect(applyEmotionSimGate(0)).toBe(1.0);
  });
  it("returns 1.0 for sim just below threshold (0.29)", () => {
    expect(applyEmotionSimGate(0.29)).toBe(1.0);
  });
  it("returns 1.0 for negative similarity", () => {
    expect(applyEmotionSimGate(-0.5)).toBe(1.0);
    expect(applyEmotionSimGate(-1.0)).toBe(1.0);
  });
  it("no penalty below threshold (unlike naive clamp at -0.2)", () => {
    // Crucial distinction from pre-fix behavior: pre-fix, sim=-1 gave
    // 1 + (-1)*0.2 = 0.8 → 20% penalty. Post-fix, sim=-1 → 1.0 neutral.
    const pre = 1 + -1.0 * 0.2;
    const post = applyEmotionSimGate(-1.0);
    expect(pre).toBe(0.8);
    expect(post).toBe(1.0);
  });
});

describe("applyEmotionSimGate — at and above threshold", () => {
  it("applies boost at exactly threshold (0.3)", () => {
    // 1 + 0.3 * 0.2 = 1.06
    expect(applyEmotionSimGate(0.30)).toBeCloseTo(1.06, 5);
  });
  it("applies full boost at sim=1.0", () => {
    // 1 + 1.0 * 0.2 = 1.20
    expect(applyEmotionSimGate(1.0)).toBeCloseTo(1.20, 5);
  });
  it("applies proportional boost for mid-range sim=0.5", () => {
    // 1 + 0.5 * 0.2 = 1.10
    expect(applyEmotionSimGate(0.50)).toBeCloseTo(1.10, 5);
  });
  it("applies proportional boost for sim=0.8", () => {
    // 1 + 0.8 * 0.2 = 1.16
    expect(applyEmotionSimGate(0.80)).toBeCloseTo(1.16, 5);
  });
});

describe("applyEmotionSimGate — defensive", () => {
  it("returns 1.0 for NaN input", () => {
    expect(applyEmotionSimGate(NaN)).toBe(1.0);
  });
  it("returns 1.0 for Infinity input", () => {
    expect(applyEmotionSimGate(Infinity)).toBe(1.0);
    expect(applyEmotionSimGate(-Infinity)).toBe(1.0);
  });
});

describe("applyEmotionSimGate — custom threshold / coeff", () => {
  it("honors custom threshold", () => {
    // With a threshold of 0.5, sim=0.4 should be gated out.
    expect(applyEmotionSimGate(0.40, 0.5)).toBe(1.0);
    // And sim=0.6 should pass: 1 + 0.6 * 0.2 = 1.12
    expect(applyEmotionSimGate(0.60, 0.5)).toBeCloseTo(1.12, 5);
  });
  it("honors custom coefficient", () => {
    // coeff=0.5 at sim=0.8 → 1 + 0.8*0.5 = 1.4
    expect(applyEmotionSimGate(0.80, 0.30, 0.5)).toBeCloseTo(1.4, 5);
  });
});

describe("applyEmotionSimGate — realistic N12 drift scenario", () => {
  it("gates out faint affective resonance that previously drove drift", () => {
    // Scenario: current state is low-arousal reflective (like after Kote's
    // 'вы так и будете переписываться'). An old _conversation_insights
    // note from an unrelated session also happens to be low-arousal
    // reflective, yielding cosine sim ~0.25. Pre-fix this triggered
    // score *= 1.05 and helped pull the note into top-K. Post-fix that
    // multiplier is 1.0 and the note is judged on its own merit only.
    expect(applyEmotionSimGate(0.25)).toBe(1.0);
  });
  it("preserves boost for genuine emotional match", () => {
    // Strong match (sim=0.9) — same emotional arc, very likely relevant.
    // Still gets boosted so EmotionalRAG stays useful for its intended case.
    expect(applyEmotionSimGate(0.90)).toBeCloseTo(1.18, 5);
  });
});

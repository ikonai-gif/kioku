/**
 * KIOKU™ Confidence Decay — Detailed 7-Type Tests
 *
 * Tests the confidence decay system across all 7 memory types,
 * simulating real-world decay patterns over various time windows.
 * Also tests boundary conditions and interactions with memory injection threshold.
 */

import { describe, it, expect } from "vitest";
import { computeDecayedStrength, computeDecayedConfidence } from "../../server/memory-decay";
import { DAY_MS } from "../helpers/setup";

const baseTime = 1700000000000;

// ── Comparative Decay Rates Across 7 Types ──────────────────────────

describe("7-Type Confidence Decay Comparison", () => {
  // Simulated realistic decay rates by type (as would be set by the system)
  const typeProfiles = {
    semantic: { decayRate: 0.01, strengthHalfLife: 14 },
    episodic: { decayRate: 0.03, strengthHalfLife: 7 },
    procedural: { decayRate: 0.001, strengthHalfLife: Infinity },
    temporal: { decayRate: 0.05, strengthHalfLife: 14 },
    causal: { decayRate: 0.02, strengthHalfLife: 14 },
    contextual: { decayRate: 0.04, strengthHalfLife: 14 },
    emotional: { decayRate: 0.005, strengthHalfLife: 30 },
  };

  describe("ordering: emotional decays slowest, temporal decays fastest", () => {
    it("after 30 days, emotional confidence > semantic > causal > episodic > contextual > temporal", () => {
      const results: Record<string, number> = {};
      for (const [type, { decayRate }] of Object.entries(typeProfiles)) {
        if (type === "procedural") continue; // near-zero decay, always highest
        results[type] = computeDecayedConfidence(1.0, decayRate, null, baseTime, baseTime + 30 * DAY_MS);
      }

      expect(results.emotional).toBeGreaterThan(results.semantic);
      expect(results.semantic).toBeGreaterThan(results.causal);
      expect(results.causal).toBeGreaterThan(results.episodic);
      expect(results.episodic).toBeGreaterThan(results.contextual);
      expect(results.contextual).toBeGreaterThan(results.temporal);
    });

    it("procedural memory confidence barely changes over 365 days", () => {
      const c = computeDecayedConfidence(1.0, typeProfiles.procedural.decayRate, null, baseTime, baseTime + 365 * DAY_MS);
      expect(c).toBeGreaterThan(0.68); // e^(-0.001 * 365) ≈ 0.694
    });
  });

  describe("strength vs confidence dual decay", () => {
    it("both strength and confidence decay independently", () => {
      // Semantic memory: strength half-life 14 days, confidence decayRate 0.01
      const strength = computeDecayedStrength(1.0, "semantic", baseTime, null, 0, baseTime + 14 * DAY_MS);
      const confidence = computeDecayedConfidence(1.0, 0.01, null, baseTime, baseTime + 14 * DAY_MS);

      // Strength uses half-life model
      expect(strength).toBeCloseTo(0.5, 1);
      // Confidence uses exponential decay
      expect(confidence).toBeCloseTo(Math.exp(-0.01 * 14), 3);
      // They use different models, so values differ
      expect(strength).not.toBeCloseTo(confidence, 1);
    });

    it("episodic memories decay faster in strength than confidence", () => {
      const strength = computeDecayedStrength(1.0, "episodic", baseTime, null, 0, baseTime + 7 * DAY_MS);
      const confidence = computeDecayedConfidence(1.0, 0.03, null, baseTime, baseTime + 7 * DAY_MS);

      expect(strength).toBeCloseTo(0.5, 1);     // half-life = 7 days
      expect(confidence).toBeCloseTo(0.81, 1);   // e^(-0.03 * 7) ≈ 0.811
      expect(confidence).toBeGreaterThan(strength);
    });
  });
});

// ── Injection Threshold Boundary ────────────────────────────────────

describe("Confidence Injection Threshold (0.3)", () => {
  it("semantic memory (0.01 decay) stays injectable ~110 days", () => {
    // Find approximate day when confidence crosses 0.3
    // 0.9 * e^(-0.01 * d) = 0.3 → d = -ln(0.3/0.9) / 0.01 ≈ 109.86
    const above = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 109 * DAY_MS);
    const below = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 111 * DAY_MS);
    expect(above).toBeGreaterThan(0.3);
    expect(below).toBeLessThan(0.3);
  });

  it("temporal memory (0.05 decay) drops below threshold in ~22 days", () => {
    // 0.9 * e^(-0.05 * d) = 0.3 → d ≈ 21.97
    const above = computeDecayedConfidence(0.9, 0.05, null, baseTime, baseTime + 21 * DAY_MS);
    const below = computeDecayedConfidence(0.9, 0.05, null, baseTime, baseTime + 23 * DAY_MS);
    expect(above).toBeGreaterThan(0.3);
    expect(below).toBeLessThan(0.3);
  });

  it("emotional memory (0.005 decay) stays above threshold ~220 days", () => {
    // 0.9 * e^(-0.005 * d) = 0.3 → d ≈ 219.7
    const above = computeDecayedConfidence(0.9, 0.005, null, baseTime, baseTime + 219 * DAY_MS);
    const below = computeDecayedConfidence(0.9, 0.005, null, baseTime, baseTime + 221 * DAY_MS);
    expect(above).toBeGreaterThan(0.3);
    expect(below).toBeLessThan(0.3);
  });

  it("low initial confidence (0.4) drops below threshold quickly", () => {
    // 0.4 * e^(-0.01 * d) = 0.3 → d = -ln(0.75) / 0.01 ≈ 28.77
    const above = computeDecayedConfidence(0.4, 0.01, null, baseTime, baseTime + 28 * DAY_MS);
    const below = computeDecayedConfidence(0.4, 0.01, null, baseTime, baseTime + 30 * DAY_MS);
    expect(above).toBeGreaterThan(0.3);
    expect(below).toBeLessThan(0.3);
  });
});

// ── Reinforcement Impact ────────────────────────────────────────────

describe("Reinforcement Impact on Confidence", () => {
  it("reinforcement resets the decay clock", () => {
    // Without reinforcement: 60 days from creation
    const noReinforce = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 60 * DAY_MS);

    // With reinforcement at day 50: only 10 days since reinforcement
    const withReinforce = computeDecayedConfidence(0.9, 0.01, baseTime + 50 * DAY_MS, baseTime, baseTime + 60 * DAY_MS);

    expect(withReinforce).toBeGreaterThan(noReinforce);
    expect(withReinforce).toBeCloseTo(0.9 * Math.exp(-0.01 * 10), 3);
  });

  it("multiple reinforcements extend memory lifetime", () => {
    // Simulate checking at day 30 with reinforcement at day 25
    const c1 = computeDecayedConfidence(0.9, 0.01, baseTime + 25 * DAY_MS, baseTime, baseTime + 30 * DAY_MS);
    // Only 5 days since reinforcement
    expect(c1).toBeCloseTo(0.9 * Math.exp(-0.01 * 5), 3);
    expect(c1).toBeGreaterThan(0.85);
  });
});

// ── Mathematical Properties ─────────────────────────────────────────

describe("Mathematical Properties", () => {
  it("confidence is monotonically decreasing with time", () => {
    let prev = 1.0;
    for (let d = 0; d <= 100; d += 10) {
      const c = computeDecayedConfidence(1.0, 0.01, null, baseTime, baseTime + d * DAY_MS);
      expect(c).toBeLessThanOrEqual(prev + 0.0001); // small epsilon for float precision
      prev = c;
    }
  });

  it("confidence is monotonically decreasing with higher decay rate", () => {
    let prev = 1.0;
    for (const rate of [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5, 1.0]) {
      const c = computeDecayedConfidence(1.0, rate, null, baseTime, baseTime + 30 * DAY_MS);
      expect(c).toBeLessThanOrEqual(prev + 0.0001);
      prev = c;
    }
  });

  it("confidence is proportional to initial confidence", () => {
    const c1 = computeDecayedConfidence(0.5, 0.01, null, baseTime, baseTime + 30 * DAY_MS);
    const c2 = computeDecayedConfidence(1.0, 0.01, null, baseTime, baseTime + 30 * DAY_MS);
    expect(c2 / c1).toBeCloseTo(2.0, 2);
  });
});

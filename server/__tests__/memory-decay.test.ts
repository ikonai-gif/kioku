import { describe, it, expect } from "vitest";
import { computeDecayedStrength, computeDecayedConfidence } from "../memory-decay";

const DAY_MS = 1000 * 60 * 60 * 24;

describe("computeDecayedStrength", () => {
  const baseTime = Date.now();

  describe("half-life by memory type", () => {
    it("emotional memories decay slowest (half-life 30 days)", () => {
      const strength = computeDecayedStrength(1.0, "emotional", baseTime, null, 0, baseTime + 30 * DAY_MS);
      // After 30 days at half-life, strength ≈ 0.5
      expect(strength).toBeCloseTo(0.5, 1);
    });

    it("semantic memories have 14-day half-life", () => {
      const strength = computeDecayedStrength(1.0, "semantic", baseTime, null, 0, baseTime + 14 * DAY_MS);
      expect(strength).toBeCloseTo(0.5, 1);
    });

    it("episodic memories decay fastest (7-day half-life)", () => {
      const strength = computeDecayedStrength(1.0, "episodic", baseTime, null, 0, baseTime + 7 * DAY_MS);
      expect(strength).toBeCloseTo(0.5, 1);
    });

    it("procedural memories never decay", () => {
      const strength = computeDecayedStrength(0.8, "procedural", baseTime, null, 0, baseTime + 365 * DAY_MS);
      expect(strength).toBe(0.8);
    });

    it("temporal memories have 14-day half-life", () => {
      const strength = computeDecayedStrength(1.0, "temporal", baseTime, null, 0, baseTime + 14 * DAY_MS);
      expect(strength).toBeCloseTo(0.5, 1);
    });

    it("causal memories have 14-day half-life", () => {
      const strength = computeDecayedStrength(1.0, "causal", baseTime, null, 0, baseTime + 14 * DAY_MS);
      expect(strength).toBeCloseTo(0.5, 1);
    });

    it("contextual memories have 14-day half-life", () => {
      const strength = computeDecayedStrength(1.0, "contextual", baseTime, null, 0, baseTime + 14 * DAY_MS);
      expect(strength).toBeCloseTo(0.5, 1);
    });
  });

  describe("decay formula", () => {
    it("returns baseStrength when no time has passed", () => {
      const strength = computeDecayedStrength(0.9, "semantic", baseTime, null, 0, baseTime);
      expect(strength).toBeCloseTo(0.9, 5);
    });

    it("returns near zero after many half-lives", () => {
      // 10 half-lives = 140 days for semantic → 0.9 * 0.5^10 ≈ 0.00088
      const strength = computeDecayedStrength(0.9, "semantic", baseTime, null, 0, baseTime + 140 * DAY_MS);
      expect(strength).toBeLessThan(0.01);
    });

    it("uses lastAccessedAt as reference when available", () => {
      const accessedAt = baseTime + 10 * DAY_MS;
      const now = accessedAt + 14 * DAY_MS; // 14 days from last access
      const strength = computeDecayedStrength(1.0, "semantic", baseTime, accessedAt, 0, now);
      // Should be ~0.5 based on access time, not creation time
      expect(strength).toBeCloseTo(0.5, 1);
    });

    it("clamps output to [0, 1]", () => {
      // High reinforcement could push above 1 — should be clamped
      const strength = computeDecayedStrength(1.0, "semantic", baseTime, null, 20, baseTime);
      expect(strength).toBeLessThanOrEqual(1.0);
      expect(strength).toBeGreaterThanOrEqual(0);
    });
  });

  describe("access reinforcement", () => {
    it("each access adds 10% to effective strength", () => {
      const noAccess = computeDecayedStrength(0.5, "semantic", baseTime, null, 0, baseTime);
      const oneAccess = computeDecayedStrength(0.5, "semantic", baseTime, null, 1, baseTime);
      // 1 access: reinforcement = 1.1, so 0.5 * 1 * 1.1 = 0.55
      expect(oneAccess).toBeCloseTo(noAccess * 1.1, 5);
    });

    it("caps reinforcement at 2x (10 accesses)", () => {
      const tenAccesses = computeDecayedStrength(0.4, "semantic", baseTime, null, 10, baseTime);
      const twentyAccesses = computeDecayedStrength(0.4, "semantic", baseTime, null, 20, baseTime);
      // Both should be capped at 2x: 0.4 * 2 = 0.8
      expect(tenAccesses).toBeCloseTo(0.8, 5);
      expect(twentyAccesses).toBeCloseTo(0.8, 5);
    });

    it("reinforcement and decay combine correctly", () => {
      // After 14 days semantic: decay = 0.5, with 5 accesses reinforcement = 1.5
      // Expected: 1.0 * 0.5 * 1.5 = 0.75
      const strength = computeDecayedStrength(1.0, "semantic", baseTime, null, 5, baseTime + 14 * DAY_MS);
      expect(strength).toBeCloseTo(0.75, 1);
    });
  });

  describe("unknown memory type", () => {
    it("uses default 14-day half-life for unknown types", () => {
      const strength = computeDecayedStrength(1.0, "unknown_type", baseTime, null, 0, baseTime + 14 * DAY_MS);
      expect(strength).toBeCloseTo(0.5, 1);
    });
  });
});

describe("computeDecayedConfidence", () => {
  const baseTime = Date.now();

  it("returns original confidence when decayRate is 0", () => {
    const conf = computeDecayedConfidence(0.9, 0, null, baseTime, baseTime + 100 * DAY_MS);
    expect(conf).toBe(0.9);
  });

  it("returns original confidence when no time has passed", () => {
    const conf = computeDecayedConfidence(0.85, 0.01, null, baseTime, baseTime);
    expect(conf).toBeCloseTo(0.85, 5);
  });

  it("decays exponentially over time", () => {
    // confidence = 0.9 * exp(-0.01 * 30) ≈ 0.9 * 0.7408 ≈ 0.667
    const conf = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 30 * DAY_MS);
    expect(conf).toBeCloseTo(0.9 * Math.exp(-0.01 * 30), 3);
  });

  it("uses lastReinforcedAt as reference when available", () => {
    const reinforcedAt = baseTime + 20 * DAY_MS;
    const now = reinforcedAt + 10 * DAY_MS;
    const conf = computeDecayedConfidence(0.9, 0.01, reinforcedAt, baseTime, now);
    // 10 days since reinforcement
    expect(conf).toBeCloseTo(0.9 * Math.exp(-0.01 * 10), 3);
  });

  it("clamps to [0, 1]", () => {
    const conf = computeDecayedConfidence(1.0, 0.01, null, baseTime, baseTime + 1 * DAY_MS);
    expect(conf).toBeGreaterThanOrEqual(0);
    expect(conf).toBeLessThanOrEqual(1.0);
  });

  it("approaches zero with high decay rate", () => {
    const conf = computeDecayedConfidence(1.0, 1.0, null, baseTime, baseTime + 10 * DAY_MS);
    expect(conf).toBeLessThan(0.001);
  });

  it("handles negative decayRate by returning original", () => {
    const conf = computeDecayedConfidence(0.8, -0.5, null, baseTime, baseTime + 100 * DAY_MS);
    expect(conf).toBe(0.8);
  });

  describe("confidence decay per memory type integration", () => {
    // Validates the confidence decay rate works differently from strength decay
    // The confidence system uses explicit decay rates, not type-based half-lives

    it("default decay rate (0.01/day) keeps memories above 0.3 for ~120 days", () => {
      // 0.9 * exp(-0.01 * 120) ≈ 0.9 * 0.301 ≈ 0.271 — just below 0.3
      const conf120 = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 120 * DAY_MS);
      expect(conf120).toBeLessThan(0.3);

      // 100 days: 0.9 * exp(-0.01 * 100) ≈ 0.9 * 0.368 ≈ 0.331 — above 0.3
      const conf100 = computeDecayedConfidence(0.9, 0.01, null, baseTime, baseTime + 100 * DAY_MS);
      expect(conf100).toBeGreaterThan(0.3);
    });
  });
});

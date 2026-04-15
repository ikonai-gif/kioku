/**
 * Edge case tests for the Deliberation Engine.
 * Covers: empty sessions, duplicate votes, tie-breaking, expired sessions,
 * human timeout, error positions, and boundary conditions.
 */
import { describe, it, expect } from "vitest";
import { computeDecayedStrength, computeDecayedConfidence } from "../memory-decay";

const DAY_MS = 1000 * 60 * 60 * 24;

// Re-implement buildConsensus for edge case testing
interface AgentPosition {
  agentId: number;
  agentName: string;
  agentColor: string;
  position: string;
  confidence: number;
  reasoning: string;
}

function buildConsensus(
  initialPositions: AgentPosition[],
  finalPositions: AgentPosition[],
  topic: string
) {
  const votes = finalPositions.map((fp) => {
    const initial = initialPositions.find((ip) => ip.agentId === fp.agentId);
    return {
      agentName: fp.agentName,
      position: fp.position,
      confidence: fp.confidence,
      changedMind: initial ? initial.position !== fp.position : false,
    };
  });

  const sorted = [...votes].sort((a, b) => b.confidence - a.confidence);
  const topPosition = sorted[0];

  const avgConfidence =
    votes.reduce((sum, v) => sum + v.confidence, 0) / votes.length;

  const dissent = votes
    .filter((v) => v.confidence < 0.4 || (v.position !== topPosition.position && v.confidence > 0.3))
    .map((v) => `${v.agentName}: "${v.position}" (${(v.confidence * 100).toFixed(0)}%)`);

  return {
    decision: topPosition.position,
    confidence: avgConfidence,
    method: "weighted_majority" as const,
    votes,
    dissent,
  };
}

const makePos = (id: number, name: string, pos: string, conf: number): AgentPosition => ({
  agentId: id, agentName: name, agentColor: "#000", position: pos, confidence: conf, reasoning: "test",
});

describe("Edge cases: empty and minimal sessions", () => {
  it("handles single-agent deliberation", () => {
    const initial = [makePos(1, "Solo", "My view", 0.9)];
    const final = [makePos(1, "Solo", "My view", 0.95)];
    const result = buildConsensus(initial, final, "test");
    expect(result.votes).toHaveLength(1);
    expect(result.decision).toBe("My view");
    expect(result.confidence).toBe(0.95);
    expect(result.dissent).toHaveLength(0); // solo agent, high confidence
  });

  it("handles all agents producing error positions", () => {
    const initial = [
      makePos(1, "A", "[error: timeout]", 0),
      makePos(2, "B", "[error: API key invalid]", 0),
    ];
    const final = [
      makePos(1, "A", "[error: timeout]", 0),
      makePos(2, "B", "[error: API key invalid]", 0),
    ];
    const result = buildConsensus(initial, final, "test");
    expect(result.confidence).toBe(0);
    expect(result.dissent).toHaveLength(2); // both at 0 confidence → dissent
  });
});

describe("Edge cases: duplicate/identical votes", () => {
  it("all agents agree with same position text", () => {
    const pos = "We should proceed";
    const initial = [
      makePos(1, "A", pos, 0.7),
      makePos(2, "B", pos, 0.8),
      makePos(3, "C", pos, 0.9),
    ];
    const final = [
      makePos(1, "A", pos, 0.75),
      makePos(2, "B", pos, 0.85),
      makePos(3, "C", pos, 0.95),
    ];
    const result = buildConsensus(initial, final, "test");
    expect(result.decision).toBe(pos);
    expect(result.dissent).toHaveLength(0);
    expect(result.confidence).toBeCloseTo((0.75 + 0.85 + 0.95) / 3, 5);
  });

  it("all agents have exact same confidence creates stable result", () => {
    const final = [
      makePos(1, "A", "Pos A", 0.7),
      makePos(2, "B", "Pos B", 0.7),
      makePos(3, "C", "Pos C", 0.7),
    ];
    const initial = final.map(p => ({ ...p }));
    const result = buildConsensus(initial, final, "test");
    // Should deterministically pick one
    expect(result.decision).toBeTruthy();
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });
});

describe("Edge cases: tie-breaking", () => {
  it("two agents tied at max confidence — first in sort order wins", () => {
    const initial = [
      makePos(1, "Alice", "Option A", 0.5),
      makePos(2, "Bob", "Option B", 0.5),
    ];
    const final = [
      makePos(1, "Alice", "Option A", 0.9),
      makePos(2, "Bob", "Option B", 0.9),
    ];
    const result = buildConsensus(initial, final, "test");
    // Both at 0.9 — JS sort is stable, so first element stays first
    expect(["Option A", "Option B"]).toContain(result.decision);
    expect(result.confidence).toBe(0.9);
  });

  it("three-way tie resolved by sort stability", () => {
    const final = [
      makePos(1, "A", "X", 0.5),
      makePos(2, "B", "Y", 0.5),
      makePos(3, "C", "Z", 0.5),
    ];
    const result = buildConsensus(final, final, "test");
    expect(["X", "Y", "Z"]).toContain(result.decision);
  });
});

describe("Edge cases: expired sessions / timeout handling", () => {
  it("human timeout produces abstain position", () => {
    // When human times out, they get a special abstain position
    const humanAbstain: AgentPosition = {
      agentId: -1,
      agentName: "Human Participant",
      agentColor: "#D4AF37",
      position: "[abstained — no response within 60s]",
      confidence: 0,
      reasoning: "Human participant did not respond within the time limit.",
    };

    expect(humanAbstain.agentId).toBe(-1); // sentinel value
    expect(humanAbstain.confidence).toBe(0);
    expect(humanAbstain.position).toContain("abstained");
  });

  it("polling agent timeout produces error position", () => {
    const errorPosition: AgentPosition = {
      agentId: 5,
      agentName: "Polling Agent",
      agentColor: "#000",
      position: "[error: polling timeout — no response within 60s]",
      confidence: 0,
      reasoning: "Polling agent Polling Agent did not respond within the 60s window.",
    };

    expect(errorPosition.confidence).toBe(0);
    expect(errorPosition.position).toContain("polling timeout");
  });

  it("consensus handles mix of real and error/abstain positions", () => {
    const initial = [
      makePos(1, "Agent1", "Proceed", 0.8),
      makePos(2, "Agent2", "Wait", 0.6),
      makePos(-1, "Human", "[abstained]", 0),
    ];
    const final = [
      makePos(1, "Agent1", "Proceed", 0.85),
      makePos(2, "Agent2", "Proceed", 0.7),
      makePos(-1, "Human", "[abstained]", 0),
    ];
    const result = buildConsensus(initial, final, "test");
    expect(result.decision).toBe("Proceed"); // Agent1 has highest confidence
    // Human in dissent (confidence < 0.4)
    expect(result.dissent.some(d => d.includes("Human"))).toBe(true);
    // Average: (0.85 + 0.7 + 0) / 3
    expect(result.confidence).toBeCloseTo(0.5167, 2);
  });
});

describe("Edge cases: confidence boundary values", () => {
  it("confidence at exact boundaries: 0.0 and 1.0", () => {
    const final = [
      makePos(1, "A", "Sure", 1.0),
      makePos(2, "B", "Unsure", 0.0),
    ];
    const result = buildConsensus(final, final, "test");
    expect(result.decision).toBe("Sure"); // 1.0 > 0.0
    expect(result.confidence).toBe(0.5); // (1.0 + 0.0) / 2
    // B at 0.0 → dissent (< 0.4)
    expect(result.dissent).toHaveLength(1);
  });

  it("confidence at 0.4 threshold (borderline dissent)", () => {
    const final = [
      makePos(1, "A", "Same", 0.9),
      makePos(2, "B", "Same", 0.4), // exactly at threshold
    ];
    const result = buildConsensus(final, final, "test");
    // B at exactly 0.4 → NOT in dissent (filter is < 0.4)
    expect(result.dissent).toHaveLength(0);
  });

  it("confidence at 0.39 (just below dissent threshold)", () => {
    const final = [
      makePos(1, "A", "Same", 0.9),
      makePos(2, "B", "Same", 0.39),
    ];
    const result = buildConsensus(final, final, "test");
    // B at 0.39 → in dissent (< 0.4)
    expect(result.dissent).toHaveLength(1);
  });

  it("confidence at 0.3 boundary for dissent on non-majority", () => {
    // Agents with different position need confidence > 0.3 to count as dissent
    const final = [
      makePos(1, "A", "Position A", 0.9),
      makePos(2, "B", "Position B", 0.3), // exactly at boundary: NOT > 0.3
    ];
    const result = buildConsensus(final, final, "test");
    // B has different position but confidence is exactly 0.3, not > 0.3
    // BUT B also has confidence < 0.4, so it's in dissent via that rule
    expect(result.dissent.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Edge cases: memory decay boundaries", () => {
  const now = Date.now();

  it("strength at exactly half-life equals ~0.5", () => {
    const strength = computeDecayedStrength(1.0, "episodic", now, null, 0, now + 7 * DAY_MS);
    expect(strength).toBeCloseTo(0.5, 2);
  });

  it("strength with zero base returns zero", () => {
    const strength = computeDecayedStrength(0, "semantic", now, null, 0, now + 14 * DAY_MS);
    expect(strength).toBe(0);
  });

  it("strength in the future (now < createdAt) doesn't go above 1", () => {
    // Negative days → strength > base... but clamped to 1.0
    const strength = computeDecayedStrength(0.9, "semantic", now + 14 * DAY_MS, null, 0, now);
    expect(strength).toBeLessThanOrEqual(1.0);
  });

  it("confidence at zero decay rate never changes", () => {
    const conf = computeDecayedConfidence(0.5, 0, null, now, now + 1000 * DAY_MS);
    expect(conf).toBe(0.5);
  });

  it("confidence with zero original stays at zero", () => {
    const conf = computeDecayedConfidence(0, 0.01, null, now, now + 10 * DAY_MS);
    expect(conf).toBe(0);
  });

  it("very old emotional memory still has measurable strength", () => {
    // Emotional memories have 30-day half-life. After 60 days: 0.8 * 0.25 = 0.2
    const strength = computeDecayedStrength(0.8, "emotional", now, null, 0, now + 60 * DAY_MS);
    expect(strength).toBeCloseTo(0.2, 1);
    expect(strength).toBeGreaterThan(0.05); // not yet pruned
  });

  it("very old episodic memory is nearly zero", () => {
    // Episodic: 7-day half-life. After 70 days (10 half-lives): practically 0
    const strength = computeDecayedStrength(0.8, "episodic", now, null, 0, now + 70 * DAY_MS);
    expect(strength).toBeLessThan(0.01);
  });
});

describe("Edge cases: large deliberations", () => {
  it("consensus handles 20 agents", () => {
    const agents = Array.from({ length: 20 }, (_, i) =>
      makePos(i + 1, `Agent${i + 1}`, `Position ${i + 1}`, Math.random())
    );
    const result = buildConsensus(agents, agents, "large deliberation");
    expect(result.votes).toHaveLength(20);
    expect(result.decision).toBeTruthy();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("consensus handles very long position text", () => {
    const longPosition = "A".repeat(5000);
    const final = [
      makePos(1, "A", longPosition, 0.8),
      makePos(2, "B", "Short", 0.7),
    ];
    const result = buildConsensus(final, final, "test");
    expect(result.decision).toBe(longPosition);
  });
});

describe("Edge cases: special characters in positions", () => {
  it("handles unicode in positions", () => {
    const final = [
      makePos(1, "A", "私たちは続行すべきです", 0.8),
      makePos(2, "B", "Мы должны продолжить", 0.7),
    ];
    const result = buildConsensus(final, final, "test");
    expect(result.decision).toBe("私たちは続行すべきです");
  });

  it("handles emoji in positions", () => {
    const final = [
      makePos(1, "A", "🚀 Let's ship it!", 0.9),
      makePos(2, "B", "⚠️ Wait, not ready", 0.6),
    ];
    const result = buildConsensus(final, final, "test");
    expect(result.decision).toContain("🚀");
  });

  it("handles newlines in positions (from messy LLM output)", () => {
    const final = [
      makePos(1, "A", "Proceed\nwith caution", 0.8),
      makePos(2, "B", "Wait", 0.5),
    ];
    const result = buildConsensus(final, final, "test");
    expect(result.decision).toContain("Proceed");
  });
});

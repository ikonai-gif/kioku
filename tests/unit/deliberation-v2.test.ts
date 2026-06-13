/**
 * [LUCA-096] Deliberation v2 unit tests:
 * - buildCommunicationGraph: ring, random_sparse, full
 * - checkStabilityStop: edge cases
 * - filterByTopology: correct filtering
 */
import { describe, it, expect } from "vitest";

// Inline the pure functions so we can test without full deliberation imports
function buildCommunicationGraph(
  agents: { id: number }[],
  type: "full" | "ring" | "random_sparse"
): Map<number, number[]> {
  const n = agents.length;
  const graph = new Map<number, number[]>();
  if (type === "full" || n <= 2) {
    for (const a of agents) graph.set(a.id, agents.filter(b => b.id !== a.id).map(b => b.id));
    return graph;
  }
  if (type === "ring") {
    for (let i = 0; i < n; i++) {
      const prev = agents[(i - 1 + n) % n].id;
      const next = agents[(i + 1) % n].id;
      graph.set(agents[i].id, [prev, next]);
    }
    return graph;
  }
  const k = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const others = agents.filter((_, j) => j !== i);
    const shuffled = others.sort(() => Math.random() - 0.5).slice(0, k);
    graph.set(agents[i].id, shuffled.map(b => b.id));
  }
  return graph;
}

function checkStabilityStop(positionHistory: string[][], windowSize = 2): boolean {
  if (positionHistory.length < windowSize + 1) return false;
  const last = positionHistory.slice(-windowSize - 1);
  const agentCount = last[0].length;
  if (agentCount === 0) return false;
  let stableCount = 0;
  for (let i = 0; i < agentCount; i++) {
    const firstPos = last[0][i];
    if (last.every(round => round[i] === firstPos)) stableCount++;
  }
  return stableCount / agentCount >= 0.8;
}

function filterByTopology(
  agentId: number,
  priorPositions: { agentId: number; position: string }[],
  graph: Map<number, number[]> | null
): { agentId: number; position: string }[] {
  if (!graph) return priorPositions;
  const visible = graph.get(agentId);
  if (!visible) return priorPositions;
  return priorPositions.filter(p => visible.includes(p.agentId));
}

const agents3 = [{ id: 1 }, { id: 2 }, { id: 3 }];
const agents4 = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

describe("buildCommunicationGraph", () => {
  it("ring: each agent sees exactly 2 neighbours", () => {
    const g = buildCommunicationGraph(agents4, "ring");
    for (const [, peers] of g) expect(peers).toHaveLength(2);
  });

  it("ring: no self-reference", () => {
    const g = buildCommunicationGraph(agents4, "ring");
    for (const [id, peers] of g) expect(peers).not.toContain(id);
  });

  it("full: every agent sees all others", () => {
    const g = buildCommunicationGraph(agents3, "full");
    for (const [id, peers] of g) {
      expect(peers).toHaveLength(2);
      expect(peers).not.toContain(id);
    }
  });

  it("random_sparse: k = ceil(sqrt(n)) peers", () => {
    const g = buildCommunicationGraph(agents4, "random_sparse");
    const k = Math.ceil(Math.sqrt(4));
    for (const [, peers] of g) expect(peers).toHaveLength(k);
  });

  it("n<=2 treated as full regardless of type", () => {
    const g = buildCommunicationGraph([{ id: 1 }, { id: 2 }], "ring");
    expect(g.get(1)).toEqual([2]);
  });
});

describe("checkStabilityStop", () => {
  it("returns false when history too short", () => {
    expect(checkStabilityStop([["a", "b"]], 2)).toBe(false);
  });

  it("returns true when 100% stable across 3 rounds", () => {
    const hist = [["pos1", "pos2"], ["pos1", "pos2"], ["pos1", "pos2"]];
    expect(checkStabilityStop(hist, 2)).toBe(true);
  });

  it("returns false when agent changes position", () => {
    const hist = [["pos1", "pos2"], ["pos1", "pos2"], ["pos1", "pos3"]];
    expect(checkStabilityStop(hist, 2)).toBe(false);
  });

  it("returns true when >= 80% stable (1 of 5 = 80%)", () => {
    const hist = [
      ["a", "b", "c", "d", "e"],
      ["a", "b", "c", "d", "e"],
      ["a", "b", "c", "d", "x"],
    ];
    expect(checkStabilityStop(hist, 2)).toBe(true);
  });
});

describe("filterByTopology", () => {
  const positions = [
    { agentId: 1, position: "A" },
    { agentId: 2, position: "B" },
    { agentId: 3, position: "C" },
  ];

  it("null graph returns all", () => {
    expect(filterByTopology(1, positions, null)).toHaveLength(3);
  });

  it("ring graph filters correctly", () => {
    const g = buildCommunicationGraph(agents3, "ring");
    const visible = filterByTopology(1, positions, g);
    const ids = visible.map(p => p.agentId);
    expect(ids).not.toContain(1);
    expect(ids.length).toBeGreaterThan(0);
  });
});

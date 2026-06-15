/**
 * KHMB bench-3 conflict tests — CI sanity, no data files.
 *
 * Verifies the six-axis formula resolves trust conflicts the way "honest
 * memory" demands: verification and provenance outweigh mere freshness. These
 * encode the intended priority so a future weight change can't silently invert
 * it.
 */
import { describe, it, expect } from "vitest";
import { runConflicts, sweepImportance } from "../../../scripts/bench/conflict";
import type { MemoryRow, VectorMap } from "../../../scripts/bench/types";

const NOW = Date.UTC(2026, 5, 15);

function makeBases(n: number): { bases: MemoryRow[]; vectors: VectorMap } {
  const bases: MemoryRow[] = [];
  const vectors: VectorMap = new Map();
  for (let i = 1; i <= n; i++) {
    bases.push({
      id: i, content: "x".repeat(40), type: "semantic", namespace: "_semantic",
      importance: 0.5, confidence: 0.9, strength: 0.9, decayRate: 0.01,
      provenance: "luca_inferred", verified: false,
      createdAt: NOW, lastAccessedAt: NOW, accessCount: 0,
    });
    vectors.set(i, new Float64Array([Math.sin(i), Math.cos(i), i / 10, 0.5]));
  }
  return { bases, vectors };
}

describe("KHMB conflict resolution", () => {
  const { bases, vectors } = makeBases(20);
  const results = runConflicts(bases, vectors);
  const byName = (n: string) => results.find((r) => r.name === n)!;

  it("old-verified beats fresh-guess (honesty > freshness)", () => {
    // A is the fresh guess; it should LOSE -> aWinRate near 0.
    expect(byName("fresh-guess vs old-verified").aWinRate).toBeLessThan(0.5);
  });

  it("trivial-verified beats important-guess", () => {
    expect(byName("important-guess vs trivial-verified").aWinRate).toBeLessThan(0.5);
  });

  it("stale-strong beats fresh-weak (decay matters)", () => {
    expect(byName("fresh-weak vs stale-strong").aWinRate).toBeLessThan(0.5);
  });

  it("importance sweep is monotonic-ish and decisive at large gaps", () => {
    const sweep = sweepImportance(bases, vectors);
    const large = sweep.find((s) => s.gap === 0.7)!;
    expect(large.winRate).toBeGreaterThan(0.5);
  });
});

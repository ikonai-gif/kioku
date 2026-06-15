/**
 * KHMB harness sanity tests — run in CI, no data files needed.
 *
 * These verify the scorer/metrics behave correctly on tiny synthetic inputs,
 * so the benchmark logic is regression-guarded even though the real snapshot
 * lives outside the repo.
 */
import { describe, it, expect } from "vitest";
import { cosine } from "../../../scripts/bench/loader";
import { scoreCandidates, ALL_AXES_ON, decayedConfidence } from "../../../scripts/bench/scorer";
import { recallAtK, reciprocalRank } from "../../../scripts/bench/metrics";
import { buildPairs, runAxis } from "../../../scripts/bench/axes";
import type { MemoryRow, VectorMap } from "../../../scripts/bench/types";

const NOW = Date.UTC(2026, 5, 15);

function row(id: number, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id, content: "x".repeat(40), type: "semantic", namespace: "_semantic",
    importance: 0.5, confidence: 0.9, strength: 0.9, decayRate: 0.01,
    provenance: "luca_inferred", verified: false,
    createdAt: NOW - 30 * 86_400_000, lastAccessedAt: NOW - 86_400_000, accessCount: 0,
    ...over,
  };
}

describe("KHMB cosine", () => {
  it("is 1.0 for identical vectors", () => {
    const v = new Float64Array([1, 2, 3]);
    expect(cosine(v, v)).toBeCloseTo(1.0, 6);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosine(new Float64Array([1, 0]), new Float64Array([0, 1]))).toBeCloseTo(0, 6);
  });
});

describe("KHMB metrics", () => {
  const results = [{ id: 5, score: 9 }, { id: 3, score: 8 }, { id: 1, score: 7 }];
  it("recallAtK counts gold hits in top-k", () => {
    expect(recallAtK(results, [3], 5)).toBe(1);
    expect(recallAtK(results, [99], 5)).toBe(0);
  });
  it("reciprocalRank uses first gold position", () => {
    expect(reciprocalRank(results, [3])).toBeCloseTo(1 / 2, 6);
  });
});

describe("KHMB decayedConfidence", () => {
  it("shrinks with age", () => {
    const fresh = decayedConfidence(row(1, { lastAccessedAt: NOW }), NOW);
    const stale = decayedConfidence(row(2, { lastAccessedAt: NOW - 100 * 86_400_000 }), NOW);
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe("KHMB scorer axes", () => {
  it("each axis decisively ranks the preferred member", () => {
    const vec = new Float64Array([0.1, 0.2, 0.3, 0.4]);
    for (const axis of ["t", "p", "v", "i", "c", "tau"] as const) {
      const pairs = buildPairs(axis, [row(1)], 1);
      const { preferred, other } = pairs[0];
      const vectors: VectorMap = new Map();
      vectors.set(preferred.id, vec);
      vectors.set(other.id, vec);
      vectors.set(-999, vec);
      const out = scoreCandidates(-999, [preferred, other], vectors, ALL_AXES_ON, NOW);
      expect(out[0].id).toBe(preferred.id);
    }
  });

  it("runAxis reports a win rate above 0.5 for every axis", () => {
    const vectors: VectorMap = new Map();
    const bases: MemoryRow[] = [];
    for (let i = 1; i <= 10; i++) {
      bases.push(row(i));
      vectors.set(i, new Float64Array([Math.sin(i), Math.cos(i), i / 10]));
    }
    for (const axis of ["t", "p", "v", "i", "c", "tau"] as const) {
      const r = runAxis(axis, bases, vectors, 10);
      expect(r.winRate).toBeGreaterThan(0.5);
    }
  });
});

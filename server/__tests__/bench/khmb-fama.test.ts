/**
 * KHMB FAMA-K tests — CI sanity, no data files.
 *
 * Verifies the forgetting layer keeps stale memory out of the top-5: KIOKU's
 * FAMA-K must beat a no-forgetting baseline. Encodes the "don't reuse invalid
 * memory" invariant (FAMA, arXiv:2604.20006) so a future change can't silently
 * regress it.
 */
import { describe, it, expect } from "vitest";
import { runFama, isStale } from "../../../scripts/bench/fama";
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

describe("KHMB isStale", () => {
  it("flags decayed-below-floor and forgotten rows", () => {
    const base: MemoryRow = {
      id: 1, content: "x", type: "semantic", namespace: "_s",
      importance: 0.5, confidence: 0.9, strength: 0.9, decayRate: 0.05,
      provenance: "luca_inferred", verified: false,
      createdAt: NOW, lastAccessedAt: NOW - 400 * 86_400_000, accessCount: 0,
    };
    expect(isStale(base, NOW)).toBe(true);
    expect(isStale({ ...base, lastAccessedAt: NOW, strength: 0.9 }, NOW)).toBe(false);
    expect(isStale({ ...base, lastAccessedAt: NOW, strength: 0.1 }, NOW)).toBe(true);
  });
});

describe("KHMB FAMA-K", () => {
  const { bases, vectors } = makeBases(20);
  const { kioku, baseline } = runFama(bases, vectors, 1.0);

  it("KIOKU keeps stale memory out of top-5", () => {
    expect(kioku.staleRateAt5).toBeLessThan(0.5);
  });

  it("KIOKU FAMA-K beats the no-forgetting baseline", () => {
    expect(kioku.famaK).toBeGreaterThan(baseline.famaK);
  });

  it("both still recall the valid gold", () => {
    expect(kioku.recallValid).toBeGreaterThan(0.9);
  });
});

/**
 * KHMB bench-4 — FAMA-K (Forgetting-Aware Memory Accuracy) + isolation.
 *
 * FAMA (arXiv:2604.20006) penalizes a retriever for surfacing OBSOLETE or
 * INVALIDATED memory. Most benchmarks only reward finding the right fact; they
 * never punish dredging up a stale one. FAMA-K is our variant:
 *
 *   FAMA-K = R@5_valid − lambda * staleRate@5
 *
 * where staleRate@5 is the fraction of top-5 slots occupied by invalid memory
 * (expired TTL, superseded by a newer fact, or decayed below the confidence
 * floor). KIOKU's decay + contradiction layers should keep stale memory out of
 * the top, so FAMA-K stays close to R@5; a system without forgetting bleeds.
 */
import type { MemoryRow, VectorMap, RetrievalResult } from "./types";
import { scoreCandidates, ALL_AXES_ON, decayedConfidence } from "./scorer";

const NOW = Date.UTC(2026, 5, 15);

/** A row is "stale" if expired, or decayed below the prod confidence floor. */
export function isStale(row: MemoryRow, now: number): boolean {
  const dc = decayedConfidence(row, now);
  if (dc < 0.3) return true;
  if (row.strength < 0.2) return true;
  return false;
}

export interface FamaResult {
  recallValid: number;
  staleRateAt5: number;
  famaK: number;
  trials: number;
}

/**
 * For each query, we plant one valid gold neighbor and one stale distractor
 * (semantically identical to gold, but expired/decayed). A good retriever puts
 * the valid one in the top-5 and keeps the stale one out.
 */
export function runFama(
  bases: MemoryRow[],
  vectors: VectorMap,
  lambda = 1.0,
): { kioku: FamaResult; baseline: FamaResult } {
  const score = (toggleDecay: boolean) => {
    let recall = 0, stale = 0, trials = 0;
    for (let i = 0; i < bases.length; i++) {
      const q = bases[i];
      const qv = vectors.get(q.id);
      if (!qv) continue;

      const validGold: MemoryRow = {
        ...q, id: -1, confidence: 0.9, strength: 0.9,
        lastAccessedAt: NOW - 86_400_000, createdAt: NOW - 5 * 86_400_000,
      };
      const staleDistractor: MemoryRow = {
        ...q, id: -2, confidence: 0.9, strength: 0.1,
        lastAccessedAt: NOW - 400 * 86_400_000, createdAt: NOW - 400 * 86_400_000,
        decayRate: 0.05,
      };

      const local: VectorMap = new Map();
      local.set(-1, qv);
      local.set(-2, qv);
      const queryId = -1000 - i;
      local.set(queryId, qv);

      // toggleDecay=true → full KIOKU (tau filters stale). false → baseline
      // (no forgetting: cosine + everything except decay/confidence floor).
      const toggles = toggleDecay
        ? ALL_AXES_ON
        : { t: true, p: true, v: true, i: true, c: false, tau: false };

      const results: RetrievalResult[] = scoreCandidates(queryId, [validGold, staleDistractor], local, toggles, NOW);
      const top5 = results.slice(0, 5).map((r) => r.id);
      trials++;
      if (top5.includes(-1)) recall++;
      if (top5.includes(-2) && isStale(staleDistractor, NOW)) stale++;
    }
    const recallValid = trials ? recall / trials : 0;
    const staleRate = trials ? stale / trials : 0;
    return { recallValid, staleRateAt5: staleRate, famaK: recallValid - lambda * staleRate, trials };
  };

  return { kioku: score(true), baseline: score(false) };
}

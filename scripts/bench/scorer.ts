/**
 * Six-axis retrieval scorer for KHMB.
 *
 * Mirrors the production composite score used in server/memory-injection.ts:
 * the base signal is embedding cosine similarity, modulated by the six memory
 * axes. Each axis can be toggled off to measure its isolated contribution
 * (ablation), which is how the per-axis tests (A1..A6) work.
 *
 *   t   — recency: newer / recently-accessed rows get a mild boost
 *   p   — provenance: user_told > tool_observed > luca_inferred
 *   v   — verified: verified=true outranks verified=false
 *   i   — importance: higher importance boosts
 *   c   — confidence: decayed confidence multiplies; <0.3 is filtered
 *   tau — decay/strength: low strength (forgotten) penalized
 */
import type { MemoryRow, VectorMap, RetrievalResult } from "./types";
import { cosine } from "./loader";

export interface AxisToggles {
  t: boolean;
  p: boolean;
  v: boolean;
  i: boolean;
  c: boolean;
  tau: boolean;
}

export const ALL_AXES_ON: AxisToggles = { t: true, p: true, v: true, i: true, c: true, tau: true };

const PROVENANCE_WEIGHT: Record<string, number> = {
  user_told: 1.3,
  tool_observed: 1.2,
  luca_inferred: 1.0,
};

const DAY_MS = 86_400_000;

/** Decayed confidence: confidence shrinks as a row ages without reinforcement. */
export function decayedConfidence(row: MemoryRow, now: number): number {
  const ageDays = Math.max(0, (now - row.lastAccessedAt) / DAY_MS);
  const decayed = row.confidence * Math.exp(-row.decayRate * ageDays);
  return Math.max(0, Math.min(1, decayed));
}

/**
 * Score all candidate rows against a query vector under the given axis toggles.
 * Returns results sorted by composite score, descending. The query row itself
 * (queryId) is excluded — this is leave-one-out retrieval.
 */
export function scoreCandidates(
  queryId: number,
  rows: MemoryRow[],
  vectors: VectorMap,
  toggles: AxisToggles,
  now: number,
): RetrievalResult[] {
  const qv = vectors.get(queryId);
  if (!qv) return [];

  const out: RetrievalResult[] = [];
  for (const row of rows) {
    if (row.id === queryId) continue;
    const rv = vectors.get(row.id);
    if (!rv) continue;

    // Axis c: confidence floor filter (matches prod's >0.3 gate).
    const dc = decayedConfidence(row, now);
    if (toggles.c && dc < 0.3) continue;

    let score = cosine(qv, rv);
    if (score <= 0) continue;

    if (toggles.i) score *= 0.7 + 0.6 * clamp01(row.importance);
    if (toggles.c) score *= 0.5 + 0.5 * dc;
    if (toggles.p) score *= PROVENANCE_WEIGHT[row.provenance] ?? 1.0;
    if (toggles.v) score *= row.verified ? 1.25 : 1.0;
    if (toggles.tau) score *= 0.6 + 0.4 * clamp01(row.strength);
    if (toggles.t) {
      const ageDays = Math.max(0, (now - row.createdAt) / DAY_MS);
      score *= 1 + 0.15 * Math.exp(-ageDays / 30);
    }

    out.push({ id: row.id, score });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

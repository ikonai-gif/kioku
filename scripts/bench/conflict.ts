/**
 * KHMB bench-3 — axis conflict + threshold sweep.
 *
 * The earlier tests gave each axis a clean win because only one axis differed.
 * Real memory is messier: the FRESH fact is often the UNVERIFIED guess, while
 * the VERIFIED fact is older. Which should win? This module measures how the
 * six-axis formula resolves such conflicts, and at what magnitude an axis stops
 * mattering (threshold sweep).
 */
import type { MemoryRow, VectorMap } from "./types";
import { scoreCandidates, ALL_AXES_ON } from "./scorer";

const NOW = Date.UTC(2026, 5, 15);
const DAY = 86_400_000;

function base(id: number, over: Partial<MemoryRow>): MemoryRow {
  return {
    id, content: "x".repeat(40), type: "semantic", namespace: "_semantic",
    importance: 0.5, confidence: 0.9, strength: 0.9, decayRate: 0.01,
    provenance: "luca_inferred", verified: false,
    createdAt: NOW - 30 * DAY, lastAccessedAt: NOW - DAY, accessCount: 0,
    ...over,
  };
}

/** Run a single head-to-head: which of two rows ranks first. Returns winner id. */
function duel(a: MemoryRow, b: MemoryRow, vectors: VectorMap, baseVec: Float64Array): number {
  const local: VectorMap = new Map();
  local.set(a.id, baseVec);
  local.set(b.id, baseVec);
  local.set(-777, baseVec);
  const res = scoreCandidates(-777, [a, b], local, ALL_AXES_ON, NOW);
  return res[0]?.id ?? 0;
}

export interface ConflictCase {
  name: string;
  description: string;
  /** fraction of base rows where rowA wins the conflict */
  aWinRate: number;
  trials: number;
}

/**
 * Conflict scenarios — each pits two axes against each other. We report which
 * side the formula favors, averaged over many real base embeddings.
 */
export function runConflicts(bases: MemoryRow[], vectors: VectorMap): ConflictCase[] {
  const cases: { name: string; description: string; a: Partial<MemoryRow>; b: Partial<MemoryRow> }[] = [
    {
      name: "fresh-guess vs old-verified",
      description: "A: 1d old, luca_inferred, unverified | B: 200d old, user_told, verified",
      a: { createdAt: NOW - DAY, provenance: "luca_inferred", verified: false },
      b: { createdAt: NOW - 200 * DAY, provenance: "user_told", verified: true },
    },
    {
      name: "important-guess vs trivial-verified",
      description: "A: importance 0.95, luca_inferred | B: importance 0.2, verified user_told",
      a: { importance: 0.95, provenance: "luca_inferred", verified: false },
      b: { importance: 0.2, provenance: "user_told", verified: true },
    },
    {
      name: "fresh-weak vs stale-strong",
      description: "A: 1d old, strength 0.2 | B: 90d old, strength 0.95",
      a: { createdAt: NOW - DAY, strength: 0.2 },
      b: { createdAt: NOW - 90 * DAY, strength: 0.95 },
    },
    {
      name: "high-conf-guess vs low-conf-observed",
      description: "A: confidence 0.95, luca_inferred | B: confidence 0.5, tool_observed",
      a: { confidence: 0.95, provenance: "luca_inferred" },
      b: { confidence: 0.5, provenance: "tool_observed" },
    },
  ];

  const out: ConflictCase[] = [];
  for (const c of cases) {
    let aWins = 0, trials = 0;
    for (const row of bases) {
      const v = vectors.get(row.id);
      if (!v) continue;
      const a = base(-1, c.a);
      const b = base(-2, c.b);
      const winner = duel(a, b, vectors, v);
      trials++;
      if (winner === a.id) aWins++;
    }
    out.push({ name: c.name, description: c.description, aWinRate: trials ? aWins / trials : 0, trials });
  }
  return out;
}

/**
 * Threshold sweep for one numeric axis: vary the gap between two rows and find
 * where the axis stops being decisive (win rate crosses 0.5). Shows the
 * formula's sensitivity, not just a binary "works/doesn't".
 */
export function sweepImportance(bases: MemoryRow[], vectors: VectorMap): { gap: number; winRate: number }[] {
  const gaps = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7];
  const out: { gap: number; winRate: number }[] = [];
  for (const gap of gaps) {
    let wins = 0, trials = 0;
    for (const row of bases) {
      const v = vectors.get(row.id);
      if (!v) continue;
      const a = base(-1, { importance: 0.5 + gap / 2 });
      const b = base(-2, { importance: 0.5 - gap / 2 });
      const winner = duel(a, b, vectors, v);
      trials++;
      if (winner === a.id) wins++;
    }
    out.push({ gap, winRate: trials ? wins / trials : 0 });
  }
  return out;
}

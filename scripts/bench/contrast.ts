/**
 * KHMB contrast runner — the "выйти вперёд" proof.
 *
 * For the three KIOKU-unique axes (p, v, tau), compares two systems on the
 * SAME controlled pairs:
 *   - KIOKU: full six-axis scorer (uses provenance/verified/strength).
 *   - Baseline: cosine-only (what LoCoMo/LongMemEval-style retrievers do —
 *     no provenance, no verified, no decay signal).
 *
 * On these pairs the two members are semantically identical (shared
 * embedding), so cosine alone is a coin flip (~0.5). KIOKU's axes break the
 * tie toward the trustworthy/fresh memory. The gap = the differentiator that
 * competitors structurally cannot close.
 */
import type { MemoryRow, VectorMap } from "./types";
import { buildPairs, type Axis } from "./axes";
import { scoreCandidates, type AxisToggles } from "./scorer";

const NOW = Date.UTC(2026, 5, 15);
const COSINE_ONLY: AxisToggles = { t: false, p: false, v: false, i: false, c: false, tau: false };
const KIOKU_FULL: AxisToggles = { t: true, p: true, v: true, i: true, c: true, tau: true };

function winRate(
  axis: Axis,
  bases: MemoryRow[],
  vectors: VectorMap,
  toggles: AxisToggles,
  n: number,
): number {
  const pairs = buildPairs(axis, bases, n);
  let wins = 0, counted = 0;
  for (let i = 0; i < pairs.length; i++) {
    const { preferred, other } = pairs[i];
    const baseVec = vectors.get(bases[i].id);
    if (!baseVec) continue;
    const local: VectorMap = new Map();
    local.set(preferred.id, baseVec);
    local.set(other.id, baseVec);
    const queryId = -1_000_000 - i;
    local.set(queryId, baseVec);
    const results = scoreCandidates(queryId, [preferred, other], local, toggles, NOW);
    if (results.length < 2) continue;
    counted++;
    // Tie (equal score) counts as half a win — honest coin-flip accounting.
    if (results[0].score === results[1].score) wins += 0.5;
    else if (results[0].id === preferred.id) wins += 1;
  }
  return counted ? wins / counted : 0;
}

export function runContrast(bases: MemoryRow[], vectors: VectorMap, n: number) {
  const unique: { axis: Axis; label: string }[] = [
    { axis: "p", label: "provenance (A2)" },
    { axis: "v", label: "verified (A3)" },
    { axis: "tau", label: "decay/strength (A6)" },
  ];
  console.log("KIOKU-unique axes — head-to-head vs cosine-only baseline\n");
  console.log("axis              KIOKU    baseline   gap");
  console.log("-".repeat(48));
  for (const u of unique) {
    const k = winRate(u.axis, bases, vectors, KIOKU_FULL, n);
    const b = winRate(u.axis, bases, vectors, COSINE_ONLY, n);
    const gap = k - b;
    console.log(
      u.label.padEnd(18) +
      k.toFixed(4).padEnd(9) +
      b.toFixed(4).padEnd(11) +
      `${gap >= 0 ? "+" : ""}${gap.toFixed(4)}`,
    );
  }
  console.log("\nbaseline ~0.5 = coin flip (cosine cannot tell them apart).");
  console.log("KIOKU ~1.0 = axis decisively picks the trustworthy memory.");
}

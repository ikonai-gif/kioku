/**
 * Synthetic axis tests for KHMB (A1..A6).
 *
 * Each test isolates ONE memory axis. We take real rows (with real embeddings)
 * and build controlled PAIRS that are identical on every axis except the one
 * under test. The query is the shared embedding; a correct scorer ranks the
 * "preferred" member of the pair above the other.
 *
 *   A1 t   — newer createdAt should win
 *   A2 p   — higher provenance (user_told > tool_observed > luca_inferred) wins
 *   A3 v   — verified=true wins
 *   A4 i   — higher importance wins
 *   A5 c   — higher confidence wins
 *   A6 tau — higher strength (not-forgotten) wins
 *
 * Score per axis = fraction of pairs where the preferred member ranks above
 * the other. 0.5 = axis has no effect (coin flip); 1.0 = axis fully decisive.
 */
import type { MemoryRow, VectorMap } from "./types";
import { scoreCandidates, ALL_AXES_ON } from "./scorer";

export type Axis = "t" | "p" | "v" | "i" | "c" | "tau";

interface Pair {
  preferred: MemoryRow;
  other: MemoryRow;
}

const NOW = Date.UTC(2026, 5, 15);
const DAY = 86_400_000;

/** Clone a base row, overriding fields. Synthetic ids are negative to avoid clashes. */
function clone(base: MemoryRow, id: number, over: Partial<MemoryRow>): MemoryRow {
  return { ...base, id, ...over };
}

/** Build N controlled pairs for one axis from real base rows. */
export function buildPairs(axis: Axis, bases: MemoryRow[], n: number): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < bases.length && pairs.length < n; i++) {
    const b = bases[i];
    // Neutral defaults: identical on everything, then differ on `axis`.
    const neutral: Partial<MemoryRow> = {
      importance: 0.5, confidence: 0.9, strength: 0.9, decayRate: 0.01,
      provenance: "luca_inferred", verified: false,
      createdAt: NOW - 30 * DAY, lastAccessedAt: NOW - 1 * DAY,
    };
    const idP = -(i * 2 + 1);
    const idO = -(i * 2 + 2);
    let preferred: MemoryRow, other: MemoryRow;
    switch (axis) {
      case "t":
        preferred = clone(b, idP, { ...neutral, createdAt: NOW - 1 * DAY });
        other = clone(b, idO, { ...neutral, createdAt: NOW - 200 * DAY });
        break;
      case "p":
        preferred = clone(b, idP, { ...neutral, provenance: "user_told" });
        other = clone(b, idO, { ...neutral, provenance: "luca_inferred" });
        break;
      case "v":
        preferred = clone(b, idP, { ...neutral, verified: true });
        other = clone(b, idO, { ...neutral, verified: false });
        break;
      case "i":
        preferred = clone(b, idP, { ...neutral, importance: 0.95 });
        other = clone(b, idO, { ...neutral, importance: 0.1 });
        break;
      case "c":
        preferred = clone(b, idP, { ...neutral, confidence: 0.95 });
        other = clone(b, idO, { ...neutral, confidence: 0.4 });
        break;
      case "tau":
        preferred = clone(b, idP, { ...neutral, strength: 0.95 });
        other = clone(b, idO, { ...neutral, strength: 0.15 });
        break;
    }
    pairs.push({ preferred, other });
  }
  return pairs;
}

/**
 * Run one axis test. For each pair, the query vector is the base row's own
 * embedding (the pair members reuse it via vectorAlias). Score = win rate.
 */
export function runAxis(
  axis: Axis,
  bases: MemoryRow[],
  vectors: VectorMap,
  n: number,
): { axis: Axis; winRate: number; pairs: number } {
  const pairs = buildPairs(axis, bases, n);
  let wins = 0;
  let counted = 0;
  for (let i = 0; i < pairs.length; i++) {
    const { preferred, other } = pairs[i];
    const baseVec = vectors.get(bases[i].id);
    if (!baseVec) continue;

    // Local vector map: both synthetic rows share the base embedding, plus a
    // query node (also the base embedding) so cosine ~1 for both — forcing the
    // axis weights to be the sole tiebreaker.
    const local: VectorMap = new Map(vectors);
    local.set(preferred.id, baseVec);
    local.set(other.id, baseVec);
    const queryId = -1_000_000 - i;
    local.set(queryId, baseVec);

    const results = scoreCandidates(queryId, [preferred, other], local, ALL_AXES_ON, NOW);
    if (results.length < 2) continue;
    counted++;
    if (results[0].id === preferred.id) wins++;
  }
  return { axis, winRate: counted ? wins / counted : 0, pairs: counted };
}

/**
 * Metrics + gold-set construction for KHMB.
 *
 * Gold construction (leave-one-out clustering): two memories are "relevant" to
 * each other if they share a namespace AND a type AND have high mutual cosine
 * similarity. For a query row, its gold set is the other rows in its cluster.
 * This needs no human labeling and no external API — it uses the embeddings
 * already in the snapshot.
 */
import type { MemoryRow, VectorMap, BenchQuery, RetrievalResult } from "./types";
import { cosine } from "./loader";

export function recallAtK(results: RetrievalResult[], goldIds: number[], k: number): number {
  if (goldIds.length === 0) return 0;
  const topK = new Set(results.slice(0, k).map((r) => r.id));
  let hit = 0;
  for (const g of goldIds) if (topK.has(g)) hit++;
  return hit / goldIds.length;
}

export function reciprocalRank(results: RetrievalResult[], goldIds: number[]): number {
  const gold = new Set(goldIds);
  for (let i = 0; i < results.length; i++) {
    if (gold.has(results[i].id)) return 1 / (i + 1);
  }
  return 0;
}

export interface AggregateMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  queriesEvaluated: number;
}

export function aggregate(
  queries: BenchQuery[],
  resultsFor: (q: BenchQuery) => RetrievalResult[],
): AggregateMetrics {
  let r5 = 0;
  let r10 = 0;
  let mrr = 0;
  let n = 0;
  for (const q of queries) {
    if (q.goldIds.length === 0) continue;
    const results = resultsFor(q);
    r5 += recallAtK(results, q.goldIds, 5);
    r10 += recallAtK(results, q.goldIds, 10);
    mrr += reciprocalRank(results, q.goldIds);
    n++;
  }
  return {
    recallAt5: n ? r5 / n : 0,
    recallAt10: n ? r10 / n : 0,
    mrr: n ? mrr / n : 0,
    queriesEvaluated: n,
  };
}

/**
 * Build a gold set by clustering rows that share namespace+type and exceed a
 * cosine threshold. Picks up to `maxQueries` query rows that have at least one
 * gold neighbor, for a stable, reproducible benchmark.
 */
export function buildGoldQueries(
  rows: MemoryRow[],
  vectors: VectorMap,
  opts: { simThreshold?: number; maxQueries?: number; minGold?: number; seed?: number } = {},
): BenchQuery[] {
  const simThreshold = opts.simThreshold ?? 0.82;
  const maxQueries = opts.maxQueries ?? 50;
  const minGold = opts.minGold ?? 1;

  const usable = rows.filter((r) => vectors.has(r.id) && r.content.length > 30);

  // Deterministic order: sort by id so the same snapshot yields the same set.
  usable.sort((a, b) => a.id - b.id);

  const queries: BenchQuery[] = [];
  for (const q of usable) {
    const qv = vectors.get(q.id)!;
    const gold: number[] = [];
    for (const cand of usable) {
      if (cand.id === q.id) continue;
      if (cand.namespace !== q.namespace || cand.type !== q.type) continue;
      const cv = vectors.get(cand.id)!;
      if (cosine(qv, cv) >= simThreshold) gold.push(cand.id);
    }
    if (gold.length >= minGold) {
      queries.push({ queryId: q.id, goldIds: gold, note: `${q.namespace}/${q.type}` });
    }
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

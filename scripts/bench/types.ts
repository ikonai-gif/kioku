/**
 * KHMB — KIOKU Honest Memory Benchmark
 *
 * Types shared across the benchmark harness. The harness measures retrieval
 * quality along the six memory axes (t, p, v, i, c, tau) plus a baseline
 * R@k / MRR, entirely offline against a local snapshot of production memory
 * vectors. No external embedding API is called: queries are existing rows
 * (leave-one-out), so every query already carries a real embedding.
 */

export interface MemoryRow {
  id: number;
  content: string;
  type: string;
  namespace: string;
  importance: number;
  confidence: number;
  strength: number;
  decayRate: number;
  provenance: string;
  verified: boolean;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

/** id -> 1536-dim embedding (cosine-ready, not necessarily normalized). */
export type VectorMap = Map<number, Float64Array>;

/** A single retrieval query for the benchmark. */
export interface BenchQuery {
  /** Row whose embedding is used as the query vector. */
  queryId: number;
  /** Gold set: ids that count as correct retrievals for this query. */
  goldIds: number[];
  /** Free-text note on why these are gold (for debugging). */
  note?: string;
}

export interface RetrievalResult {
  id: number;
  score: number;
}

export interface AxisScores {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  queriesEvaluated: number;
}

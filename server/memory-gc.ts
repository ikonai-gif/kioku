import { Pool } from 'pg';
import { computeDecayedStrength, computeDecayedConfidence } from './memory-decay';

/**
 * Memory Garbage Collector
 * Prunes memories whose effective strength OR confidence has decayed below threshold.
 *
 * - Memories with strength < 0.05 are "forgotten" (soft-deleted)
 * - Memories with confidence < 0.1 are also pruned (Phase 2)
 * - Procedural memories never decay (skills persist)
 * - Emotional memories decay slowest (half-life 30 days)
 * - Memories accessed frequently are reinforced
 *
 * Designed to run periodically (daily or weekly).
 */

export async function pruneDecayedMemories(
  pool: Pool,
  userId: number,
  threshold: number = 0.05,
  confidenceThreshold: number = 0.1
): Promise<{ pruned: number; total: number; prunedByConfidence: number }> {
  const now = Date.now();

  // Get all non-procedural memories with positive strength
  const result = await pool.query(
    `SELECT id, type, strength, confidence, decay_rate, created_at, last_accessed_at, access_count, last_reinforced_at
     FROM memories
     WHERE user_id = $1 AND type != 'procedural' AND COALESCE(strength, 1.0) > 0`,
    [userId]
  );

  const toPrune: number[] = [];
  let prunedByConfidence = 0;

  for (const mem of result.rows) {
    const effectiveStrength = computeDecayedStrength(
      mem.strength ?? 1.0,
      mem.type,
      Number(mem.created_at),
      mem.last_accessed_at ? Number(mem.last_accessed_at) : null,
      mem.access_count ?? 0,
      now
    );

    const currentConfidence = computeDecayedConfidence(
      mem.confidence ?? 1.0,
      mem.decay_rate ?? 0.01,
      mem.last_reinforced_at ? Number(mem.last_reinforced_at) : null,
      Number(mem.created_at),
      now
    );

    if (effectiveStrength < threshold) {
      toPrune.push(mem.id);
    } else if (currentConfidence < confidenceThreshold) {
      toPrune.push(mem.id);
      prunedByConfidence++;
    }
  }

  if (toPrune.length > 0) {
    // Soft delete: set strength and confidence to 0
    await pool.query(
      `UPDATE memories SET strength = 0, confidence = 0, namespace = COALESCE(namespace, '') || '[forgotten]' WHERE id = ANY($1)`,
      [toPrune]
    );
  }

  return { pruned: toPrune.length, total: result.rows.length, prunedByConfidence };
}

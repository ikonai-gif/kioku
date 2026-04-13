import { Pool } from 'pg';
import { computeDecayedStrength } from './memory-decay';

/**
 * Memory Garbage Collector
 * Prunes memories whose effective strength has decayed below threshold.
 *
 * - Memories with strength < 0.05 are "forgotten" (soft-deleted)
 * - Procedural memories never decay (skills persist)
 * - Emotional memories decay slowest (half-life 30 days)
 * - Memories accessed frequently are reinforced
 *
 * Designed to run periodically (daily or weekly).
 */

export async function pruneDecayedMemories(pool: Pool, userId: number, threshold: number = 0.05): Promise<{ pruned: number; total: number }> {
  const now = Date.now();

  // Get all non-procedural memories with positive strength
  const result = await pool.query(
    `SELECT id, type, strength, created_at, last_accessed_at, access_count
     FROM memories
     WHERE user_id = $1 AND type != 'procedural' AND COALESCE(strength, 1.0) > 0`,
    [userId]
  );

  const toPrune: number[] = [];

  for (const mem of result.rows) {
    const effectiveStrength = computeDecayedStrength(
      mem.strength ?? 1.0,
      mem.type,
      Number(mem.created_at),
      mem.last_accessed_at ? Number(mem.last_accessed_at) : null,
      mem.access_count ?? 0,
      now
    );

    if (effectiveStrength < threshold) {
      toPrune.push(mem.id);
    }
  }

  if (toPrune.length > 0) {
    // Soft delete: set strength to 0
    await pool.query(
      `UPDATE memories SET strength = 0, namespace = COALESCE(namespace, '') || '[forgotten]' WHERE id = ANY($1)`,
      [toPrune]
    );
  }

  return { pruned: toPrune.length, total: result.rows.length };
}

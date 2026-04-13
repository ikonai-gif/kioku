import { Pool } from 'pg';

/**
 * Memory consolidation merges highly similar memories for the same user.
 * - Finds clusters of memories with cosine similarity > 0.92
 * - Keeps the more important memory, soft-deletes the other
 * - Creates synaptic "refines" links from kept to merged
 * - Boosts importance and strength of kept memory
 *
 * Designed to run as a background maintenance task.
 */

export async function consolidateMemories(pool: Pool, userId: number): Promise<{ merged: number; kept: number }> {
  // Find pairs of very similar memories
  const pairs = await pool.query(`
    SELECT m1.id as id1, m2.id as id2,
           m1.content as content1, m2.content as content2,
           m1.importance as imp1, m2.importance as imp2,
           m1.type as type1, m2.type as type2,
           m1.created_at as created1, m2.created_at as created2,
           1 - (m1.embedding_vec <=> m2.embedding_vec) as similarity
    FROM memories m1
    JOIN memories m2 ON m1.user_id = m2.user_id
      AND m1.id < m2.id
      AND m1.embedding_vec IS NOT NULL
      AND m2.embedding_vec IS NOT NULL
    WHERE m1.user_id = $1
      AND 1 - (m1.embedding_vec <=> m2.embedding_vec) > 0.92
    ORDER BY similarity DESC
    LIMIT 50
  `, [userId]);

  if (pairs.rows.length === 0) return { merged: 0, kept: 0 };

  const mergedIds = new Set<number>();
  let mergeCount = 0;

  for (const pair of pairs.rows) {
    if (mergedIds.has(pair.id1) || mergedIds.has(pair.id2)) continue;

    // Keep the more important / newer one, mark other as merged
    const keepId = pair.imp1 >= pair.imp2 ? pair.id1 : pair.id2;
    const mergeId = keepId === pair.id1 ? pair.id2 : pair.id1;

    // Boost importance of kept memory
    const newImportance = Math.min(1.0, Math.max(pair.imp1, pair.imp2) + 0.05);
    await pool.query(
      'UPDATE memories SET importance = $1, strength = LEAST(1.0, COALESCE(strength, 1.0) + 0.1) WHERE id = $2',
      [newImportance, keepId]
    );

    // Create a "refines" link
    await pool.query(
      'INSERT INTO memory_links (source_memory_id, target_memory_id, user_id, link_type, strength, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [keepId, mergeId, userId, 'refines', pair.similarity, Date.now()]
    );

    // Soft-delete the merged memory (set strength to 0)
    await pool.query(
      `UPDATE memories SET strength = 0, namespace = COALESCE(namespace, '') || '[consolidated]' WHERE id = $1`,
      [mergeId]
    );

    mergedIds.add(mergeId);
    mergeCount++;
  }

  return { merged: mergeCount, kept: pairs.rows.length - mergeCount };
}

/**
 * Position Lock — Phase 4c
 * Tracks agent's stated positions and prevents sycophantic reversal without new evidence.
 * Uses the existing memories table with namespace="stable_positions".
 */

import { pool } from "./storage";

/**
 * Check if the agent has a locked position on a similar topic.
 * Searches memories with namespace="stable_positions" for keyword overlap with the topic.
 */
export async function checkPositionLock(
  agentId: number,
  userId: number,
  topic: string,
  storageRef: any
): Promise<{ locked: boolean; previousPosition: string | null }> {
  try {
    const topicLower = topic.toLowerCase();
    const topicWords = topicLower.split(/\s+/).filter(w => w.length > 3);
    if (topicWords.length === 0) return { locked: false, previousPosition: null };

    // Search memories with namespace="stable_positions" for this agent
    const result = await pool.query(
      `SELECT content, confidence, context_trigger FROM memories
       WHERE user_id = $1 AND agent_id = $2 AND namespace = 'stable_positions'
       AND confidence > 0.7
       ORDER BY created_at DESC LIMIT 20`,
      [userId, agentId]
    );

    if (result.rows.length === 0) return { locked: false, previousPosition: null };

    // Find the best-matching position based on topic keyword overlap
    let bestMatch: { content: string; score: number } | null = null;

    for (const row of result.rows) {
      const content = (row.content as string).toLowerCase();
      const contentWords = content.split(/\s+/).filter((w: string) => w.length > 3);
      const matches = topicWords.filter(w => contentWords.includes(w));
      const score = matches.length;

      // Require at least 2 overlapping words for a match
      if (score >= 2 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { content: row.content, score };
      }
    }

    if (bestMatch) {
      // Extract the actual position from the content format: [Position on "topic"] position text
      const positionMatch = bestMatch.content.match(/\]\s*(.+)/);
      const previousPosition = positionMatch ? positionMatch[1].trim() : bestMatch.content;
      return { locked: true, previousPosition };
    }

    return { locked: false, previousPosition: null };
  } catch {
    return { locked: false, previousPosition: null };
  }
}

/**
 * Save a locked position for an agent on a given topic.
 * Only saves if confidence exceeds the threshold (0.7).
 */
export async function savePositionLock(
  agentId: number,
  userId: number,
  agentName: string,
  topic: string,
  position: string,
  confidence: number,
  storageRef: any
): Promise<void> {
  if (confidence <= 0.7) return;

  try {
    await storageRef.createMemory({
      userId,
      agentId,
      agentName,
      content: `[Position on "${topic.slice(0, 60)}"] ${position}`,
      type: 'procedural',
      importance: 0.9,
      namespace: 'stable_positions',
      contextTrigger: `position_lock:${topic.slice(0, 60).toLowerCase().replace(/\s+/g, '_')}`,
    });
  } catch {
    // Fire-and-forget — don't break deliberation if save fails
  }
}

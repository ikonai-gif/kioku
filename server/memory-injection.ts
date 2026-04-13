/**
 * Memory Injection for Deliberation — KIOKU™ Phase 2
 *
 * Before each deliberation phase, fetches relevant memories for each agent,
 * filters by confidence, and formats them for injection into the agent's
 * system prompt. Also reinforces accessed memories.
 */

import { storage } from "./storage";
import { computeDecayedConfidence } from "./memory-decay";

export interface InjectedMemory {
  id: number;
  content: string;
  type: string;
  confidence: number;
  expiresAt?: number | null;
}

/**
 * Fetch relevant memories for a specific agent in the context of a deliberation topic.
 * Includes both agent-specific memories (agentId match) and shared memories (agentId = null).
 * Filters by decayed confidence > 0.3, returns top N sorted by relevance * confidence.
 */
export async function fetchRelevantMemories(
  userId: number,
  agentId: number,
  topic: string,
  limit: number = 10
): Promise<InjectedMemory[]> {
  // Fetch all user memories (includes all agents + shared)
  const allMemories = await storage.getMemories(userId, 500);

  // Filter to agent-specific + shared (agentId = null) memories
  const candidateMemories = allMemories.filter(
    (m) => m.agentId === agentId || m.agentId === null
  );

  if (candidateMemories.length === 0) return [];

  const now = Date.now();
  const topicLower = topic.toLowerCase();
  const topicWords = topicLower.split(/\s+/).filter((w) => w.length > 3);

  // Score each memory by topic relevance * decayed confidence
  const scored = candidateMemories
    .map((m: any) => {
      const currentConfidence = m.currentConfidence ?? computeDecayedConfidence(
        m.confidence ?? 1.0,
        m.decayRate ?? 0.01,
        m.lastReinforcedAt,
        m.createdAt,
        now
      );

      // Skip memories below confidence threshold
      if (currentConfidence <= 0.3) return null;

      // Skip expired temporal memories
      if (m.expiresAt && m.expiresAt < now) return null;

      // Simple text relevance: count matching words from topic in memory content
      const contentLower = (m.content || "").toLowerCase();
      const matchCount = topicWords.filter((w) => contentLower.includes(w)).length;
      const textRelevance = topicWords.length > 0 ? matchCount / topicWords.length : 0.1;

      // Boost procedural memories (decisions) and memories in "decisions" namespace
      const typeBoost = m.type === "procedural" ? 1.3 : m.type === "causal" ? 1.2 : 1.0;
      const nsBoost = m.namespace === "decisions" ? 1.3 : 1.0;

      // Combined score: relevance * confidence * importance * boosts
      const score = textRelevance * currentConfidence * (m.importance ?? 0.5) * typeBoost * nsBoost;

      return {
        id: m.id,
        content: m.content,
        type: m.type,
        confidence: Math.round(currentConfidence * 100) / 100,
        expiresAt: m.expiresAt,
        score,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ score: _score, ...rest }) => rest);
}

/**
 * Format injected memories as a system prompt section.
 * Returns empty string if no memories — keeps prompt clean.
 */
export function formatMemoryContext(memories: InjectedMemory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m, i) => {
    const expiryTag = m.expiresAt
      ? `, expires: ${new Date(m.expiresAt).toISOString().split("T")[0]}`
      : "";
    return `${i + 1}. [${m.type}, confidence: ${m.confidence}${expiryTag}] "${m.content}"`;
  });

  return `\n\n## Your Memories (relevant to this discussion)\n${lines.join("\n")}\n\nUse these memories to inform your position. Reference them when making arguments.`;
}

/**
 * Reinforce accessed memories — bump lastReinforcedAt + reinforcements counter.
 * Fire-and-forget to avoid slowing down deliberation.
 */
export function reinforceAccessedMemories(
  userId: number,
  memories: InjectedMemory[]
): void {
  if (memories.length === 0) return;
  for (const m of memories) {
    storage.reinforceMemory(m.id, userId).catch(() => {});
  }
}

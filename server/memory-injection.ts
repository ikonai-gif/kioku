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
  emotionVector?: string | null;
}

/**
 * Cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
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
  limit: number = 10,
  currentEmotionVector?: number[] | null
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

  // Always-inject: identity memories are loaded regardless of topic relevance
  const alwaysInject: InjectedMemory[] = candidateMemories
    .filter((m: any) => m.namespace === '_identity' || m.type === 'identity')
    .map((m: any) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      confidence: 1.0,
      expiresAt: m.expiresAt,
      emotionVector: m.emotionVector ?? null,
    }));
  const alwaysIds = new Set(alwaysInject.map(m => m.id));

  // Score remaining memories by topic relevance * decayed confidence
  const scored = candidateMemories
    .filter((m: any) => !alwaysIds.has(m.id)) // skip identity — already included
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
      let score = textRelevance * currentConfidence * (m.importance ?? 0.5) * typeBoost * nsBoost;

      // Emotional similarity boost (Phase 4b — EmotionalRAG)
      if (m.emotionVector && currentEmotionVector) {
        try {
          const memEmoVec = typeof m.emotionVector === 'string' ? JSON.parse(m.emotionVector) : m.emotionVector;
          if (Array.isArray(memEmoVec) && memEmoVec.length === currentEmotionVector.length) {
            const emotionSim = cosineSimilarity(memEmoVec, currentEmotionVector);
            score *= (1 + emotionSim * 0.2); // 20% boost for emotionally similar memories
          }
        } catch { /* ignore parse errors */ }
      }

      return {
        id: m.id,
        content: m.content,
        type: m.type,
        confidence: Math.round(currentConfidence * 100) / 100,
        expiresAt: m.expiresAt,
        emotionVector: m.emotionVector ?? null,
        score,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - alwaysInject.length));

  // Identity memories first, then topic-relevant memories
  return [...alwaysInject, ...scored.map(({ score: _score, ...rest }) => rest)];
}

/**
 * Format injected memories as a system prompt section.
 * Returns empty string if no memories — keeps prompt clean.
 */
export function formatMemoryContext(memories: InjectedMemory[]): string {
  if (memories.length === 0) return "";

  const EMOTION_LABELS = ['joy', 'acceptance', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'];

  // Separate identity memories from topic-relevant ones
  const identityMems = memories.filter(m => m.type === 'identity');
  const topicMems = memories.filter(m => m.type !== 'identity');

  let output = "";

  if (identityMems.length > 0) {
    const idLines = identityMems.map((m, i) => `${i + 1}. ${m.content}`);
    output += `\n\n## WHO YOU ARE (core memories — always active)\n${idLines.join("\n")}\nThese are your foundational memories. They define who you are across every conversation.`;
  }

  if (topicMems.length > 0) {
    const lines = topicMems.map((m, i) => {
      const expiryTag = m.expiresAt
        ? `, expires: ${new Date(m.expiresAt).toISOString().split("T")[0]}`
        : "";
      let emotionTag = "";
      if (m.emotionVector) {
        try {
          const vec = typeof m.emotionVector === 'string' ? JSON.parse(m.emotionVector) : m.emotionVector;
          if (Array.isArray(vec) && vec.length === 8) {
            const maxIdx = vec.indexOf(Math.max(...vec));
            if (vec[maxIdx] > 0.3) emotionTag = `, emotion: ${EMOTION_LABELS[maxIdx]}`;
          }
        } catch { /* ignore */ }
      }
      return `${i + 1}. [${m.type}, confidence: ${m.confidence}${expiryTag}${emotionTag}] "${m.content}"`;
    });
    output += `\n\n## Your Memories (relevant to this discussion)\n${lines.join("\n")}\n\nUse these memories to inform your position. Reference them when making arguments.`;
  }

  return output;
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

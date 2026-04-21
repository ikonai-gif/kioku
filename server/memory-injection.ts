/**
 * Memory Injection for Deliberation — KIOKU™ Phase 2
 *
 * Before each deliberation phase, fetches relevant memories for each agent,
 * filters by confidence, and formats them for injection into the agent's
 * system prompt. Also reinforces accessed memories.
 */

import { storage, pool } from "./storage";
import { computeDecayedConfidence } from "./memory-decay";
import { embedText } from "./embeddings";

export interface InjectedMemory {
  id: number;
  content: string;
  type: string;
  confidence: number;
  expiresAt?: number | null;
  emotionVector?: string | null;
  namespace?: string | null;
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

  // Always-inject: identity memories are loaded regardless of topic relevance.
  // W7 P2.3 — hard cap at IDENTITY_TOKEN_CAP characters (~chars/4 tokens). When
  // over cap, keep highest-importance first, ties broken by recency (newest
  // first). This prevents runaway identity-blob growth from silently blowing
  // context on agents with many identity entries (e.g. Luca's 20+ rows).
  const IDENTITY_TOKEN_CAP = 2500; // tokens
  const IDENTITY_CHAR_CAP = IDENTITY_TOKEN_CAP * 4;
  const identityCandidates = candidateMemories
    .filter((m: any) => m.namespace === '_identity' || m.type === 'identity')
    .sort((a: any, b: any) => {
      const impA = typeof a.importance === 'number' ? a.importance : 0.5;
      const impB = typeof b.importance === 'number' ? b.importance : 0.5;
      if (impA !== impB) return impB - impA;
      const tsA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tsB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tsB - tsA;
    });

  const alwaysInject: InjectedMemory[] = [];
  let identityCharUsed = 0;
  for (const m of identityCandidates) {
    const content = (m as any).content ?? "";
    if (identityCharUsed + content.length > IDENTITY_CHAR_CAP && alwaysInject.length > 0) break;
    alwaysInject.push({
      id: m.id,
      content,
      type: (m as any).type,
      confidence: 1.0,
      expiresAt: (m as any).expiresAt,
      emotionVector: (m as any).emotionVector ?? null,
      namespace: (m as any).namespace ?? null,
    });
    identityCharUsed += content.length;
  }

  // Always-inject: 3 most recent episode summaries regardless of keyword match
  const episodeSummaries: InjectedMemory[] = candidateMemories
    .filter((m: any) => m.namespace === '_episode_summaries')
    .sort((a: any, b: any) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 3)
    .map((m: any) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      confidence: 1.0,
      expiresAt: m.expiresAt,
      emotionVector: m.emotionVector ?? null,
      namespace: '_episode_summaries',
    }));

  const alwaysIds = new Set([...alwaysInject, ...episodeSummaries].map(m => m.id));

  // ── Vector semantic search (preferred path) ─────────────────────────────
  let topicEmbedding: number[] | null = null;
  try {
    topicEmbedding = await embedText(topic);
  } catch { /* fall through to keyword fallback */ }

  if (topicEmbedding) {
    // Direct vector search via pgvector — much better than keyword matching
    const embeddingStr = `[${topicEmbedding.join(',')}]`;
    const vectorResults = await pool.query(`
      SELECT m.*,
        1 - (m.embedding_vec <=> $1::vector) as semantic_similarity
      FROM memories m
      WHERE m.user_id = $2
        AND (m.agent_id = $3 OR m.agent_id IS NULL)
        AND m.embedding_vec IS NOT NULL
        AND m.namespace != '_identity'
        AND m.namespace != '_episode_summaries'
      ORDER BY m.embedding_vec <=> $1::vector
      LIMIT 20
    `, [embeddingStr, userId, agentId]);

    // Score vector results with composite ranking
    const scored = vectorResults.rows
      .filter((m: any) => !alwaysIds.has(m.id))
      .map((m: any) => {
        const currentConfidence = computeDecayedConfidence(
          m.confidence ?? 1.0,
          m.decay_rate ?? 0.01,
          m.last_reinforced_at,
          m.created_at,
          now
        );
        if (currentConfidence <= 0.3) return null;
        if (m.expires_at && m.expires_at < now) return null;

        const semanticSimilarity = parseFloat(m.semantic_similarity) || 0;
        const typeBoost = m.type === "procedural" ? 1.3 : m.type === "causal" ? 1.2 : 1.0;
        const nsBoost = m.namespace === "decisions" ? 1.3 : 1.0;

        // Temporal boost: recent memories get a lift
        const age = now - (m.created_at || now);
        const dayMs = 86400000;
        const temporalBoost = age < dayMs ? 1.0 : age < dayMs * 7 ? 0.9 : 0.8;

        let score = semanticSimilarity * currentConfidence * (m.importance ?? 0.5) * typeBoost * nsBoost * temporalBoost;

        // Emotional similarity boost (Phase 4b — EmotionalRAG)
        if (m.emotion_vector && currentEmotionVector) {
          try {
            const memEmoVec = typeof m.emotion_vector === 'string' ? JSON.parse(m.emotion_vector) : m.emotion_vector;
            if (Array.isArray(memEmoVec) && memEmoVec.length === currentEmotionVector.length) {
              const emotionSim = cosineSimilarity(memEmoVec, currentEmotionVector);
              score *= (1 + emotionSim * 0.2);
            }
          } catch { /* ignore parse errors */ }
        }

        return {
          id: m.id,
          content: m.content,
          type: m.type,
          confidence: Math.round(currentConfidence * 100) / 100,
          expiresAt: m.expires_at,
          emotionVector: m.emotion_vector ?? null,
          namespace: m.namespace ?? null,
          score,
        };
      })
      .filter((m: any): m is NonNullable<typeof m> => m !== null && m.score > 0)
      .sort((a: any, b: any) => b.score - a.score);

    // ── Graph walk: fetch 1-hop connected memories for top 10 vector results ──
    const topIds = scored.slice(0, 10).map((r: any) => r.id);
    let graphMemories: any[] = [];
    if (topIds.length > 0) {
      try {
        const graphResults = await pool.query(`
          SELECT DISTINCT m.*, ml.link_type, ml.strength as link_strength
          FROM memory_links ml
          JOIN memories m ON m.id = ml.target_memory_id
          WHERE ml.source_memory_id = ANY($1) AND ml.user_id = $2
            AND m.namespace != '_identity' AND m.namespace != '_episode_summaries'
          UNION
          SELECT DISTINCT m.*, ml.link_type, ml.strength as link_strength
          FROM memory_links ml
          JOIN memories m ON m.id = ml.source_memory_id
          WHERE ml.target_memory_id = ANY($1) AND ml.user_id = $2
            AND m.namespace != '_identity' AND m.namespace != '_episode_summaries'
        `, [topIds, userId]);
        graphMemories = graphResults.rows;
      } catch { /* graph walk failure is non-fatal */ }
    }

    // Merge vector + graph results, deduplicate by id
    const seenIds = new Set([...alwaysIds, ...scored.map((r: any) => r.id)]);
    const graphScored = graphMemories
      .filter((m: any) => !seenIds.has(m.id))
      .map((m: any) => {
        const currentConfidence = computeDecayedConfidence(
          m.confidence ?? 1.0,
          m.decay_rate ?? 0.01,
          m.last_reinforced_at,
          m.created_at,
          now
        );
        if (currentConfidence <= 0.3) return null;
        // Graph-discovered memories get a score based on link strength
        const linkStrength = parseFloat(m.link_strength) || 0.5;
        return {
          id: m.id,
          content: m.content,
          type: m.type,
          confidence: Math.round(currentConfidence * 100) / 100,
          expiresAt: m.expires_at,
          emotionVector: m.emotion_vector ?? null,
          namespace: m.namespace ?? null,
          score: linkStrength * currentConfidence * (m.importance ?? 0.5),
        };
      })
      .filter((m: any): m is NonNullable<typeof m> => m !== null && m.score > 0);

    const merged = [...scored, ...graphScored]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit - alwaysInject.length - episodeSummaries.length));

    return [...alwaysInject, ...episodeSummaries, ...merged.map(({ score: _score, ...rest }) => rest)];
  }

  // ── FALLBACK: keyword matching (if embedText fails or returns null) ─────
  const scored = candidateMemories
    .filter((m: any) => !alwaysIds.has(m.id))
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
      const matchCount = topicWords.filter((w: string) => contentLower.includes(w)).length;
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
            score *= (1 + emotionSim * 0.2);
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
        namespace: m.namespace ?? null,
        score,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - alwaysInject.length - episodeSummaries.length));

  // Identity memories first, then episode summaries, then topic-relevant memories
  return [...alwaysInject, ...episodeSummaries, ...scored.map(({ score: _score, ...rest }) => rest)];
}

/**
 * Format injected memories as a system prompt section.
 * Returns empty string if no memories — keeps prompt clean.
 */
export interface MemoryLink {
  sourceId: number;
  targetId: number;
  type: string;
  strength?: number;
}

export function formatMemoryContext(memories: InjectedMemory[], links?: MemoryLink[]): string {
  if (memories.length === 0) return "";

  const EMOTION_LABELS = ['joy', 'acceptance', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'];

  // Build a lookup of memory content by id for link display
  const memById = new Map<number, InjectedMemory>();
  for (const m of memories) memById.set(m.id, m);

  // Build a map of links: sourceId -> array of {targetId, type, strength}
  const linkMap = new Map<number, { targetId: number; type: string; strength?: number; content: string }[]>();
  if (links && links.length > 0) {
    for (const link of links) {
      const target = memById.get(link.targetId);
      const source = memById.get(link.sourceId);
      // Show link from source perspective: source -> target
      if (target) {
        if (!linkMap.has(link.sourceId)) linkMap.set(link.sourceId, []);
        linkMap.get(link.sourceId)!.push({ targetId: link.targetId, type: link.type, strength: link.strength, content: target.content });
      }
      // Also show reverse: target -> source
      if (source) {
        if (!linkMap.has(link.targetId)) linkMap.set(link.targetId, []);
        linkMap.get(link.targetId)!.push({ targetId: link.sourceId, type: link.type, strength: link.strength, content: source.content });
      }
    }
  }

  // Separate identity, episode summaries, and topic-relevant memories.
  // W7 P2.3 — classify identity by namespace OR type so memories authored
  // with only one of the two tags still render in the "WHO YOU ARE" block.
  // Without this, Luca-style rows (namespace=_identity, type=semantic) fell
  // into "Your Memories" with a confidence score, buried under topic RAG hits.
  const isIdentity = (m: InjectedMemory) => m.type === 'identity' || m.namespace === '_identity';
  const identityMems = memories.filter(isIdentity);
  const identityIds = new Set(identityMems.map(m => m.id));
  const episodeMems = memories.filter(m => m.namespace === '_episode_summaries' && !identityIds.has(m.id));
  const episodeIds = new Set(episodeMems.map(m => m.id));
  const topicMems = memories.filter(m => !isIdentity(m) && !episodeIds.has(m.id));

  let output = "";

  if (identityMems.length > 0) {
    const idLines = identityMems.map((m, i) => `${i + 1}. ${m.content}`);
    output += `\n\n## WHO YOU ARE (core memories — always active)\n${idLines.join("\n")}\nThese are your foundational memories. They define who you are across every conversation.`;
  }

  if (episodeMems.length > 0) {
    const epLines = episodeMems.map((m, i) => `${i + 1}. ${m.content}`);
    output += `\n\n## RECENT CONVERSATIONS (your episodic memory)\n${epLines.join("\n")}\nThese are summaries of your recent conversations. Use them to maintain continuity — reference past discussions naturally.`;
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
      let line = `${i + 1}. [${m.type}, confidence: ${m.confidence}${expiryTag}${emotionTag}] "${m.content}"`;

      // Show associative links for this memory
      const memLinks = linkMap.get(m.id);
      if (memLinks && memLinks.length > 0) {
        for (const link of memLinks) {
          const simTag = link.strength != null ? ` (sim: ${link.strength})` : "";
          const snippet = link.content.length > 80 ? link.content.slice(0, 80) + "..." : link.content;
          line += `\n   \u2192 ${link.type} to: "${snippet}"${simTag}`;
        }
      }

      return line;
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

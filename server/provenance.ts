/**
 * Cross-session Decision Provenance Chain — KIOKU™
 *
 * Tracks chains of decisions across multiple deliberation sessions.
 * Enables tracing how decisions evolve over time and across sessions.
 *
 * Key concepts:
 *   - provenance_chain_id: UUID grouping related deliberations
 *   - chain_depth: how deep in the chain (0 = root)
 *   - parent_deliberation_id: links to the previous deliberation
 *   - chain_metadata: context about why a deliberation links to its parent
 */

import { randomUUID } from "crypto";
import { storage } from "./storage";

// ── Types ────────────────────────────────────────────────────────────

export interface ProvenanceChain {
  chainId: string;
  topic: string;
  createdAt: number;
  deliberations: ProvenanceDeliberation[];
  summary: ChainSummary;
}

export interface ProvenanceDeliberation {
  sessionId: string;
  topic: string;
  status: string;
  consensus: any | null;
  startedAt: number;
  completedAt: number | null;
  chainDepth: number;
  parentDeliberationId: string | null;
  chainMetadata: any | null;
}

export interface ChainSummary {
  chainId: string;
  topic: string;
  totalDeliberations: number;
  maxDepth: number;
  firstDecisionAt: number;
  lastDecisionAt: number;
  consensusHistory: Array<{
    sessionId: string;
    decision: string;
    confidence: number;
    timestamp: number;
  }>;
}

export interface ProvenanceTreeNode {
  id: string;
  topic: string;
  decision: string | null;
  confidence: number | null;
  status: string;
  depth: number;
  startedAt: number;
  children: ProvenanceTreeNode[];
}

// ── Stop words for topic similarity ──────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "about", "what",
  "which", "who", "whom", "this", "that", "these", "those", "am", "it",
  "its", "we", "they", "them", "our", "your", "his", "her", "my",
]);

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Start a new provenance chain.
 * Sets the initial deliberation as the root (depth 0) and returns the chain UUID.
 */
export async function startProvenanceChain(
  roomId: number,
  initialDeliberationId: string,
  topic: string
): Promise<string> {
  const chainId = randomUUID();

  await storage.updateProvenanceFields(initialDeliberationId, {
    provenanceChainId: chainId,
    parentDeliberationId: null,
    chainDepth: 0,
    chainMetadata: { origin: "manual", topic },
  });

  return chainId;
}

/**
 * Link a new deliberation to an existing provenance chain.
 * Validates against circular references and max chain depth.
 */
export async function linkToChain(
  chainId: string,
  newDeliberationId: string,
  parentDeliberationId: string,
  metadata?: object
): Promise<void> {
  // Prevent self-referencing
  if (newDeliberationId === parentDeliberationId) {
    throw new Error("Cannot link a deliberation to itself");
  }

  // Get the parent to determine depth
  const parent = await storage.getDeliberationSession(parentDeliberationId);
  if (!parent) {
    throw new Error("Parent deliberation not found");
  }

  // Verify parent belongs to the same chain
  if (parent.provenanceChainId && parent.provenanceChainId !== chainId) {
    throw new Error("Parent deliberation belongs to a different chain");
  }

  const parentDepth = parent.chainDepth ?? 0;
  const newDepth = parentDepth + 1;

  // Prevent excessively deep chains (max 50)
  if (newDepth > 50) {
    throw new Error("Maximum chain depth (50) exceeded");
  }

  // Circular reference check: walk up the chain from parent to verify newDeliberationId is not an ancestor
  const ancestors = await getAncestorIds(parentDeliberationId);
  if (ancestors.has(newDeliberationId)) {
    throw new Error("Circular reference detected: new deliberation is already an ancestor in this chain");
  }

  await storage.updateProvenanceFields(newDeliberationId, {
    provenanceChainId: chainId,
    parentDeliberationId: parentDeliberationId,
    chainDepth: newDepth,
    chainMetadata: metadata || null,
  });
}

/**
 * Auto-detect if a new deliberation relates to an existing chain.
 * Uses keyword overlap similarity against recent deliberations in the same room.
 * Returns the chain_id if a match is found (similarity > 0.6), or null.
 */
export async function autoLinkDeliberation(
  roomId: number,
  deliberationId: string,
  topic: string
): Promise<string | null> {
  const recentDeliberations = await storage.getRecentDeliberationsForRoom(roomId, 30);

  if (recentDeliberations.length === 0) return null;

  const topicTokens = tokenize(topic);
  if (topicTokens.length === 0) return null;

  let bestMatch: { sessionId: string; chainId: string | null; similarity: number; depth: number } | null = null;

  for (const delib of recentDeliberations) {
    // Skip self
    if (delib.sessionId === deliberationId) continue;

    const delibTokens = tokenize(delib.topic);
    if (delibTokens.length === 0) continue;

    const similarity = computeTokenSimilarity(topicTokens, delibTokens);

    if (similarity > 0.6 && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = {
        sessionId: delib.sessionId,
        chainId: delib.provenanceChainId,
        similarity,
        depth: delib.chainDepth ?? 0,
      };
    }
  }

  if (!bestMatch) return null;

  // If the best match already has a chain, link to it
  if (bestMatch.chainId) {
    try {
      await linkToChain(bestMatch.chainId, deliberationId, bestMatch.sessionId, {
        origin: "auto",
        similarity: bestMatch.similarity,
      });
      return bestMatch.chainId;
    } catch {
      // If linking fails (e.g., circular ref), start a new chain instead
      return null;
    }
  }

  // Best match has no chain — create a new one, assign the match as root, then link new one
  const chainId = await startProvenanceChain(roomId, bestMatch.sessionId, recentDeliberations.find(d => d.sessionId === bestMatch!.sessionId)?.topic || topic);

  try {
    await linkToChain(chainId, deliberationId, bestMatch.sessionId, {
      origin: "auto",
      similarity: bestMatch.similarity,
    });
    return chainId;
  } catch {
    return null;
  }
}

/**
 * Get full provenance chain — all deliberations in order with their decisions.
 */
export async function getProvenanceChainById(chainId: string): Promise<ProvenanceChain | null> {
  const deliberations = await storage.getDeliberationsByChainId(chainId);

  if (deliberations.length === 0) return null;

  // Use the root deliberation's topic as the chain topic
  const root = deliberations.find((d: any) => d.chainDepth === 0) || deliberations[0];

  const mapped: ProvenanceDeliberation[] = deliberations.map((d: any) => ({
    sessionId: d.sessionId,
    topic: d.topic,
    status: d.status,
    consensus: d.consensus,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    chainDepth: d.chainDepth ?? 0,
    parentDeliberationId: d.parentDecisionId,
    chainMetadata: d.chainMetadata,
  }));

  const summary = buildChainSummary(chainId, mapped);

  return {
    chainId,
    topic: root.topic,
    createdAt: root.startedAt,
    deliberations: mapped,
    summary,
  };
}

/**
 * Get chain summary — condensed view of the chain.
 */
export async function getChainSummary(chainId: string): Promise<ChainSummary | null> {
  const deliberations = await storage.getDeliberationsByChainId(chainId);
  if (deliberations.length === 0) return null;

  const mapped: ProvenanceDeliberation[] = deliberations.map((d: any) => ({
    sessionId: d.sessionId,
    topic: d.topic,
    status: d.status,
    consensus: d.consensus,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    chainDepth: d.chainDepth ?? 0,
    parentDeliberationId: d.parentDecisionId,
    chainMetadata: d.chainMetadata,
  }));

  return buildChainSummary(chainId, mapped);
}

/**
 * Get chain as a tree structure for UI visualization.
 */
export async function getProvenanceTree(chainId: string): Promise<ProvenanceTreeNode | null> {
  const deliberations = await storage.getDeliberationsByChainId(chainId);
  if (deliberations.length === 0) return null;

  // Build a lookup map
  const byId = new Map<string, any>();
  for (const d of deliberations) {
    byId.set(d.sessionId, d);
  }

  // Find root(s) — deliberations with no parent or depth 0
  const roots = deliberations.filter((d: any) => !d.parentDecisionId || d.chainDepth === 0);
  if (roots.length === 0) return null;

  const root = roots[0];
  return buildTreeNode(root, deliberations);
}

// ── Internal Helpers ─────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute Jaccard-like similarity between two token sets.
 * Returns 0–1 where 1 = identical token sets.
 */
export function computeTokenSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  if (union === 0) return 0;

  return intersection / union;
}

async function getAncestorIds(sessionId: string): Promise<Set<string>> {
  const ancestors = new Set<string>();
  let currentId: string | null = sessionId;
  let depth = 0;

  while (currentId && depth < 50) {
    const session = await storage.getDeliberationSession(currentId);
    if (!session) break;

    ancestors.add(currentId);
    currentId = session.parentDecisionId;
    depth++;
  }

  return ancestors;
}

function buildChainSummary(chainId: string, deliberations: ProvenanceDeliberation[]): ChainSummary {
  const root = deliberations.find(d => d.chainDepth === 0) || deliberations[0];

  const consensusHistory = deliberations
    .filter(d => d.consensus)
    .map(d => ({
      sessionId: d.sessionId,
      decision: d.consensus?.decision || "",
      confidence: d.consensus?.confidence || 0,
      timestamp: d.completedAt || d.startedAt,
    }));

  const timestamps = deliberations.map(d => d.completedAt || d.startedAt);

  return {
    chainId,
    topic: root?.topic || "",
    totalDeliberations: deliberations.length,
    maxDepth: Math.max(0, ...deliberations.map(d => d.chainDepth)),
    firstDecisionAt: Math.min(...timestamps),
    lastDecisionAt: Math.max(...timestamps),
    consensusHistory,
  };
}

function buildTreeNode(session: any, allDeliberations: any[]): ProvenanceTreeNode {
  const children = allDeliberations.filter(
    (d: any) => d.parentDecisionId === session.sessionId && d.sessionId !== session.sessionId
  );

  return {
    id: session.sessionId,
    topic: session.topic,
    decision: session.consensus?.decision || null,
    confidence: session.consensus?.confidence || null,
    status: session.status,
    depth: session.chainDepth ?? 0,
    startedAt: session.startedAt,
    children: children.map((child: any) => buildTreeNode(child, allDeliberations)),
  };
}

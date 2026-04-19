/**
 * Test helpers and mock factories for KIOKU™ test suite.
 * Provides mock storage, mock agents, mock memories, and utility functions.
 */

import { vi } from "vitest";

// ── Time Constants ──────────────────────────────────────────────────

export const DAY_MS = 1000 * 60 * 60 * 24;
export const HOUR_MS = 1000 * 60 * 60;
export const MINUTE_MS = 1000 * 60;

// ── Mock Factory: Memory ────────────────────────────────────────────

export function createMockMemory(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: overrides.id ?? 1,
    userId: overrides.userId ?? 1,
    agentId: overrides.agentId ?? 1,
    agentName: overrides.agentName ?? "TestAgent",
    content: overrides.content ?? "Test memory content",
    type: overrides.type ?? "semantic",
    importance: overrides.importance ?? 0.5,
    namespace: overrides.namespace ?? null,
    embedding: overrides.embedding ?? null,
    strength: overrides.strength ?? 1.0,
    emotionalValence: overrides.emotionalValence ?? 0,
    lastAccessedAt: overrides.lastAccessedAt ?? null,
    accessCount: overrides.accessCount ?? 0,
    confidence: overrides.confidence ?? 0.9,
    decayRate: overrides.decayRate ?? 0.01,
    lastReinforcedAt: overrides.lastReinforcedAt ?? null,
    reinforcements: overrides.reinforcements ?? 0,
    expiresAt: overrides.expiresAt ?? null,
    causeId: overrides.causeId ?? null,
    contextTrigger: overrides.contextTrigger ?? null,
    emotionVector: overrides.emotionVector ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    currentConfidence: overrides.currentConfidence ?? undefined,
  };
}

// ── Mock Factory: Agent ─────────────────────────────────────────────

export function createMockAgent(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: overrides.id ?? 1,
    userId: overrides.userId ?? 1,
    name: overrides.name ?? "TestAgent",
    description: overrides.description ?? "A test agent",
    color: overrides.color ?? "#FF0000",
    model: overrides.model ?? "gpt-4o",
    role: overrides.role ?? null,
    llmProvider: overrides.llmProvider ?? null,
    llmApiKey: overrides.llmApiKey ?? null,
    llmModel: overrides.llmModel ?? null,
    agentType: overrides.agentType ?? "internal",
    webhookUrl: overrides.webhookUrl ?? null,
    webhookSecret: overrides.webhookSecret ?? null,
    status: overrides.status ?? "online",
    consecutiveFailures: overrides.consecutiveFailures ?? 0,
    errorMessage: overrides.errorMessage ?? null,
    memoriesCount: overrides.memoriesCount ?? 0,
    lastActiveAt: overrides.lastActiveAt ?? null,
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

// ── Mock Factory: Room ──────────────────────────────────────────────

export function createMockRoom(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: overrides.id ?? 1,
    userId: overrides.userId ?? 1,
    name: overrides.name ?? "Test Room",
    description: overrides.description ?? "A test room",
    status: overrides.status ?? "active",
    agentIds: overrides.agentIds ?? JSON.stringify([1, 2]),
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

// ── Mock Factory: Agent Position ────────────────────────────────────

export function createMockPosition(overrides: Partial<Record<string, any>> = {}) {
  return {
    agentId: overrides.agentId ?? 1,
    agentName: overrides.agentName ?? "TestAgent",
    agentColor: overrides.agentColor ?? "#FF0000",
    position: overrides.position ?? "I support this proposal",
    confidence: overrides.confidence ?? 0.8,
    reasoning: overrides.reasoning ?? "Because it makes sense",
  };
}

// ── Mock Factory: Emotional State ───────────────────────────────────

export function createMockEmotionalState(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: overrides.id ?? 1,
    agentId: overrides.agentId ?? 1,
    userId: overrides.userId ?? 1,
    pleasure: overrides.pleasure ?? 0.0,
    arousal: overrides.arousal ?? 0.0,
    dominance: overrides.dominance ?? 0.0,
    baselinePleasure: overrides.baselinePleasure ?? 0.1,
    baselineArousal: overrides.baselineArousal ?? 0.0,
    baselineDominance: overrides.baselineDominance ?? 0.2,
    emotionLabel: overrides.emotionLabel ?? "neutral",
    poignancySum: overrides.poignancySum ?? 0.0,
    halfLifeMinutes: overrides.halfLifeMinutes ?? 120,
    lastUpdatedAt: overrides.lastUpdatedAt ?? Date.now(),
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

// ── Mock Storage ────────────────────────────────────────────────────

export function createMockStorage() {
  return {
    getUserByEmail: vi.fn(),
    getUserByApiKey: vi.fn(),
    getUserById: vi.fn(),
    createUser: vi.fn(),
    updateUserPlan: vi.fn(),
    rotateApiKey: vi.fn(),
    createMagicToken: vi.fn(),
    verifyMagicToken: vi.fn(),
    getAgents: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    updateAgentStatus: vi.fn(),
    updateAgentCircuitBreaker: vi.fn(),
    getMemories: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    createMemory: vi.fn().mockImplementation(async (data: any) => ({
      id: Math.floor(Math.random() * 10000),
      ...data,
      createdAt: Date.now(),
    })),
    reinforceMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(true),
    purgeMemories: vi.fn().mockResolvedValue(0),
    getMemoriesCount: vi.fn().mockResolvedValue(0),
    createMemoryLink: vi.fn(),
    getMemoryLinks: vi.fn().mockResolvedValue([]),
    getLinkedMemories: vi.fn().mockResolvedValue([]),
    deleteMemoryLink: vi.fn(),
    getFlows: vi.fn().mockResolvedValue([]),
    createFlow: vi.fn(),
    updateFlow: vi.fn(),
    deleteFlow: vi.fn(),
    getRooms: vi.fn().mockResolvedValue([]),
    getRoom: vi.fn(),
    createRoom: vi.fn(),
    updateRoom: vi.fn(),
    deleteRoom: vi.fn(),
    getRoomMessages: vi.fn().mockResolvedValue([]),
    addRoomMessage: vi.fn().mockImplementation(async (data: any) => ({
      id: Math.floor(Math.random() * 10000),
      ...data,
      createdAt: Date.now(),
    })),
    addLog: vi.fn(),
    getLogs: vi.fn().mockResolvedValue([]),
    getGalleryItems: vi.fn().mockResolvedValue([]),
    getAgentEmotionalState: vi.fn().mockResolvedValue(null),
    upsertAgentEmotionalState: vi.fn(),
    getRelationship: vi.fn().mockResolvedValue(null),
    upsertRelationship: vi.fn(),
    incrementInteraction: vi.fn(),
    incrementUsage: vi.fn(),
    getDeliberationSession: vi.fn(),
    saveDeliberationSession: vi.fn(),
    getDeliberationsByRoom: vi.fn().mockResolvedValue([]),
    getLatestConsensus: vi.fn().mockResolvedValue(null),
    buildProvenanceChain: vi.fn().mockResolvedValue([]),
    getDecisionAncestors: vi.fn().mockResolvedValue([]),
    getDecisionDescendants: vi.fn().mockResolvedValue([]),
    getDecisionChildren: vi.fn().mockResolvedValue([]),
    listKnowledgeDomains: vi.fn().mockResolvedValue([]),
    getWebhook: vi.fn().mockResolvedValue(null),
    createAgentTurn: vi.fn(),
    getAgentTurn: vi.fn(),
  };
}

// ── Mock Pool (for consolidation/gc tests) ──────────────────────────

export function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

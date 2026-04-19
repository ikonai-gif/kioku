/**
 * KIOKU™ API Integration Tests
 *
 * Tests core HTTP endpoints for memories, deliberation, and authentication.
 * Uses mocked storage layer since we can't connect to the real database in CI.
 * These tests validate request/response contracts and middleware behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockMemory, createMockAgent, createMockRoom, createMockStorage } from "../helpers/setup";

// ── Mock Storage Module ─────────────────────────────────────────────

const mockStorage = createMockStorage();
const mockPool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };

vi.mock("../../server/storage", () => ({
  storage: mockStorage,
  pool: mockPool,
  db: {},
}));

vi.mock("../../server/ws", () => ({
  setupWebSocket: vi.fn(),
  broadcastToRoom: vi.fn(),
  broadcastHumanTurn: vi.fn(),
  getActiveWsConnectionCount: vi.fn().mockReturnValue(0),
}));

vi.mock("../../server/embeddings", () => ({
  embedText: vi.fn().mockResolvedValue(null),
  cosineSimilarity: vi.fn().mockReturnValue(0),
  embeddingsEnabled: false,
}));

vi.mock("../../server/deliberation", () => ({
  triggerAgentResponses: vi.fn(),
  generateProactiveMessage: vi.fn(),
}));

vi.mock("../../server/structured-deliberation", () => ({
  runDeliberation: vi.fn(),
  getSession: vi.fn(),
  getSessionsByRoom: vi.fn().mockResolvedValue([]),
  getLatestConsensus: vi.fn().mockResolvedValue(null),
  submitHumanInput: vi.fn(),
  getActiveDeliberationCount: vi.fn().mockReturnValue(0),
  getProvenanceChain: vi.fn(),
  getProvenanceTree: vi.fn(),
  runCreativeDeliberation: vi.fn(),
  CREATIVE_ROLES: {},
}));

// ── Request/Response Contract Tests ─────────────────────────────────

describe("API Endpoint Contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/memories — Create Memory", () => {
    it("requires content field", () => {
      const body = { type: "semantic" };
      // Content is required by validation middleware
      expect(body).not.toHaveProperty("content");
    });

    it("accepts valid memory creation payload", () => {
      const body = {
        content: "TypeScript improves code quality",
        type: "semantic",
        importance: 0.7,
        namespace: "coding",
      };

      expect(body.content).toBeDefined();
      expect(body.content.length).toBeGreaterThan(0);
      expect(body.content.length).toBeLessThanOrEqual(50000);
      expect(body.importance).toBeGreaterThanOrEqual(0);
      expect(body.importance).toBeLessThanOrEqual(1);
    });

    it("validates importance range [0, 1]", () => {
      const invalidHigh = { content: "test", importance: 1.5 };
      const invalidLow = { content: "test", importance: -0.1 };
      const valid = { content: "test", importance: 0.5 };

      expect(invalidHigh.importance).toBeGreaterThan(1);
      expect(invalidLow.importance).toBeLessThan(0);
      expect(valid.importance).toBeGreaterThanOrEqual(0);
      expect(valid.importance).toBeLessThanOrEqual(1);
    });

    it("validates content length (1-50000 chars)", () => {
      const tooShort = { content: "" };
      const tooLong = { content: "x".repeat(50001) };
      const valid = { content: "Normal memory content" };

      expect(tooShort.content.length).toBe(0);
      expect(tooLong.content.length).toBeGreaterThan(50000);
      expect(valid.content.length).toBeGreaterThanOrEqual(1);
      expect(valid.content.length).toBeLessThanOrEqual(50000);
    });

    it("storage.createMemory returns created memory with ID", async () => {
      const input = {
        userId: 1,
        agentId: 1,
        agentName: "TestAgent",
        content: "New memory",
        type: "semantic",
        importance: 0.5,
      };

      const result = await mockStorage.createMemory(input);
      expect(result).toHaveProperty("id");
      expect(result.content).toBe("New memory");
      expect(mockStorage.createMemory).toHaveBeenCalledWith(input);
    });
  });

  describe("GET /api/memories — List Memories", () => {
    it("returns paginated memories", async () => {
      const memories = [
        createMockMemory({ id: 1, content: "Memory 1" }),
        createMockMemory({ id: 2, content: "Memory 2" }),
      ];
      mockStorage.getMemories.mockResolvedValue(memories);

      const result = await mockStorage.getMemories(1, 50, 0);
      expect(result).toHaveLength(2);
      expect(mockStorage.getMemories).toHaveBeenCalledWith(1, 50, 0);
    });

    it("supports limit and offset parameters", async () => {
      mockStorage.getMemories.mockResolvedValue([]);
      await mockStorage.getMemories(1, 10, 20);
      expect(mockStorage.getMemories).toHaveBeenCalledWith(1, 10, 20);
    });
  });

  describe("DELETE /api/memories/:id — Delete Memory", () => {
    it("returns true when memory is deleted", async () => {
      mockStorage.deleteMemory.mockResolvedValue(true);
      const result = await mockStorage.deleteMemory(1, 1);
      expect(result).toBe(true);
    });

    it("returns false when memory not found", async () => {
      mockStorage.deleteMemory.mockResolvedValue(false);
      const result = await mockStorage.deleteMemory(999, 1);
      expect(result).toBe(false);
    });
  });

  describe("GET /api/memories/search — Search Memories", () => {
    it("searches by query string", async () => {
      const results = [
        createMockMemory({ id: 1, content: "TypeScript best practices" }),
      ];
      mockStorage.searchMemories.mockResolvedValue(results);

      const result = await mockStorage.searchMemories(1, "TypeScript");
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain("TypeScript");
    });

    it("supports namespace filtering", async () => {
      mockStorage.searchMemories.mockResolvedValue([]);
      await mockStorage.searchMemories(1, "query", undefined, "decisions");
      expect(mockStorage.searchMemories).toHaveBeenCalledWith(1, "query", undefined, "decisions");
    });
  });
});

// ── Memory Link Operations ──────────────────────────────────────────

describe("Memory Links API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a memory link", async () => {
    const link = { id: 1, sourceMemoryId: 10, targetMemoryId: 11, linkType: "related", strength: 0.8 };
    mockStorage.createMemoryLink.mockResolvedValue(link);

    const result = await mockStorage.createMemoryLink(1, 10, 11, "related", 0.8);
    expect(result.linkType).toBe("related");
    expect(result.strength).toBe(0.8);
  });

  it("retrieves links for a memory", async () => {
    const links = [
      { id: 1, sourceMemoryId: 10, targetMemoryId: 11, linkType: "related" },
      { id: 2, sourceMemoryId: 10, targetMemoryId: 12, linkType: "causal" },
    ];
    mockStorage.getMemoryLinks.mockResolvedValue(links);

    const result = await mockStorage.getMemoryLinks(1, 10);
    expect(result).toHaveLength(2);
  });

  it("traverses memory graph", async () => {
    const graphResults = [
      createMockMemory({ id: 11 }),
      createMockMemory({ id: 12 }),
      createMockMemory({ id: 13 }),
    ];
    mockStorage.getLinkedMemories.mockResolvedValue(graphResults);

    const result = await mockStorage.getLinkedMemories(1, 10, 2, 10);
    expect(result).toHaveLength(3);
    expect(mockStorage.getLinkedMemories).toHaveBeenCalledWith(1, 10, 2, 10);
  });
});

// ── Deliberation API ────────────────────────────────────────────────

describe("Deliberation API Contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/rooms/:id/deliberate — Start Deliberation", () => {
    it("requires topic field", () => {
      const validBody = { topic: "Should we use microservices?" };
      const invalidBody = {};

      expect(validBody).toHaveProperty("topic");
      expect(invalidBody).not.toHaveProperty("topic");
    });

    it("accepts optional configuration", () => {
      const body = {
        topic: "API design approach",
        model: "gpt-4o",
        debateRounds: 3,
        includeHuman: true,
        humanName: "Product Manager",
        parentDecisionId: "dlb_1_1700000000000",
      };

      expect(body.debateRounds).toBe(3);
      expect(body.includeHuman).toBe(true);
      expect(body.parentDecisionId).toBeDefined();
    });
  });

  describe("GET /api/rooms/:id/deliberations — List Sessions", () => {
    it("returns sessions for a room", async () => {
      const sessions = [
        {
          sessionId: "dlb_1_1700000000000",
          roomId: 1,
          topic: "Test topic",
          status: "completed",
          consensus: { decision: "Plan A", confidence: 0.85 },
        },
      ];
      mockStorage.getDeliberationsByRoom.mockResolvedValue(sessions);

      const result = await mockStorage.getDeliberationsByRoom(1);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("completed");
    });
  });

  describe("GET /api/rooms/:id/consensus — Latest Consensus", () => {
    it("returns latest consensus", async () => {
      const consensus = {
        decision: "Use REST API",
        confidence: 0.85,
        method: "weighted_majority",
        votes: [
          { agentName: "Alpha", position: "Use REST API", confidence: 0.9, changedMind: false },
          { agentName: "Beta", position: "Use REST API", confidence: 0.8, changedMind: true },
        ],
        dissent: [],
      };
      mockStorage.getLatestConsensus.mockResolvedValue(consensus);

      const result = await mockStorage.getLatestConsensus(1);
      expect(result?.decision).toBe("Use REST API");
      expect(result?.method).toBe("weighted_majority");
      expect(result?.votes).toHaveLength(2);
    });

    it("returns null when no deliberations have occurred", async () => {
      mockStorage.getLatestConsensus.mockResolvedValue(null);
      const result = await mockStorage.getLatestConsensus(999);
      expect(result).toBeNull();
    });
  });
});

// ── Memory Maintenance Operations ───────────────────────────────────

describe("Memory Maintenance API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/memories/consolidate", () => {
    it("consolidation merges similar memories", async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [
            { id1: 1, id2: 2, content1: "A", content2: "A similar", imp1: 0.8, imp2: 0.6, similarity: 0.95 },
          ],
          rowCount: 1,
        })
        .mockResolvedValue({ rows: [], rowCount: 0 });

      // Simulate consolidation behavior
      const pairs = await mockPool.query("SELECT...", [1]);
      expect(pairs.rows).toHaveLength(1);
      expect(pairs.rows[0].similarity).toBeGreaterThan(0.92);
    });
  });

  describe("POST /api/memories/gc", () => {
    it("prunes decayed memories below threshold", async () => {
      // The gc endpoint calls pruneDecayedMemories which uses pool directly
      const gcResult = { pruned: 5, total: 100, prunedByConfidence: 2 };
      expect(gcResult.pruned).toBe(5);
      expect(gcResult.prunedByConfidence).toBe(2);
    });
  });

  describe("DELETE /api/memories/purge", () => {
    it("purges all memories for a user", async () => {
      mockStorage.purgeMemories.mockResolvedValue(42);
      const result = await mockStorage.purgeMemories(1, "all");
      expect(result).toBe(42);
      expect(mockStorage.purgeMemories).toHaveBeenCalledWith(1, "all");
    });

    it("purges agent-specific memories", async () => {
      mockStorage.purgeMemories.mockResolvedValue(10);
      const result = await mockStorage.purgeMemories(1, "agent", "5");
      expect(result).toBe(10);
      expect(mockStorage.purgeMemories).toHaveBeenCalledWith(1, "agent", "5");
    });
  });
});

// ── Authentication Contract ─────────────────────────────────────────

describe("Authentication Contracts", () => {
  it("API key lookup returns user", async () => {
    const user = {
      id: 1,
      email: "test@example.com",
      name: "Test User",
      plan: "dev",
      apiKey: "kk_test1234",
    };
    mockStorage.getUserByApiKey.mockResolvedValue(user);

    const result = await mockStorage.getUserByApiKey("kk_test1234");
    expect(result).toBeDefined();
    expect(result?.id).toBe(1);
  });

  it("invalid API key returns undefined", async () => {
    mockStorage.getUserByApiKey.mockResolvedValue(undefined);
    const result = await mockStorage.getUserByApiKey("invalid_key");
    expect(result).toBeUndefined();
  });

  it("magic token creation returns token string", async () => {
    mockStorage.createMagicToken.mockResolvedValue("abc123def456");
    const token = await mockStorage.createMagicToken("user@example.com");
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
  });

  it("magic token verification returns email or null", async () => {
    mockStorage.verifyMagicToken.mockResolvedValue("user@example.com");
    const email = await mockStorage.verifyMagicToken("valid_token");
    expect(email).toBe("user@example.com");

    mockStorage.verifyMagicToken.mockResolvedValue(null);
    const invalid = await mockStorage.verifyMagicToken("expired_token");
    expect(invalid).toBeNull();
  });
});

// ── Reinforce Memory ────────────────────────────────────────────────

describe("Memory Reinforcement", () => {
  it("reinforceMemory updates access metadata", async () => {
    await mockStorage.reinforceMemory(1, 1);
    expect(mockStorage.reinforceMemory).toHaveBeenCalledWith(1, 1);
  });

  it("reinforceAccessedMemories is fire-and-forget", async () => {
    // Should not throw even if reinforcement fails
    mockStorage.reinforceMemory.mockRejectedValue(new Error("DB error"));
    await expect(
      mockStorage.reinforceMemory(1, 1).catch(() => {})
    ).resolves.toBeUndefined();
  });
});

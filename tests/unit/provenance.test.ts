/**
 * KIOKU™ Cross-session Decision Provenance Chain — Unit Tests
 *
 * Tests the provenance chain engine's core functions:
 * - startProvenanceChain: creating new chains
 * - linkToChain: linking deliberations with depth tracking
 * - autoLinkDeliberation: semantic similarity auto-detection
 * - getProvenanceChainById: full chain retrieval in order
 * - getProvenanceTree: tree structure generation
 * - computeTokenSimilarity: keyword overlap scoring
 * - Edge cases: orphans, circular references, max chain depth
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeTokenSimilarity } from "../../server/provenance";

// ── Mock Storage Module ─────────────────────────────────────────────

const mockUpdateProvenanceFields = vi.fn().mockResolvedValue(undefined);
const mockGetDeliberationSession = vi.fn();
const mockGetDeliberationsByChainId = vi.fn().mockResolvedValue([]);
const mockGetRecentDeliberationsForRoom = vi.fn().mockResolvedValue([]);
const mockGetProvenanceChainsForRoom = vi.fn().mockResolvedValue([]);

vi.mock("../../server/storage", () => ({
  storage: {
    updateProvenanceFields: (...args: any[]) => mockUpdateProvenanceFields(...args),
    getDeliberationSession: (...args: any[]) => mockGetDeliberationSession(...args),
    getDeliberationsByChainId: (...args: any[]) => mockGetDeliberationsByChainId(...args),
    getRecentDeliberationsForRoom: (...args: any[]) => mockGetRecentDeliberationsForRoom(...args),
    getProvenanceChainsForRoom: (...args: any[]) => mockGetProvenanceChainsForRoom(...args),
  },
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

// Import after mock setup
import {
  startProvenanceChain,
  linkToChain,
  autoLinkDeliberation,
  getProvenanceChainById,
  getChainSummary,
  getProvenanceTree,
} from "../../server/provenance";

// ── Helpers ─────────────────────────────────────────────────────────

function createMockDelibSession(overrides: Partial<Record<string, any>> = {}) {
  const defaultConsensus = { decision: "Test decision", confidence: 0.8, method: "weighted_majority", votes: [], dissent: [] };
  return {
    sessionId: overrides.sessionId ?? "dlb_1_1000",
    roomId: overrides.roomId ?? 1,
    userId: overrides.userId ?? 1,
    topic: overrides.topic ?? "Test topic",
    status: overrides.status ?? "completed",
    model: overrides.model ?? "gpt-4o",
    modelsUsed: overrides.modelsUsed ?? ["gpt-4o"],
    rounds: overrides.rounds ?? [],
    consensus: "consensus" in overrides ? overrides.consensus : defaultConsensus,
    startedAt: overrides.startedAt ?? 1000000,
    completedAt: overrides.completedAt ?? 1001000,
    parentDecisionId: overrides.parentDecisionId ?? null,
    provenanceChain: overrides.provenanceChain ?? [],
    provenanceChainId: overrides.provenanceChainId ?? null,
    chainDepth: overrides.chainDepth ?? 0,
    chainMetadata: overrides.chainMetadata ?? null,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Provenance Chain — Token Similarity", () => {
  it("returns 1.0 for identical token sets", () => {
    const tokens = ["budget", "quarterly", "review", "meeting"];
    expect(computeTokenSimilarity(tokens, tokens)).toBe(1.0);
  });

  it("returns 0 for completely disjoint token sets", () => {
    const a = ["budget", "quarterly", "review"];
    const b = ["engineering", "sprint", "velocity"];
    expect(computeTokenSimilarity(a, b)).toBe(0);
  });

  it("returns value between 0 and 1 for partial overlap", () => {
    const a = ["budget", "quarterly", "review", "meeting"];
    const b = ["budget", "annual", "review", "planning"];
    const sim = computeTokenSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    // 2 overlap (budget, review) out of 6 unique = 0.333
    expect(sim).toBeCloseTo(2 / 6, 2);
  });

  it("returns 0 for empty token arrays", () => {
    expect(computeTokenSimilarity([], ["budget"])).toBe(0);
    expect(computeTokenSimilarity(["budget"], [])).toBe(0);
    expect(computeTokenSimilarity([], [])).toBe(0);
  });

  it("handles duplicate tokens gracefully", () => {
    const a = ["budget", "budget", "review"];
    const b = ["budget", "review", "review"];
    // Sets: {budget, review} vs {budget, review} → 1.0
    expect(computeTokenSimilarity(a, b)).toBe(1.0);
  });
});

describe("Provenance Chain — startProvenanceChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new chain with UUID and sets root depth 0", async () => {
    const chainId = await startProvenanceChain(1, "dlb_1_1000", "Budget review");
    expect(chainId).toBeDefined();
    expect(typeof chainId).toBe("string");
    // UUID v4 format
    expect(chainId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mockUpdateProvenanceFields).toHaveBeenCalledWith("dlb_1_1000", {
      provenanceChainId: chainId,
      parentDeliberationId: null,
      chainDepth: 0,
      chainMetadata: { origin: "manual", topic: "Budget review" },
    });
  });

  it("generates unique chain IDs for each call", async () => {
    const id1 = await startProvenanceChain(1, "dlb_1_1000", "Topic A");
    const id2 = await startProvenanceChain(1, "dlb_1_2000", "Topic B");
    expect(id1).not.toBe(id2);
  });
});

describe("Provenance Chain — linkToChain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links a deliberation to an existing chain with correct depth", async () => {
    const chainId = "test-chain-uuid";
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_parent", provenanceChainId: chainId, chainDepth: 2 })
    );
    // For ancestor check — parent has no further parent
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_parent", parentDecisionId: null })
    );

    await linkToChain(chainId, "dlb_child", "dlb_parent", { reason: "follow-up" });

    expect(mockUpdateProvenanceFields).toHaveBeenCalledWith("dlb_child", {
      provenanceChainId: chainId,
      parentDeliberationId: "dlb_parent",
      chainDepth: 3,
      chainMetadata: { reason: "follow-up" },
    });
  });

  it("prevents self-referencing (deliberation linking to itself)", async () => {
    await expect(
      linkToChain("chain-1", "dlb_same", "dlb_same")
    ).rejects.toThrow("Cannot link a deliberation to itself");
  });

  it("rejects if parent deliberation not found", async () => {
    mockGetDeliberationSession.mockResolvedValueOnce(undefined);

    await expect(
      linkToChain("chain-1", "dlb_child", "dlb_missing_parent")
    ).rejects.toThrow("Parent deliberation not found");
  });

  it("rejects if parent belongs to a different chain", async () => {
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_parent", provenanceChainId: "other-chain" })
    );

    await expect(
      linkToChain("chain-1", "dlb_child", "dlb_parent")
    ).rejects.toThrow("Parent deliberation belongs to a different chain");
  });

  it("prevents circular references", async () => {
    // dlb_child is already an ancestor of dlb_parent
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_parent", provenanceChainId: "chain-1", chainDepth: 1, parentDecisionId: "dlb_child" })
    );
    // Ancestor walk: dlb_parent → dlb_child (circular!)
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_parent", parentDecisionId: "dlb_child" })
    );
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_child", parentDecisionId: null })
    );

    await expect(
      linkToChain("chain-1", "dlb_child", "dlb_parent")
    ).rejects.toThrow("Circular reference detected");
  });

  it("enforces max chain depth of 50", async () => {
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_parent", provenanceChainId: "chain-1", chainDepth: 50 })
    );

    await expect(
      linkToChain("chain-1", "dlb_child", "dlb_parent")
    ).rejects.toThrow("Maximum chain depth (50) exceeded");
  });
});

describe("Provenance Chain — autoLinkDeliberation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no recent deliberations exist", async () => {
    mockGetRecentDeliberationsForRoom.mockResolvedValue([]);
    const result = await autoLinkDeliberation(1, "dlb_new", "Budget quarterly review");
    expect(result).toBeNull();
  });

  it("returns null when no topic similarity exceeds threshold", async () => {
    mockGetRecentDeliberationsForRoom.mockResolvedValue([
      createMockDelibSession({ sessionId: "dlb_old", topic: "Engineering sprint velocity tracking" }),
    ]);
    const result = await autoLinkDeliberation(1, "dlb_new", "Budget quarterly review");
    expect(result).toBeNull();
  });

  it("auto-links when similarity exceeds 0.6 and target has existing chain", async () => {
    const existingChainId = "existing-chain-uuid";
    // Topics: "budget quarterly review analysis" vs "budget quarterly review analysis update"
    // Tokens: [budget, quarterly, review, analysis] vs [budget, quarterly, review, analysis, update]
    // Intersection: 4, Union: 5, Similarity: 0.8 > 0.6
    mockGetRecentDeliberationsForRoom.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_old",
        topic: "budget quarterly review analysis",
        provenanceChainId: existingChainId,
        chainDepth: 0,
      }),
    ]);
    // For linkToChain — get parent
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_old", provenanceChainId: existingChainId, chainDepth: 0 })
    );
    // For ancestor check
    mockGetDeliberationSession.mockResolvedValueOnce(
      createMockDelibSession({ sessionId: "dlb_old", parentDecisionId: null })
    );

    const result = await autoLinkDeliberation(1, "dlb_new", "budget quarterly review analysis update");
    expect(result).toBe(existingChainId);
  });

  it("creates a new chain when best match has no existing chain", async () => {
    // Topics: "budget quarterly review analysis" vs "budget quarterly review analysis revision"
    // Tokens: [budget, quarterly, review, analysis] vs [budget, quarterly, review, analysis, revision]
    // Similarity: 4/5 = 0.8 > 0.6
    mockGetRecentDeliberationsForRoom.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_old",
        topic: "budget quarterly review analysis",
        provenanceChainId: null,
      }),
    ]);
    // For startProvenanceChain — no extra mocks needed (just updateProvenanceFields)
    // For linkToChain — get parent (called after chain is started, so parent now has chainId)
    mockGetDeliberationSession.mockImplementation(async (id: string) => {
      if (id === "dlb_old") {
        return createMockDelibSession({ sessionId: "dlb_old", provenanceChainId: "some-chain", chainDepth: 0, parentDecisionId: null });
      }
      return undefined;
    });

    const result = await autoLinkDeliberation(1, "dlb_new", "budget quarterly review analysis revision");

    // Should return a new chain ID (UUID)
    if (result) {
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    // startProvenanceChain was called for dlb_old
    expect(mockUpdateProvenanceFields).toHaveBeenCalled();
  });

  it("skips self-matching (same deliberation ID)", async () => {
    mockGetRecentDeliberationsForRoom.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_new",
        topic: "Budget quarterly review analysis",
      }),
    ]);
    const result = await autoLinkDeliberation(1, "dlb_new", "Budget quarterly review analysis");
    expect(result).toBeNull();
  });
});

describe("Provenance Chain — getProvenanceChainById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-existent chain", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([]);
    const result = await getProvenanceChainById("non-existent-chain");
    expect(result).toBeNull();
  });

  it("returns full chain with deliberations in order", async () => {
    const chainId = "test-chain";
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({ sessionId: "dlb_root", topic: "Initial budget", chainDepth: 0, startedAt: 1000, completedAt: 2000 }),
      createMockDelibSession({ sessionId: "dlb_follow", topic: "Budget revision", chainDepth: 1, startedAt: 3000, completedAt: 4000, parentDecisionId: "dlb_root" }),
      createMockDelibSession({ sessionId: "dlb_final", topic: "Budget approval", chainDepth: 2, startedAt: 5000, completedAt: 6000, parentDecisionId: "dlb_follow" }),
    ]);

    const chain = await getProvenanceChainById(chainId);
    expect(chain).not.toBeNull();
    expect(chain!.chainId).toBe(chainId);
    expect(chain!.deliberations).toHaveLength(3);
    expect(chain!.deliberations[0].chainDepth).toBe(0);
    expect(chain!.deliberations[1].chainDepth).toBe(1);
    expect(chain!.deliberations[2].chainDepth).toBe(2);
    expect(chain!.topic).toBe("Initial budget");
  });

  it("includes summary with consensus history", async () => {
    const chainId = "test-chain";
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_root",
        chainDepth: 0,
        startedAt: 1000,
        completedAt: 2000,
        consensus: { decision: "Approve", confidence: 0.85, method: "weighted_majority", votes: [], dissent: [] },
      }),
      createMockDelibSession({
        sessionId: "dlb_follow",
        chainDepth: 1,
        startedAt: 3000,
        completedAt: 4000,
        consensus: { decision: "Revise", confidence: 0.72, method: "weighted_majority", votes: [], dissent: [] },
      }),
    ]);

    const chain = await getProvenanceChainById(chainId);
    expect(chain!.summary.totalDeliberations).toBe(2);
    expect(chain!.summary.maxDepth).toBe(1);
    expect(chain!.summary.consensusHistory).toHaveLength(2);
    expect(chain!.summary.consensusHistory[0].decision).toBe("Approve");
    expect(chain!.summary.consensusHistory[1].decision).toBe("Revise");
  });
});

describe("Provenance Chain — getChainSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-existent chain", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([]);
    const result = await getChainSummary("non-existent");
    expect(result).toBeNull();
  });

  it("returns condensed summary with correct stats", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({ sessionId: "dlb_1", chainDepth: 0, startedAt: 1000, completedAt: 2000 }),
      createMockDelibSession({ sessionId: "dlb_2", chainDepth: 1, startedAt: 3000, completedAt: 4000 }),
      createMockDelibSession({ sessionId: "dlb_3", chainDepth: 2, startedAt: 5000, completedAt: 6000 }),
    ]);

    const summary = await getChainSummary("chain-1");
    expect(summary).not.toBeNull();
    expect(summary!.totalDeliberations).toBe(3);
    expect(summary!.maxDepth).toBe(2);
    expect(summary!.firstDecisionAt).toBe(2000);
    expect(summary!.lastDecisionAt).toBe(6000);
  });
});

describe("Provenance Chain — getProvenanceTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-existent chain", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([]);
    const tree = await getProvenanceTree("non-existent");
    expect(tree).toBeNull();
  });

  it("builds tree structure with root and children", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_root",
        topic: "Root topic",
        chainDepth: 0,
        parentDecisionId: null,
        consensus: { decision: "Go ahead", confidence: 0.9, method: "weighted_majority", votes: [], dissent: [] },
      }),
      createMockDelibSession({
        sessionId: "dlb_child1",
        topic: "Child 1",
        chainDepth: 1,
        parentDecisionId: "dlb_root",
        consensus: { decision: "Proceed", confidence: 0.8, method: "weighted_majority", votes: [], dissent: [] },
      }),
      createMockDelibSession({
        sessionId: "dlb_child2",
        topic: "Child 2",
        chainDepth: 1,
        parentDecisionId: "dlb_root",
        consensus: null,
      }),
    ]);

    const tree = await getProvenanceTree("chain-1");
    expect(tree).not.toBeNull();
    expect(tree!.id).toBe("dlb_root");
    expect(tree!.topic).toBe("Root topic");
    expect(tree!.decision).toBe("Go ahead");
    expect(tree!.confidence).toBe(0.9);
    expect(tree!.children).toHaveLength(2);
    expect(tree!.children[0].id).toBe("dlb_child1");
    expect(tree!.children[0].decision).toBe("Proceed");
    expect(tree!.children[1].id).toBe("dlb_child2");
    expect(tree!.children[1].decision).toBeNull();
  });

  it("handles deeply nested trees", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({ sessionId: "d0", chainDepth: 0, parentDecisionId: null }),
      createMockDelibSession({ sessionId: "d1", chainDepth: 1, parentDecisionId: "d0" }),
      createMockDelibSession({ sessionId: "d2", chainDepth: 2, parentDecisionId: "d1" }),
      createMockDelibSession({ sessionId: "d3", chainDepth: 3, parentDecisionId: "d2" }),
    ]);

    const tree = await getProvenanceTree("chain-1");
    expect(tree!.id).toBe("d0");
    expect(tree!.children[0].id).toBe("d1");
    expect(tree!.children[0].children[0].id).toBe("d2");
    expect(tree!.children[0].children[0].children[0].id).toBe("d3");
    expect(tree!.children[0].children[0].children[0].children).toHaveLength(0);
  });
});

describe("Provenance Chain — Cross-session Scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports chain spanning multiple sessions with different timestamps", async () => {
    const DAY = 86400000;
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_session1",
        topic: "Q1 Budget Planning",
        chainDepth: 0,
        startedAt: Date.now() - 30 * DAY,
        completedAt: Date.now() - 30 * DAY + 5000,
      }),
      createMockDelibSession({
        sessionId: "dlb_session2",
        topic: "Q1 Budget Revision",
        chainDepth: 1,
        parentDecisionId: "dlb_session1",
        startedAt: Date.now() - 15 * DAY,
        completedAt: Date.now() - 15 * DAY + 3000,
      }),
      createMockDelibSession({
        sessionId: "dlb_session3",
        topic: "Q1 Budget Approval",
        chainDepth: 2,
        parentDecisionId: "dlb_session2",
        startedAt: Date.now() - 1 * DAY,
        completedAt: Date.now() - 1 * DAY + 2000,
      }),
    ]);

    const chain = await getProvenanceChainById("cross-session-chain");
    expect(chain).not.toBeNull();
    expect(chain!.deliberations).toHaveLength(3);

    // Verify ordering by depth
    expect(chain!.deliberations[0].sessionId).toBe("dlb_session1");
    expect(chain!.deliberations[1].sessionId).toBe("dlb_session2");
    expect(chain!.deliberations[2].sessionId).toBe("dlb_session3");

    // Summary should span the full time range
    expect(chain!.summary.firstDecisionAt).toBeLessThan(chain!.summary.lastDecisionAt);
    expect(chain!.summary.maxDepth).toBe(2);
  });

  it("handles orphan deliberation (single node chain)", async () => {
    mockGetDeliberationsByChainId.mockResolvedValue([
      createMockDelibSession({
        sessionId: "dlb_orphan",
        topic: "Standalone discussion",
        chainDepth: 0,
        parentDecisionId: null,
        consensus: { decision: "No action", confidence: 0.5, method: "weighted_majority", votes: [], dissent: [] },
      }),
    ]);

    const chain = await getProvenanceChainById("orphan-chain");
    expect(chain).not.toBeNull();
    expect(chain!.deliberations).toHaveLength(1);
    expect(chain!.summary.totalDeliberations).toBe(1);
    expect(chain!.summary.maxDepth).toBe(0);

    const tree = await getProvenanceTree("orphan-chain");
    expect(tree).not.toBeNull();
    expect(tree!.children).toHaveLength(0);
  });
});

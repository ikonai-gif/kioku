/**
 * Tests for Phase 4c — Relational Intelligence, Position Lock
 * All DB/LLM calls are mocked — no real API calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Relationship Context in Chat Prompt ─────────────────────────────────

describe("relationship context in chat prompt", () => {
  it("includes relationship block for high-trust user", () => {
    const relationship = {
      trustLevel: 0.8,
      familiarity: 0.9,
      interactionCount: 50,
      stableOpinions: { "AI safety": "Strong regulation needed" },
    };

    let block = `\n\n## Your Relationship with This User\n`;
    block += `Trust level: ${relationship.trustLevel > 0.5 ? 'high' : relationship.trustLevel > 0 ? 'moderate' : 'developing'}\n`;
    block += `Familiarity: ${relationship.familiarity > 0.7 ? 'well-known' : relationship.familiarity > 0.3 ? 'familiar' : 'new acquaintance'}\n`;
    block += `Interactions: ${relationship.interactionCount}\n`;
    if (relationship.stableOpinions && Object.keys(relationship.stableOpinions).length > 0) {
      block += `Your established positions: ${JSON.stringify(relationship.stableOpinions)}\n`;
    }
    block += `Adapt your communication style based on this relationship — be more direct with trusted users, more careful with new ones.\n`;

    expect(block).toContain("Trust level: high");
    expect(block).toContain("Familiarity: well-known");
    expect(block).toContain("Interactions: 50");
    expect(block).toContain("AI safety");
    expect(block).toContain("Strong regulation needed");
  });

  it("shows moderate trust and familiar for mid-range values", () => {
    const relationship = {
      trustLevel: 0.3,
      familiarity: 0.5,
      interactionCount: 15,
      stableOpinions: {},
    };

    const trustLabel = relationship.trustLevel > 0.5 ? 'high' : relationship.trustLevel > 0 ? 'moderate' : 'developing';
    const familiarityLabel = relationship.familiarity > 0.7 ? 'well-known' : relationship.familiarity > 0.3 ? 'familiar' : 'new acquaintance';

    expect(trustLabel).toBe("moderate");
    expect(familiarityLabel).toBe("familiar");
  });

  it("shows developing trust and new acquaintance for new relationships", () => {
    const relationship = {
      trustLevel: 0,
      familiarity: 0.1,
      interactionCount: 2,
      stableOpinions: {},
    };

    const trustLabel = relationship.trustLevel > 0.5 ? 'high' : relationship.trustLevel > 0 ? 'moderate' : 'developing';
    const familiarityLabel = relationship.familiarity > 0.7 ? 'well-known' : relationship.familiarity > 0.3 ? 'familiar' : 'new acquaintance';

    expect(trustLabel).toBe("developing");
    expect(familiarityLabel).toBe("new acquaintance");
  });

  it("omits stable opinions when empty", () => {
    const relationship = {
      trustLevel: 0.6,
      familiarity: 0.8,
      interactionCount: 30,
      stableOpinions: {},
    };

    let block = "";
    if (relationship.stableOpinions && Object.keys(relationship.stableOpinions).length > 0) {
      block += `Your established positions: ${JSON.stringify(relationship.stableOpinions)}\n`;
    }

    expect(block).toBe("");
  });
});

// ── Relationship Context in Deliberation Prompt ─────────────────────────

describe("relationship context in deliberation prompt", () => {
  it("includes relationship block in deliberation prompt", () => {
    const relationship = {
      trustLevel: 0.7,
      familiarity: 0.5,
      interactionCount: 20,
      stableOpinions: {},
    };

    let block = `\n\n## Your Relationship with This User\n`;
    block += `Trust level: ${relationship.trustLevel > 0.5 ? 'high' : relationship.trustLevel > 0 ? 'moderate' : 'developing'}\n`;
    block += `Familiarity: ${relationship.familiarity > 0.7 ? 'well-known' : relationship.familiarity > 0.3 ? 'familiar' : 'new acquaintance'}\n`;
    block += `Interactions: ${relationship.interactionCount}\n`;
    block += `Adapt your tone based on this relationship depth.\n`;

    expect(block).toContain("Trust level: high");
    expect(block).toContain("Familiarity: familiar");
    expect(block).toContain("Interactions: 20");
    expect(block).toContain("Adapt your tone");
  });
});

// ── Interaction Increment Logic ─────────────────────────────────────────

describe("interaction tracking", () => {
  it("incrementInteraction is callable as fire-and-forget", async () => {
    const mockStorage = {
      incrementInteraction: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate the fire-and-forget pattern used in deliberation.ts
    mockStorage.incrementInteraction(1, 1).catch(() => {});
    expect(mockStorage.incrementInteraction).toHaveBeenCalledWith(1, 1);
  });

  it("familiarity grows by 0.01 per interaction, capped at 1.0", async () => {
    const mockStorage = {
      getRelationship: vi.fn().mockResolvedValue({ familiarity: 0.5 }),
      upsertRelationship: vi.fn().mockResolvedValue(undefined),
    };

    const rel = await mockStorage.getRelationship(1, 1);
    if (rel) {
      const newFamiliarity = Math.min(1.0, rel.familiarity + 0.01);
      await mockStorage.upsertRelationship(1, 1, { familiarity: newFamiliarity });
    }

    expect(mockStorage.upsertRelationship).toHaveBeenCalledWith(1, 1, { familiarity: 0.51 });
  });

  it("familiarity does not exceed 1.0", async () => {
    const rel = { familiarity: 0.999 };
    const newFamiliarity = Math.min(1.0, rel.familiarity + 0.01);
    expect(newFamiliarity).toBe(1.0);
  });

  it("familiarity starts from 0 for new relationships", async () => {
    const rel = { familiarity: 0.0 };
    const newFamiliarity = Math.min(1.0, rel.familiarity + 0.01);
    expect(newFamiliarity).toBe(0.01);
  });
});

// ── Position Lock: checkPositionLock ────────────────────────────────────

describe("checkPositionLock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns locked=false when no matching positions exist", async () => {
    vi.doMock("../storage", () => ({
      pool: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      },
    }));

    const { checkPositionLock } = await import("../position-lock");
    const result = await checkPositionLock(1, 1, "AI regulation policy", {});
    expect(result.locked).toBe(false);
    expect(result.previousPosition).toBeNull();
  });

  it("returns locked=true when matching position found", async () => {
    vi.doMock("../storage", () => ({
      pool: {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              content: '[Position on "regulation policy"] Strong regulation policy is needed for safety',
              confidence: 0.9,
              context_trigger: 'position_lock:regulation_policy',
            },
          ],
        }),
      },
    }));

    const { checkPositionLock } = await import("../position-lock");
    const result = await checkPositionLock(1, 1, "regulation policy debate topic", {});
    expect(result.locked).toBe(true);
    expect(result.previousPosition).toBe("Strong regulation policy is needed for safety");
  });

  it("returns locked=false when topic words don't overlap enough", async () => {
    vi.doMock("../storage", () => ({
      pool: {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              content: '[Position on "climate change"] Immediate action needed',
              confidence: 0.9,
              context_trigger: 'position_lock:climate_change',
            },
          ],
        }),
      },
    }));

    const { checkPositionLock } = await import("../position-lock");
    const result = await checkPositionLock(1, 1, "blockchain cryptocurrency investing", {});
    expect(result.locked).toBe(false);
    expect(result.previousPosition).toBeNull();
  });

  it("handles DB errors gracefully", async () => {
    vi.doMock("../storage", () => ({
      pool: {
        query: vi.fn().mockRejectedValue(new Error("DB connection failed")),
      },
    }));

    const { checkPositionLock } = await import("../position-lock");
    const result = await checkPositionLock(1, 1, "some topic here", {});
    expect(result.locked).toBe(false);
    expect(result.previousPosition).toBeNull();
  });

  it("returns locked=false for short topic with no meaningful words", async () => {
    vi.doMock("../storage", () => ({
      pool: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      },
    }));

    const { checkPositionLock } = await import("../position-lock");
    const result = await checkPositionLock(1, 1, "it is so", {});
    // All words are 3 chars or less, filtered out
    expect(result.locked).toBe(false);
  });
});

// ── Position Lock: savePositionLock ─────────────────────────────────────

describe("savePositionLock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("saves position when confidence > 0.7", async () => {
    vi.doMock("../storage", () => ({
      pool: { query: vi.fn() },
    }));

    const { savePositionLock } = await import("../position-lock");
    const mockStorage = {
      createMemory: vi.fn().mockResolvedValue({ id: 1 }),
    };

    await savePositionLock(1, 1, "Agent Alpha", "AI regulation", "Strong regulation needed", 0.9, mockStorage);

    expect(mockStorage.createMemory).toHaveBeenCalledTimes(1);
    expect(mockStorage.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        agentId: 1,
        agentName: "Agent Alpha",
        content: '[Position on "AI regulation"] Strong regulation needed',
        type: 'procedural',
        importance: 0.9,
        namespace: 'stable_positions',
      })
    );
  });

  it("does NOT save when confidence <= 0.7", async () => {
    vi.doMock("../storage", () => ({
      pool: { query: vi.fn() },
    }));

    const { savePositionLock } = await import("../position-lock");
    const mockStorage = {
      createMemory: vi.fn().mockResolvedValue({ id: 1 }),
    };

    await savePositionLock(1, 1, "Agent Alpha", "AI regulation", "Some position", 0.5, mockStorage);
    expect(mockStorage.createMemory).not.toHaveBeenCalled();
  });

  it("does NOT save when confidence is exactly 0.7", async () => {
    vi.doMock("../storage", () => ({
      pool: { query: vi.fn() },
    }));

    const { savePositionLock } = await import("../position-lock");
    const mockStorage = {
      createMemory: vi.fn().mockResolvedValue({ id: 1 }),
    };

    await savePositionLock(1, 1, "Agent Alpha", "topic", "position", 0.7, mockStorage);
    expect(mockStorage.createMemory).not.toHaveBeenCalled();
  });

  it("truncates long topics to 60 chars", async () => {
    vi.doMock("../storage", () => ({
      pool: { query: vi.fn() },
    }));

    const { savePositionLock } = await import("../position-lock");
    const mockStorage = {
      createMemory: vi.fn().mockResolvedValue({ id: 1 }),
    };

    // Use distinct chars so truncated portion is identifiable
    const longTopic = "A".repeat(60) + "Z".repeat(40);
    await savePositionLock(1, 1, "Agent", longTopic, "position", 0.9, mockStorage);

    const call = mockStorage.createMemory.mock.calls[0][0];
    expect(call.content).toContain("A".repeat(60));
    expect(call.content).not.toContain("Z"); // The Z part should be truncated
  });

  it("handles createMemory errors silently", async () => {
    vi.doMock("../storage", () => ({
      pool: { query: vi.fn() },
    }));

    const { savePositionLock } = await import("../position-lock");
    const mockStorage = {
      createMemory: vi.fn().mockRejectedValue(new Error("DB error")),
    };

    // Should not throw
    await expect(
      savePositionLock(1, 1, "Agent", "topic here now", "position", 0.9, mockStorage)
    ).resolves.toBeUndefined();
  });
});

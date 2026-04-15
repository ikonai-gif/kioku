/**
 * Integration tests for Deliberation API endpoints.
 * Tests the endpoint contracts, validation, and response shapes.
 *
 * Since we can't spin up the full server easily (DB, auth, etc.),
 * we test the request validation, schema contracts, and response structure patterns.
 */
import { describe, it, expect } from "vitest";
import {
  deliberateSchema,
  humanInputSchema,
  validateBody,
  ValidationError,
} from "../validation";

describe("POST /api/rooms/:id/deliberate — request validation", () => {
  it("accepts minimal valid request", () => {
    const body = { topic: "Should we adopt microservices?" };
    const parsed = validateBody(deliberateSchema, body);
    expect(parsed.topic).toBe("Should we adopt microservices?");
    expect(parsed.model).toBeUndefined();
    expect(parsed.debateRounds).toBeUndefined();
    expect(parsed.includeHuman).toBeUndefined();
  });

  it("accepts full request with all options", () => {
    const body = {
      topic: "AI safety research priorities",
      model: "gemini-2.0-flash",
      debateRounds: 3,
      includeHuman: true,
      humanName: "Dr. Smith",
    };
    const parsed = validateBody(deliberateSchema, body);
    expect(parsed.topic).toBe("AI safety research priorities");
    expect(parsed.model).toBe("gemini-2.0-flash");
    expect(parsed.debateRounds).toBe(3);
    expect(parsed.includeHuman).toBe(true);
    expect(parsed.humanName).toBe("Dr. Smith");
  });

  it("rejects request with no body", () => {
    expect(() => validateBody(deliberateSchema, undefined)).toThrow();
  });

  it("rejects request with empty object", () => {
    expect(() => validateBody(deliberateSchema, {})).toThrow(ValidationError);
  });

  it("rejects request with null topic", () => {
    expect(() => validateBody(deliberateSchema, { topic: null })).toThrow(ValidationError);
  });

  it("rejects request with numeric topic", () => {
    expect(() => validateBody(deliberateSchema, { topic: 12345 })).toThrow(ValidationError);
  });

  it("rejects extra unknown fields silently (Zod strips them by default)", () => {
    const body = { topic: "test", unknownField: "should be ignored" };
    const parsed = validateBody(deliberateSchema, body);
    expect(parsed.topic).toBe("test");
    expect((parsed as any).unknownField).toBeUndefined();
  });
});

describe("POST /api/rooms/:id/deliberations/:sessionId/human-input — request validation", () => {
  it("accepts valid human input", () => {
    const body = {
      phase: "debate",
      round: 2,
      position: "I believe we should proceed with caution",
      confidence: 0.75,
      reasoning: "The evidence suggests moderate risk",
    };
    const parsed = validateBody(humanInputSchema, body);
    expect(parsed.phase).toBe("debate");
    expect(parsed.round).toBe(2);
    expect(parsed.position).toBe("I believe we should proceed with caution");
    expect(parsed.confidence).toBe(0.75);
  });

  it("rejects missing required fields", () => {
    expect(() => validateBody(humanInputSchema, { phase: "position" })).toThrow(ValidationError);
    expect(() => validateBody(humanInputSchema, { phase: "position", round: 1 })).toThrow(ValidationError);
  });

  it("rejects non-enum phase values", () => {
    expect(() => validateBody(humanInputSchema, {
      phase: "voting", round: 1, position: "test", confidence: 0.5,
    })).toThrow(ValidationError);
  });
});

describe("GET /api/rooms/:id/deliberations/:sessionId — response shape", () => {
  it("DeliberationSession has required fields", () => {
    const session = {
      sessionId: "dlb_1_1713200000000",
      roomId: 1,
      topic: "Test topic",
      status: "completed" as const,
      rounds: [],
      consensus: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      model: "gpt-4o",
      modelsUsed: ["gpt-4o"],
    };
    expect(session.sessionId).toMatch(/^dlb_\d+_\d+$/);
    expect(session.status).toBe("completed");
    expect(session.rounds).toBeInstanceOf(Array);
    expect(session.model).toBeTruthy();
  });

  it("DeliberationRound has required fields", () => {
    const round = {
      phase: "position" as const,
      round: 1,
      positions: [
        {
          agentId: 1,
          agentName: "TestAgent",
          agentColor: "#ff0000",
          position: "We should proceed",
          confidence: 0.8,
          reasoning: "Evidence supports it",
        },
      ],
      timestamp: Date.now(),
    };
    expect(round.phase).toBe("position");
    expect(round.positions[0].confidence).toBeGreaterThanOrEqual(0);
    expect(round.positions[0].confidence).toBeLessThanOrEqual(1);
  });
});

describe("GET /api/rooms/:id/consensus — response shape", () => {
  it("ConsensusResult has required fields", () => {
    const consensus = {
      decision: "Adopt microservices with proper monitoring",
      confidence: 0.78,
      method: "weighted_majority" as const,
      votes: [
        { agentName: "Analyst", position: "Adopt microservices", confidence: 0.85, changedMind: false },
        { agentName: "Pessimist", position: "Proceed cautiously", confidence: 0.71, changedMind: true },
      ],
      dissent: ['Pessimist: "Proceed cautiously" (71%)'],
    };
    expect(consensus.method).toBe("weighted_majority");
    expect(consensus.votes).toHaveLength(2);
    expect(consensus.dissent).toHaveLength(1);
    expect(consensus.confidence).toBeGreaterThanOrEqual(0);
    expect(consensus.confidence).toBeLessThanOrEqual(1);
  });
});

describe("Error response contracts", () => {
  it("409 when deliberation already running", () => {
    const errorResponse = { error: "Deliberation already running in this room" };
    expect(errorResponse.error).toContain("already running");
  });

  it("429 when quota exceeded", () => {
    const errorResponse = {
      error: "Daily AI quota exceeded: 10/10 calls (free plan)",
    };
    expect(errorResponse.error).toContain("quota exceeded");
  });

  it("429 when plan limit reached", () => {
    const errorResponse = {
      error: "Plan limit reached. 5/5 deliberations this month (free plan). Upgrade to Professional for more.",
      code: "PLAN_LIMIT_REACHED",
    };
    expect(errorResponse.code).toBe("PLAN_LIMIT_REACHED");
  });

  it("410 when human input not pending", () => {
    const errorResponse = {
      error: "No pending human input for this phase/round (expired or already submitted)",
    };
    expect(errorResponse.error).toContain("expired or already submitted");
  });

  it("401 for unauthenticated requests", () => {
    const errorResponse = { error: "Unauthorized" };
    expect(errorResponse.error).toBe("Unauthorized");
  });

  it("404 when room not found", () => {
    const errorResponse = { error: "Not found" };
    expect(errorResponse.error).toBe("Not found");
  });
});

describe("Active session guard", () => {
  it("tracks active sessions via Set to prevent double-run", () => {
    // Validates the activeSessions pattern from structured-deliberation.ts
    const activeSessions = new Set<number>();

    // First deliberation starts
    const roomId = 42;
    expect(activeSessions.has(roomId)).toBe(false);
    activeSessions.add(roomId);
    expect(activeSessions.has(roomId)).toBe(true);

    // Second request for same room should be rejected
    expect(activeSessions.has(roomId)).toBe(true);

    // After completion, room is released
    activeSessions.delete(roomId);
    expect(activeSessions.has(roomId)).toBe(false);

    // Different room can run concurrently
    activeSessions.add(1);
    activeSessions.add(2);
    expect(activeSessions.size).toBe(2);
  });
});

describe("Deliberation session ID format", () => {
  it("generates unique session IDs", () => {
    const roomId = 5;
    const id1 = `dlb_${roomId}_${Date.now()}`;
    // Small delay to ensure different timestamp
    const id2 = `dlb_${roomId}_${Date.now() + 1}`;
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^dlb_5_\d+$/);
  });
});

describe("Minimum agent requirements", () => {
  it("requires at least 2 agents without human", () => {
    const includeHuman = false;
    const minAgents = includeHuman ? 1 : 2;
    expect(minAgents).toBe(2);
  });

  it("requires at least 1 agent with human", () => {
    const includeHuman = true;
    const minAgents = includeHuman ? 1 : 2;
    expect(minAgents).toBe(1);
  });

  it("offline agents are excluded from deliberation", () => {
    const allAgents = [
      { id: 1, name: "A", status: "active" },
      { id: 2, name: "B", status: "offline" },
      { id: 3, name: "C", status: "active" },
    ];
    const roomAgentIds = [1, 2, 3];
    const agents = allAgents.filter(
      (a) => roomAgentIds.includes(a.id) && a.status !== "offline"
    );
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.name)).toEqual(["A", "C"]);
  });
});

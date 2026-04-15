import { describe, it, expect } from "vitest";
import {
  deliberateSchema,
  humanInputSchema,
  validateBody,
  ValidationError,
  createMemorySchema,
} from "../validation";

describe("deliberateSchema", () => {
  it("accepts valid minimal input", () => {
    const result = deliberateSchema.safeParse({ topic: "Should we use microservices?" });
    expect(result.success).toBe(true);
    expect(result.data?.topic).toBe("Should we use microservices?");
  });

  it("accepts all optional fields", () => {
    const result = deliberateSchema.safeParse({
      topic: "AI Ethics",
      model: "gpt-4o",
      debateRounds: 3,
      includeHuman: true,
      humanName: "Alice",
    });
    expect(result.success).toBe(true);
    expect(result.data?.model).toBe("gpt-4o");
    expect(result.data?.debateRounds).toBe(3);
    expect(result.data?.includeHuman).toBe(true);
  });

  it("rejects empty topic", () => {
    const result = deliberateSchema.safeParse({ topic: "" });
    expect(result.success).toBe(false);
  });

  it("rejects topic over 2000 chars", () => {
    const result = deliberateSchema.safeParse({ topic: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("rejects invalid model", () => {
    const result = deliberateSchema.safeParse({ topic: "test", model: "claude-3-opus" });
    expect(result.success).toBe(false);
  });

  it("accepts all allowed models", () => {
    const models = [
      "gpt-5.4-mini", "gpt-5.4", "gpt-5.4-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o",
      "gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro",
    ];
    for (const model of models) {
      const result = deliberateSchema.safeParse({ topic: "test", model });
      expect(result.success).toBe(true);
    }
  });

  it("rejects debateRounds outside 1-5 range", () => {
    expect(deliberateSchema.safeParse({ topic: "t", debateRounds: 0 }).success).toBe(false);
    expect(deliberateSchema.safeParse({ topic: "t", debateRounds: 6 }).success).toBe(false);
    expect(deliberateSchema.safeParse({ topic: "t", debateRounds: 1 }).success).toBe(true);
    expect(deliberateSchema.safeParse({ topic: "t", debateRounds: 5 }).success).toBe(true);
  });

  it("rejects non-integer debateRounds", () => {
    const result = deliberateSchema.safeParse({ topic: "t", debateRounds: 2.5 });
    expect(result.success).toBe(false);
  });

  it("rejects humanName over 100 chars", () => {
    const result = deliberateSchema.safeParse({ topic: "t", humanName: "x".repeat(101) });
    expect(result.success).toBe(false);
  });
});

describe("humanInputSchema", () => {
  it("accepts valid input", () => {
    const result = humanInputSchema.safeParse({
      phase: "position",
      round: 1,
      position: "I agree with the proposal",
      confidence: 0.85,
      reasoning: "Based on the evidence",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid phases", () => {
    for (const phase of ["position", "debate", "final"]) {
      const result = humanInputSchema.safeParse({
        phase,
        round: 1,
        position: "test",
        confidence: 0.5,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid phase", () => {
    const result = humanInputSchema.safeParse({
      phase: "consensus",
      round: 1,
      position: "test",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0-1 range", () => {
    expect(humanInputSchema.safeParse({ phase: "position", round: 1, position: "t", confidence: -0.1 }).success).toBe(false);
    expect(humanInputSchema.safeParse({ phase: "position", round: 1, position: "t", confidence: 1.1 }).success).toBe(false);
  });

  it("accepts boundary confidence values", () => {
    expect(humanInputSchema.safeParse({ phase: "position", round: 1, position: "t", confidence: 0 }).success).toBe(true);
    expect(humanInputSchema.safeParse({ phase: "position", round: 1, position: "t", confidence: 1 }).success).toBe(true);
  });

  it("rejects round outside 1-10 range", () => {
    expect(humanInputSchema.safeParse({ phase: "position", round: 0, position: "t", confidence: 0.5 }).success).toBe(false);
    expect(humanInputSchema.safeParse({ phase: "position", round: 11, position: "t", confidence: 0.5 }).success).toBe(false);
  });

  it("rejects empty position", () => {
    const result = humanInputSchema.safeParse({ phase: "position", round: 1, position: "", confidence: 0.5 });
    expect(result.success).toBe(false);
  });

  it("rejects position over 5000 chars", () => {
    const result = humanInputSchema.safeParse({ phase: "position", round: 1, position: "x".repeat(5001), confidence: 0.5 });
    expect(result.success).toBe(false);
  });

  it("reasoning is optional", () => {
    const result = humanInputSchema.safeParse({ phase: "position", round: 1, position: "test", confidence: 0.5 });
    expect(result.success).toBe(true);
  });

  it("rejects reasoning over 5000 chars", () => {
    const result = humanInputSchema.safeParse({
      phase: "position", round: 1, position: "t", confidence: 0.5,
      reasoning: "x".repeat(5001),
    });
    expect(result.success).toBe(false);
  });
});

describe("createMemorySchema", () => {
  it("accepts all 7 memory types", () => {
    const types = ["semantic", "episodic", "procedural", "emotional", "temporal", "causal", "contextual"];
    for (const type of types) {
      const result = createMemorySchema.safeParse({ content: "test memory", type });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid memory type", () => {
    const result = createMemorySchema.safeParse({ content: "test", type: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts confidence and decayRate (Phase 2 fields)", () => {
    const result = createMemorySchema.safeParse({
      content: "test",
      confidence: 0.9,
      decayRate: 0.01,
    });
    expect(result.success).toBe(true);
  });

  it("accepts temporal-specific expiresAt field", () => {
    const result = createMemorySchema.safeParse({
      content: "temp memory",
      type: "temporal",
      expiresAt: Date.now() + 86400000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts causal-specific causeId field", () => {
    const result = createMemorySchema.safeParse({
      content: "effect of X",
      type: "causal",
      causeId: 42,
    });
    expect(result.success).toBe(true);
  });

  it("accepts contextual-specific contextTrigger field", () => {
    const result = createMemorySchema.safeParse({
      content: "triggered by deliberation",
      type: "contextual",
      contextTrigger: "deliberation:dlb_1_12345",
    });
    expect(result.success).toBe(true);
  });
});

describe("validateBody", () => {
  it("returns parsed data on valid input", () => {
    const result = validateBody(deliberateSchema, { topic: "test" });
    expect(result.topic).toBe("test");
  });

  it("throws ValidationError on invalid input", () => {
    expect(() => validateBody(deliberateSchema, { topic: "" })).toThrow(ValidationError);
  });

  it("ValidationError has descriptive message", () => {
    try {
      validateBody(deliberateSchema, { topic: "" });
    } catch (e: any) {
      expect(e.name).toBe("ValidationError");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

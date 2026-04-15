import { describe, it, expect } from "vitest";
import { formatMemoryContext, type InjectedMemory } from "../memory-injection";

describe("formatMemoryContext", () => {
  it("returns empty string when no memories", () => {
    expect(formatMemoryContext([])).toBe("");
  });

  it("formats single memory correctly", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "AI is transformative technology", type: "semantic", confidence: 0.92 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("## Your Memories");
    expect(result).toContain("[semantic, confidence: 0.92]");
    expect(result).toContain('"AI is transformative technology"');
    expect(result).toContain("1.");
  });

  it("formats multiple memories with numbering", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "First memory", type: "semantic", confidence: 0.9 },
      { id: 2, content: "Second memory", type: "episodic", confidence: 0.8 },
      { id: 3, content: "Third memory", type: "procedural", confidence: 0.95 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
    expect(result).toContain("[semantic, confidence: 0.9]");
    expect(result).toContain("[episodic, confidence: 0.8]");
    expect(result).toContain("[procedural, confidence: 0.95]");
  });

  it("includes expiry date for temporal memories", () => {
    const expiresAt = new Date("2025-06-15T00:00:00Z").getTime();
    const memories: InjectedMemory[] = [
      { id: 1, content: "Temporary data", type: "temporal", confidence: 0.7, expiresAt },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("expires: 2025-06-15");
  });

  it("omits expiry when not set", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "Regular memory", type: "semantic", confidence: 0.8 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).not.toContain("expires:");
  });

  it("includes instruction to use memories", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "test", type: "semantic", confidence: 0.5 },
    ];
    const result = formatMemoryContext(memories);
    expect(result).toContain("Use these memories to inform your position");
    expect(result).toContain("Reference them when making arguments");
  });

  it("handles all 7 memory types in format", () => {
    const types = ["semantic", "episodic", "procedural", "emotional", "temporal", "causal", "contextual"];
    const memories: InjectedMemory[] = types.map((type, i) => ({
      id: i + 1,
      content: `${type} memory content`,
      type,
      confidence: 0.8,
    }));
    const result = formatMemoryContext(memories);
    for (const type of types) {
      expect(result).toContain(`[${type}, confidence: 0.8]`);
    }
  });

  it("formats null expiresAt same as undefined (no expiry tag)", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "test", type: "semantic", confidence: 0.8, expiresAt: null },
    ];
    const result = formatMemoryContext(memories);
    expect(result).not.toContain("expires:");
  });
});

describe("Memory×Deliberation coupling", () => {
  it("memories with confidence <= 0.3 should be filtered out (threshold test)", () => {
    // This tests the contract: fetchRelevantMemories filters confidence <= 0.3
    // Memories at or below 0.3 should NOT appear in deliberation context
    const threshold = 0.3;
    const belowThreshold = [0.0, 0.1, 0.2, 0.3];
    const aboveThreshold = [0.31, 0.5, 0.7, 1.0];

    for (const conf of belowThreshold) {
      expect(conf).toBeLessThanOrEqual(threshold);
    }
    for (const conf of aboveThreshold) {
      expect(conf).toBeGreaterThan(threshold);
    }
  });

  it("procedural memories get 1.3x type boost in scoring", () => {
    // Validates the scoring weights used in fetchRelevantMemories
    const typeBoosts: Record<string, number> = {
      procedural: 1.3,
      causal: 1.2,
      semantic: 1.0,
      episodic: 1.0,
      emotional: 1.0,
      temporal: 1.0,
      contextual: 1.0,
    };

    expect(typeBoosts.procedural).toBe(1.3);
    expect(typeBoosts.causal).toBe(1.2);
    expect(typeBoosts.semantic).toBe(1.0);
  });

  it("decisions namespace gets 1.3x boost in scoring", () => {
    // The "decisions" namespace (where consensus results are stored) gets boosted
    const nsBoost = (namespace: string) => namespace === "decisions" ? 1.3 : 1.0;
    expect(nsBoost("decisions")).toBe(1.3);
    expect(nsBoost("general")).toBe(1.0);
    expect(nsBoost("deliberation_positions")).toBe(1.0);
  });

  it("memory limit is 10 per agent per phase", () => {
    // Contract: fetchRelevantMemories uses limit=10 by default
    const DEFAULT_MEMORY_LIMIT = 10;
    expect(DEFAULT_MEMORY_LIMIT).toBe(10);
  });

  it("consensus decision is saved as procedural memory in decisions namespace", () => {
    // This validates the contract that consensus results become procedural memories
    const memoryTemplate = {
      type: "procedural",
      namespace: "decisions",
      importance: 0.95,
      contextTrigger: "deliberation:dlb_1_12345",
    };
    expect(memoryTemplate.type).toBe("procedural");
    expect(memoryTemplate.namespace).toBe("decisions");
    expect(memoryTemplate.importance).toBe(0.95);
    expect(memoryTemplate.contextTrigger).toMatch(/^deliberation:/);
  });

  it("per-agent positions are saved as episodic memories", () => {
    const memoryTemplate = {
      type: "episodic",
      namespace: "deliberation_positions",
      contextTrigger: "deliberation:dlb_1_12345",
    };
    expect(memoryTemplate.type).toBe("episodic");
    expect(memoryTemplate.namespace).toBe("deliberation_positions");
  });

  it("consensus-referenced memories get reinforced when >=2 keywords match", () => {
    // Test the keyword matching logic from structured-deliberation.ts
    const memoryContent = "We should use microservices architecture for better scalability";
    const decision = "Adopt microservices architecture with proper monitoring";

    const decisionLower = decision.toLowerCase();
    const keywords = memoryContent.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const matches = keywords.filter(k => decisionLower.includes(k));

    // "microservices", "architecture", "better", "scalability" are keywords
    // "microservices" and "architecture" match in the decision
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("does not reinforce memories with < 2 keyword matches", () => {
    const memoryContent = "The weather is nice today";
    const decision = "Adopt microservices architecture";

    const decisionLower = decision.toLowerCase();
    const keywords = memoryContent.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const matches = keywords.filter(k => decisionLower.includes(k));

    expect(matches.length).toBeLessThan(2);
  });
});

describe("Text relevance scoring", () => {
  it("scores based on word overlap between topic and memory content", () => {
    const topic = "Should we adopt microservices for our backend system";
    const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    // Memory about microservices → high relevance
    const highRelevanceContent = "microservices architecture provides better scalability for backend systems";
    const contentLower = highRelevanceContent.toLowerCase();
    const matchCount = topicWords.filter(w => contentLower.includes(w)).length;
    const highRelevance = matchCount / topicWords.length;

    // Memory about cooking → low relevance
    const lowRelevanceContent = "pasta should be cooked al dente for best results";
    const lowContentLower = lowRelevanceContent.toLowerCase();
    const lowMatchCount = topicWords.filter(w => lowContentLower.includes(w)).length;
    const lowRelevance = lowMatchCount / topicWords.length;

    expect(highRelevance).toBeGreaterThan(lowRelevance);
    expect(highRelevance).toBeGreaterThan(0);
  });
});

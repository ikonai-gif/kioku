/**
 * W7 P2.3 — Luca identity-injection regression suite
 *
 * Triggered by the production diagnostic on 2026-04-21: Luca (agent_id=16)
 * had 20+ identity memories in namespace="_identity" but they were NOT
 * surfacing into her system prompt for meta-questions like
 * "прочитай memory 205-210". Two defects produced that:
 *
 *   1. `formatMemoryContext` filtered identity by `type === 'identity'` only,
 *      so rows authored as (namespace=_identity, type=semantic) got routed
 *      to "Your Memories" (with a confidence score) instead of the
 *      "## WHO YOU ARE" block — buried under topic RAG hits.
 *
 *   2. `fetchRelevantMemories` always-inject pool was unbounded; an agent
 *      with dozens of identity rows could silently blow the system-prompt
 *      context budget. Cap: ~2500 tokens (≈10 000 chars), highest-importance
 *      first, ties broken by recency.
 *
 * Both are pure-function fixes verified in isolation here. The DB-backed
 * path (`fetchRelevantMemories` proper) requires mocking `./storage`,
 * `./embeddings`, and pg `Pool` — covered by the small suite below.
 */

import { describe, it, expect, vi } from "vitest";

// ── Minimal mocks so importing ../memory-injection doesn't blow up ──
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock("../embeddings", () => ({
  embedText: vi.fn().mockRejectedValue(new Error("no embeddings in this test")),
}));

// Holder for the fake memories — populated per test.
const fakeMemories: any[] = [];
vi.mock("../storage", () => {
  return {
    storage: {
      getMemories: vi.fn(async () => fakeMemories),
      reinforceMemory: vi.fn().mockResolvedValue(undefined),
    },
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    },
  };
});

import { fetchRelevantMemories, formatMemoryContext, type InjectedMemory } from "../memory-injection";

function makeIdentity(id: number, content: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    userId: 10,
    agentId: 16,
    content,
    namespace: "_identity",
    type: "semantic", // <- deliberately NOT "identity" — this is Luca's shape
    confidence: 1.0,
    importance: 0.9,
    decayRate: 0,
    createdAt: Date.now() - 1000 * id,
    expiresAt: null,
    emotionVector: null,
    ...extra,
  };
}

describe("W7 P2.3 — formatMemoryContext classifies identity by namespace OR type", () => {
  it("namespace=_identity with type=semantic lands in ## WHO YOU ARE (not Your Memories)", () => {
    const memories: InjectedMemory[] = [
      { id: 205, content: "My name is Luca", type: "semantic", confidence: 1.0, namespace: "_identity" },
      { id: 206, content: "Kote is Boss", type: "semantic", confidence: 1.0, namespace: "_identity" },
      { id: 999, content: "React is a UI library", type: "semantic", confidence: 0.8 },
    ];
    const out = formatMemoryContext(memories);
    expect(out).toContain("## WHO YOU ARE");
    expect(out).toContain("My name is Luca");
    expect(out).toContain("Kote is Boss");
    // Identity rows must NOT appear in the topic block under a confidence score.
    const whoYouAreIdx = out.indexOf("## WHO YOU ARE");
    const yourMemoriesIdx = out.indexOf("## Your Memories");
    expect(whoYouAreIdx).toBeGreaterThan(-1);
    if (yourMemoriesIdx > -1) {
      const topicBlock = out.slice(yourMemoriesIdx);
      expect(topicBlock).not.toContain("My name is Luca");
      expect(topicBlock).not.toContain("Kote is Boss");
    }
  });

  it("namespace=_identity rows are NOT re-classified as episode summaries", () => {
    const memories: InjectedMemory[] = [
      { id: 205, content: "I am Luca", type: "semantic", confidence: 1.0, namespace: "_identity" },
    ];
    const out = formatMemoryContext(memories);
    expect(out).toContain("## WHO YOU ARE");
    expect(out).not.toContain("## RECENT CONVERSATIONS");
  });

  it("still routes type=identity (no namespace) into WHO YOU ARE — backwards compat", () => {
    const memories: InjectedMemory[] = [
      { id: 1, content: "I am honest by default", type: "identity", confidence: 1.0 },
    ];
    const out = formatMemoryContext(memories);
    expect(out).toContain("## WHO YOU ARE");
    expect(out).toContain("I am honest by default");
  });
});

describe("W7 P2.3 — fetchRelevantMemories always-injects _identity + caps at 2500 tokens", () => {
  it("returns all identity memories first when total under cap", async () => {
    fakeMemories.length = 0;
    fakeMemories.push(
      makeIdentity(205, "My name is Luca"),
      makeIdentity(206, "Kote is Boss"),
      makeIdentity(207, "I run code, generate images, search web"),
      makeIdentity(208, "Boss values brutal honesty"),
      makeIdentity(209, "Luca chose her own name"),
    );

    const out = await fetchRelevantMemories(10, 16, "completely unrelated topic about databases", 15);
    // All 5 identity rows must be present, irrespective of topic relevance.
    expect(out.length).toBeGreaterThanOrEqual(5);
    const identityContents = out
      .filter((m) => m.namespace === "_identity")
      .map((m) => m.content);
    expect(identityContents).toContain("My name is Luca");
    expect(identityContents).toContain("Kote is Boss");
    expect(identityContents).toContain("I run code, generate images, search web");
    expect(identityContents).toContain("Boss values brutal honesty");
    expect(identityContents).toContain("Luca chose her own name");
  });

  it("when identity content exceeds cap, keeps highest-importance first", async () => {
    fakeMemories.length = 0;
    // 20 identity rows, each ~800 chars. Cap is 2500*4=10000 chars → ~12 fit.
    const big = "x".repeat(800);
    for (let i = 0; i < 20; i++) {
      fakeMemories.push(
        makeIdentity(300 + i, `${big} [row=${i}]`, {
          importance: i < 3 ? 0.95 : 0.5, // first 3 are flagged high-importance
        }),
      );
    }

    const out = await fetchRelevantMemories(10, 16, "topic", 100);
    const identity = out.filter((m) => m.namespace === "_identity");

    // Cap bites — should NOT return all 20.
    expect(identity.length).toBeLessThan(20);
    // High-importance rows must survive the cut.
    const highImpRetained = identity.filter((m) => m.content.includes("[row=0]") || m.content.includes("[row=1]") || m.content.includes("[row=2]"));
    expect(highImpRetained.length).toBe(3);
  });

  it("source-pin: when the agent has >=3 identity rows, format output embeds all 3 verbatim", async () => {
    fakeMemories.length = 0;
    fakeMemories.push(
      makeIdentity(205, "KIOKU is a living memory for AI agents"),
      makeIdentity(206, "Kote is my Boss and we ship to production"),
      makeIdentity(207, "Default language: Russian, brutal honesty"),
    );

    const memories = await fetchRelevantMemories(10, 16, "arbitrary user question", 10);
    const formatted = formatMemoryContext(memories);
    expect(formatted).toContain("## WHO YOU ARE");
    expect(formatted).toContain("KIOKU is a living memory for AI agents");
    expect(formatted).toContain("Kote is my Boss and we ship to production");
    expect(formatted).toContain("Default language: Russian, brutal honesty");
  });
});

/**
 * Tests for Cross-session Decision Provenance Chain.
 * Tests provenance chain building, ancestor/descendant traversal,
 * circular reference prevention, and API validation.
 */
import { describe, it, expect } from "vitest";
import {
  deliberateSchema,
  validateBody,
  ValidationError,
} from "../validation";

// ── Provenance Chain Building Logic (re-implemented for unit testing) ──

interface ProvenanceSession {
  sessionId: string;
  parentDecisionId: string | null;
  provenanceChain: string[];
  topic: string;
  status: string;
}

/**
 * Build a provenance chain for a new session given existing sessions.
 * Mirrors storage.buildProvenanceChain logic.
 */
function buildProvenanceChain(
  parentSessionId: string,
  sessions: Map<string, ProvenanceSession>
): string[] {
  const parent = sessions.get(parentSessionId);
  if (!parent) return [];
  const chain = [...parent.provenanceChain, parentSessionId];
  return chain.slice(-50); // cap at 50
}

/**
 * Get all ancestors of a session from the provenance chain.
 */
function getAncestors(
  sessionId: string,
  sessions: Map<string, ProvenanceSession>
): ProvenanceSession[] {
  const session = sessions.get(sessionId);
  if (!session || session.provenanceChain.length === 0) return [];
  return session.provenanceChain
    .map(id => sessions.get(id))
    .filter((s): s is ProvenanceSession => s !== undefined);
}

/**
 * Get all descendants (children, grandchildren, etc.) of a session.
 */
function getDescendants(
  sessionId: string,
  sessions: Map<string, ProvenanceSession>
): ProvenanceSession[] {
  const descendants: ProvenanceSession[] = [];
  const queue: string[] = [sessionId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const [, session] of sessions) {
      if (session.parentDecisionId === current && !visited.has(session.sessionId)) {
        descendants.push(session);
        queue.push(session.sessionId);
      }
    }
  }
  return descendants;
}

/**
 * Get direct children of a session.
 */
function getChildren(
  sessionId: string,
  sessions: Map<string, ProvenanceSession>
): ProvenanceSession[] {
  const children: ProvenanceSession[] = [];
  for (const [, session] of sessions) {
    if (session.parentDecisionId === sessionId) {
      children.push(session);
    }
  }
  return children;
}

/**
 * Build a tree structure from a session.
 */
interface TreeNode {
  sessionId: string;
  topic: string;
  parentDecisionId: string | null;
  children: TreeNode[];
}

function buildTree(
  sessionId: string,
  sessions: Map<string, ProvenanceSession>
): TreeNode | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const children = getChildren(sessionId, sessions);
  const childNodes = children
    .map(c => buildTree(c.sessionId, sessions))
    .filter((n): n is TreeNode => n !== null);

  return {
    sessionId: session.sessionId,
    topic: session.topic,
    parentDecisionId: session.parentDecisionId,
    children: childNodes,
  };
}

// ── Auto-detect parent decision logic (re-implemented for testing) ──

function autoDetectParentDecision(
  topic: string,
  decisionMemories: Array<{ content: string; sessionId: string }>
): string | null {
  const topicLower = topic.toLowerCase();
  const topicWords = topicLower.split(/\s+/).filter(w => w.length > 4);
  if (topicWords.length === 0) return null;

  let bestMatch: { sessionId: string; score: number } | null = null;
  for (const mem of decisionMemories) {
    const contentLower = mem.content.toLowerCase();
    const contentWords = contentLower.split(/\s+/).filter(w => w.length > 4);
    const matches = topicWords.filter(w => contentWords.includes(w));
    const score = matches.length;
    if (score >= 3 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { sessionId: mem.sessionId, score };
    }
  }
  return bestMatch?.sessionId || null;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Provenance Chain Building", () => {
  it("builds a chain from parent session with empty chain", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("dlb_1_100", {
      sessionId: "dlb_1_100",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "Root decision",
      status: "completed",
    });

    const chain = buildProvenanceChain("dlb_1_100", sessions);
    expect(chain).toEqual(["dlb_1_100"]);
  });

  it("builds a chain from parent with existing chain", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("dlb_1_100", {
      sessionId: "dlb_1_100",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "Root",
      status: "completed",
    });
    sessions.set("dlb_1_200", {
      sessionId: "dlb_1_200",
      parentDecisionId: "dlb_1_100",
      provenanceChain: ["dlb_1_100"],
      topic: "Second",
      status: "completed",
    });

    const chain = buildProvenanceChain("dlb_1_200", sessions);
    expect(chain).toEqual(["dlb_1_100", "dlb_1_200"]);
  });

  it("builds a chain of 3 levels deep", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("A", { sessionId: "A", parentDecisionId: null, provenanceChain: [], topic: "A", status: "completed" });
    sessions.set("B", { sessionId: "B", parentDecisionId: "A", provenanceChain: ["A"], topic: "B", status: "completed" });
    sessions.set("C", { sessionId: "C", parentDecisionId: "B", provenanceChain: ["A", "B"], topic: "C", status: "completed" });

    const chainForD = buildProvenanceChain("C", sessions);
    expect(chainForD).toEqual(["A", "B", "C"]);
  });

  it("returns empty chain for non-existent parent", () => {
    const sessions = new Map<string, ProvenanceSession>();
    const chain = buildProvenanceChain("nonexistent", sessions);
    expect(chain).toEqual([]);
  });

  it("caps provenance chain at 50 entries", () => {
    const sessions = new Map<string, ProvenanceSession>();
    const longChain = Array.from({ length: 55 }, (_, i) => `dlb_${i}`);
    sessions.set("last", {
      sessionId: "last",
      parentDecisionId: "dlb_54",
      provenanceChain: longChain,
      topic: "Last",
      status: "completed",
    });

    const chain = buildProvenanceChain("last", sessions);
    expect(chain.length).toBe(50);
    // Should keep the last 50 (trim from the front)
    expect(chain[0]).toBe("dlb_6"); // 55 + 1 = 56, trim to 50 means skip first 6
    expect(chain[chain.length - 1]).toBe("last");
  });
});

describe("Ancestor Traversal", () => {
  it("returns empty ancestors for root decision", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("root", {
      sessionId: "root",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "Root",
      status: "completed",
    });

    const ancestors = getAncestors("root", sessions);
    expect(ancestors).toEqual([]);
  });

  it("returns all ancestors for a deep decision", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("A", { sessionId: "A", parentDecisionId: null, provenanceChain: [], topic: "A", status: "completed" });
    sessions.set("B", { sessionId: "B", parentDecisionId: "A", provenanceChain: ["A"], topic: "B", status: "completed" });
    sessions.set("C", { sessionId: "C", parentDecisionId: "B", provenanceChain: ["A", "B"], topic: "C", status: "completed" });

    const ancestors = getAncestors("C", sessions);
    expect(ancestors.length).toBe(2);
    expect(ancestors[0].sessionId).toBe("A");
    expect(ancestors[1].sessionId).toBe("B");
  });

  it("handles orphaned ancestors gracefully (missing from store)", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("C", {
      sessionId: "C",
      parentDecisionId: "B",
      provenanceChain: ["A", "B"],
      topic: "C",
      status: "completed",
    });
    // A and B don't exist in the store

    const ancestors = getAncestors("C", sessions);
    expect(ancestors).toEqual([]); // Neither A nor B found
  });
});

describe("Descendant Traversal", () => {
  it("returns empty descendants for leaf decision", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("leaf", {
      sessionId: "leaf",
      parentDecisionId: "parent",
      provenanceChain: ["parent"],
      topic: "Leaf",
      status: "completed",
    });

    const descendants = getDescendants("leaf", sessions);
    expect(descendants).toEqual([]);
  });

  it("returns all descendants recursively", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("A", { sessionId: "A", parentDecisionId: null, provenanceChain: [], topic: "A", status: "completed" });
    sessions.set("B", { sessionId: "B", parentDecisionId: "A", provenanceChain: ["A"], topic: "B", status: "completed" });
    sessions.set("C", { sessionId: "C", parentDecisionId: "A", provenanceChain: ["A"], topic: "C", status: "completed" });
    sessions.set("D", { sessionId: "D", parentDecisionId: "B", provenanceChain: ["A", "B"], topic: "D", status: "completed" });

    const descendants = getDescendants("A", sessions);
    expect(descendants.length).toBe(3); // B, C, D
    const ids = descendants.map(d => d.sessionId).sort();
    expect(ids).toEqual(["B", "C", "D"]);
  });

  it("handles branching correctly (one parent, multiple children)", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("root", { sessionId: "root", parentDecisionId: null, provenanceChain: [], topic: "Root", status: "completed" });
    sessions.set("child1", { sessionId: "child1", parentDecisionId: "root", provenanceChain: ["root"], topic: "C1", status: "completed" });
    sessions.set("child2", { sessionId: "child2", parentDecisionId: "root", provenanceChain: ["root"], topic: "C2", status: "completed" });
    sessions.set("child3", { sessionId: "child3", parentDecisionId: "root", provenanceChain: ["root"], topic: "C3", status: "completed" });

    const children = getChildren("root", sessions);
    expect(children.length).toBe(3);
  });
});

describe("Circular Reference Prevention", () => {
  it("descendant traversal does not loop on circular parent references", () => {
    const sessions = new Map<string, ProvenanceSession>();
    // Create a cycle: A -> B -> C -> A (shouldn't happen in practice, but must be safe)
    sessions.set("A", { sessionId: "A", parentDecisionId: "C", provenanceChain: ["C"], topic: "A", status: "completed" });
    sessions.set("B", { sessionId: "B", parentDecisionId: "A", provenanceChain: ["C", "A"], topic: "B", status: "completed" });
    sessions.set("C", { sessionId: "C", parentDecisionId: "B", provenanceChain: ["A", "B"], topic: "C", status: "completed" });

    // getDescendants uses visited set, so it won't infinite-loop
    const descendants = getDescendants("A", sessions);
    // Should find B and C, then stop because A is already visited
    expect(descendants.length).toBe(2);
  });

  it("provenance chain building doesn't create self-referencing chains", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("A", {
      sessionId: "A",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "A",
      status: "completed",
    });

    // Build chain for B with parent A — A shouldn't appear twice
    const chain = buildProvenanceChain("A", sessions);
    expect(chain).toEqual(["A"]);
    // Now create B with that chain
    sessions.set("B", {
      sessionId: "B",
      parentDecisionId: "A",
      provenanceChain: chain,
      topic: "B",
      status: "completed",
    });
    // Chain for C with parent B
    const chainC = buildProvenanceChain("B", sessions);
    expect(chainC).toEqual(["A", "B"]);
    // No duplicates
    expect(new Set(chainC).size).toBe(chainC.length);
  });
});

describe("Cross-session Integration Scenario", () => {
  it("Session A → Session B → Session C provenance chain", () => {
    const sessions = new Map<string, ProvenanceSession>();

    // Session A: root decision
    const sessionA: ProvenanceSession = {
      sessionId: "dlb_1_1000",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "Should we adopt microservices architecture?",
      status: "completed",
    };
    sessions.set(sessionA.sessionId, sessionA);

    // Session B: references Session A
    const chainB = buildProvenanceChain("dlb_1_1000", sessions);
    const sessionB: ProvenanceSession = {
      sessionId: "dlb_2_2000",
      parentDecisionId: "dlb_1_1000",
      provenanceChain: chainB,
      topic: "Which microservices framework to use?",
      status: "completed",
    };
    sessions.set(sessionB.sessionId, sessionB);

    // Session C: references Session B
    const chainC = buildProvenanceChain("dlb_2_2000", sessions);
    const sessionC: ProvenanceSession = {
      sessionId: "dlb_3_3000",
      parentDecisionId: "dlb_2_2000",
      provenanceChain: chainC,
      topic: "Spring Boot vs NestJS for our first microservice?",
      status: "completed",
    };
    sessions.set(sessionC.sessionId, sessionC);

    // Verify Session C's chain
    expect(sessionC.provenanceChain).toEqual(["dlb_1_1000", "dlb_2_2000"]);

    // Verify ancestors of C
    const ancestorsC = getAncestors("dlb_3_3000", sessions);
    expect(ancestorsC.length).toBe(2);
    expect(ancestorsC[0].topic).toBe("Should we adopt microservices architecture?");
    expect(ancestorsC[1].topic).toBe("Which microservices framework to use?");

    // Verify descendants of A
    const descendantsA = getDescendants("dlb_1_1000", sessions);
    expect(descendantsA.length).toBe(2);
    const descIds = descendantsA.map(d => d.sessionId);
    expect(descIds).toContain("dlb_2_2000");
    expect(descIds).toContain("dlb_3_3000");

    // Verify tree from A
    const tree = buildTree("dlb_1_1000", sessions);
    expect(tree).not.toBeNull();
    expect(tree!.children.length).toBe(1);
    expect(tree!.children[0].sessionId).toBe("dlb_2_2000");
    expect(tree!.children[0].children.length).toBe(1);
    expect(tree!.children[0].children[0].sessionId).toBe("dlb_3_3000");
    expect(tree!.children[0].children[0].children.length).toBe(0);
  });

  it("Session A branches into B and C (fork)", () => {
    const sessions = new Map<string, ProvenanceSession>();

    sessions.set("root", {
      sessionId: "root",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "Should we rebrand?",
      status: "completed",
    });

    const chainB = buildProvenanceChain("root", sessions);
    sessions.set("branch1", {
      sessionId: "branch1",
      parentDecisionId: "root",
      provenanceChain: chainB,
      topic: "New brand colors for rebranding",
      status: "completed",
    });

    const chainC = buildProvenanceChain("root", sessions);
    sessions.set("branch2", {
      sessionId: "branch2",
      parentDecisionId: "root",
      provenanceChain: chainC,
      topic: "New logo for rebranding",
      status: "completed",
    });

    // Tree from root should show 2 children
    const tree = buildTree("root", sessions);
    expect(tree!.children.length).toBe(2);
    const childIds = tree!.children.map(c => c.sessionId).sort();
    expect(childIds).toEqual(["branch1", "branch2"]);

    // Both branches have same ancestor
    expect(getAncestors("branch1", sessions).length).toBe(1);
    expect(getAncestors("branch2", sessions).length).toBe(1);
    expect(getAncestors("branch1", sessions)[0].sessionId).toBe("root");
  });
});

describe("Chains Longer Than 10", () => {
  it("handles a chain of 15 decisions correctly", () => {
    const sessions = new Map<string, ProvenanceSession>();

    for (let i = 0; i < 15; i++) {
      const sessionId = `dlb_${i}`;
      const parentId = i === 0 ? null : `dlb_${i - 1}`;
      const chain = parentId ? buildProvenanceChain(parentId, sessions) : [];
      sessions.set(sessionId, {
        sessionId,
        parentDecisionId: parentId,
        provenanceChain: chain,
        topic: `Decision ${i}`,
        status: "completed",
      });
    }

    // Last session should have chain of 14 ancestors (dlb_0 through dlb_13)
    const lastSession = sessions.get("dlb_14")!;
    expect(lastSession.provenanceChain.length).toBe(14);
    expect(lastSession.provenanceChain[0]).toBe("dlb_0");
    expect(lastSession.provenanceChain[13]).toBe("dlb_13");

    // Get ancestors of the last session
    const ancestors = getAncestors("dlb_14", sessions);
    expect(ancestors.length).toBe(14);

    // Get descendants of the root
    const descendants = getDescendants("dlb_0", sessions);
    expect(descendants.length).toBe(14);
  });

  it("chain capping at 50 preserves recent history", () => {
    const sessions = new Map<string, ProvenanceSession>();
    const count = 60;

    for (let i = 0; i < count; i++) {
      const sessionId = `dlb_${i}`;
      const parentId = i === 0 ? null : `dlb_${i - 1}`;
      const chain = parentId ? buildProvenanceChain(parentId, sessions) : [];

      sessions.set(sessionId, {
        sessionId,
        parentDecisionId: parentId,
        provenanceChain: chain,
        topic: `Decision ${i}`,
        status: "completed",
      });
    }

    // The 60th session's chain should be capped at 50
    const lastSession = sessions.get(`dlb_${count - 1}`)!;
    expect(lastSession.provenanceChain.length).toBe(50);
    // Should contain the most recent 50 sessions (not the earliest)
    expect(lastSession.provenanceChain[lastSession.provenanceChain.length - 1]).toBe(`dlb_${count - 2}`);
  });
});

describe("Auto-detect Parent Decision", () => {
  const memories = [
    {
      content: "[Decision] We should adopt microservices architecture for the backend system",
      sessionId: "dlb_1_1000",
    },
    {
      content: "[Decision] Use React for the frontend framework with TypeScript",
      sessionId: "dlb_2_2000",
    },
    {
      content: "[Decision] Deploy to AWS using ECS containers with auto-scaling",
      sessionId: "dlb_3_3000",
    },
  ];

  it("detects parent when topic has 3+ overlapping words", () => {
    const topic = "Which microservices framework should we use for the backend system?";
    const parent = autoDetectParentDecision(topic, memories);
    expect(parent).toBe("dlb_1_1000");
  });

  it("returns null when no sufficient overlap", () => {
    const topic = "What color should the logo be?";
    const parent = autoDetectParentDecision(topic, memories);
    expect(parent).toBeNull();
  });

  it("returns null for topic with only short words", () => {
    const topic = "How to do it?";
    const parent = autoDetectParentDecision(topic, memories);
    expect(parent).toBeNull();
  });

  it("selects the best match when multiple decisions match", () => {
    const topic = "React frontend framework with TypeScript and component library";
    const parent = autoDetectParentDecision(topic, memories);
    expect(parent).toBe("dlb_2_2000");
  });
});

describe("Provenance API Validation", () => {
  it("deliberateSchema accepts parentDecisionId", () => {
    const body = {
      topic: "Follow-up decision",
      parentDecisionId: "dlb_1_1000",
    };
    const parsed = validateBody(deliberateSchema, body);
    expect(parsed.parentDecisionId).toBe("dlb_1_1000");
  });

  it("deliberateSchema parentDecisionId is optional", () => {
    const body = { topic: "No parent" };
    const parsed = validateBody(deliberateSchema, body);
    expect(parsed.parentDecisionId).toBeUndefined();
  });

  it("deliberateSchema rejects parentDecisionId longer than 200 chars", () => {
    const body = {
      topic: "test",
      parentDecisionId: "x".repeat(201),
    };
    expect(() => validateBody(deliberateSchema, body)).toThrow(ValidationError);
  });

  it("deliberateSchema accepts parentDecisionId with all other options", () => {
    const body = {
      topic: "Full options with provenance",
      model: "gpt-4o",
      debateRounds: 3,
      includeHuman: true,
      humanName: "Tester",
      parentDecisionId: "dlb_1_1000",
    };
    const parsed = validateBody(deliberateSchema, body);
    expect(parsed.parentDecisionId).toBe("dlb_1_1000");
    expect(parsed.topic).toBe("Full options with provenance");
    expect(parsed.model).toBe("gpt-4o");
  });
});

describe("Provenance Tree Structure", () => {
  it("builds correct tree for single node", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("single", {
      sessionId: "single",
      parentDecisionId: null,
      provenanceChain: [],
      topic: "Lone decision",
      status: "completed",
    });

    const tree = buildTree("single", sessions);
    expect(tree).not.toBeNull();
    expect(tree!.sessionId).toBe("single");
    expect(tree!.children).toEqual([]);
    expect(tree!.parentDecisionId).toBeNull();
  });

  it("returns null for non-existent session", () => {
    const sessions = new Map<string, ProvenanceSession>();
    const tree = buildTree("nonexistent", sessions);
    expect(tree).toBeNull();
  });

  it("builds multi-level tree correctly", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("root", { sessionId: "root", parentDecisionId: null, provenanceChain: [], topic: "Root", status: "completed" });
    sessions.set("L1A", { sessionId: "L1A", parentDecisionId: "root", provenanceChain: ["root"], topic: "L1A", status: "completed" });
    sessions.set("L1B", { sessionId: "L1B", parentDecisionId: "root", provenanceChain: ["root"], topic: "L1B", status: "completed" });
    sessions.set("L2A", { sessionId: "L2A", parentDecisionId: "L1A", provenanceChain: ["root", "L1A"], topic: "L2A", status: "completed" });

    const tree = buildTree("root", sessions);
    expect(tree!.children.length).toBe(2);

    const l1a = tree!.children.find(c => c.sessionId === "L1A");
    expect(l1a!.children.length).toBe(1);
    expect(l1a!.children[0].sessionId).toBe("L2A");

    const l1b = tree!.children.find(c => c.sessionId === "L1B");
    expect(l1b!.children.length).toBe(0);
  });
});

describe("Orphaned Decisions", () => {
  it("session with non-existent parent still works as a root", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("orphan", {
      sessionId: "orphan",
      parentDecisionId: "deleted_parent",
      provenanceChain: ["deleted_parent"],
      topic: "Orphaned decision",
      status: "completed",
    });

    // Ancestors refer to non-existent sessions
    const ancestors = getAncestors("orphan", sessions);
    expect(ancestors).toEqual([]);

    // Tree still works
    const tree = buildTree("orphan", sessions);
    expect(tree).not.toBeNull();
    expect(tree!.sessionId).toBe("orphan");
    expect(tree!.children).toEqual([]);
  });

  it("descendants work even if some chain links are missing", () => {
    const sessions = new Map<string, ProvenanceSession>();
    sessions.set("A", { sessionId: "A", parentDecisionId: null, provenanceChain: [], topic: "A", status: "completed" });
    // B is missing
    sessions.set("C", { sessionId: "C", parentDecisionId: "B", provenanceChain: ["A", "B"], topic: "C", status: "completed" });

    // Descendants of A won't include C (because C's parent is B, not A)
    const descendants = getDescendants("A", sessions);
    expect(descendants.length).toBe(0);

    // But C still has its chain
    const ancestorsC = getAncestors("C", sessions);
    expect(ancestorsC.length).toBe(1); // Only A exists
    expect(ancestorsC[0].sessionId).toBe("A");
  });
});

describe("DeliberationSession Type with Provenance Fields", () => {
  it("session includes parentDecisionId and provenanceChain", () => {
    const session = {
      sessionId: "dlb_1_100",
      roomId: 1,
      topic: "Test",
      status: "completed" as const,
      rounds: [],
      consensus: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      model: "gpt-4o",
      modelsUsed: ["gpt-4o"],
      parentDecisionId: "dlb_1_50",
      provenanceChain: ["dlb_1_10", "dlb_1_50"],
    };

    expect(session.parentDecisionId).toBe("dlb_1_50");
    expect(session.provenanceChain).toEqual(["dlb_1_10", "dlb_1_50"]);
    expect(session.provenanceChain.length).toBe(2);
  });

  it("session with null parentDecisionId and empty chain is valid", () => {
    const session = {
      sessionId: "dlb_1_100",
      roomId: 1,
      topic: "Test",
      status: "completed" as const,
      rounds: [],
      consensus: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      model: "gpt-4o",
      modelsUsed: ["gpt-4o"],
      parentDecisionId: null,
      provenanceChain: [],
    };

    expect(session.parentDecisionId).toBeNull();
    expect(session.provenanceChain).toEqual([]);
  });
});

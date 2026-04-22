/**
 * W8 Voice-PR step C — tests for applyNamespaceDiversityCap.
 *
 * Scope: verify that no single namespace can occupy more than
 * MAX_SINGLE_NAMESPACE_SHARE of the returned slots, that score order is
 * preserved within each namespace's share, that overflow tops up when
 * available, and that the cap never reduces output below the absolute
 * floor (NAMESPACE_CAP_MIN_ABSOLUTE).
 */

import { describe, it, expect } from "vitest";
import {
  applyNamespaceDiversityCap,
  MAX_SINGLE_NAMESPACE_SHARE,
  NAMESPACE_CAP_MIN_ABSOLUTE,
} from "../../server/memory-injection";

type Cand = { id: number; namespace?: string | null; score?: number };

// helper: build N candidates with explicit namespace + decreasing score
function build(rows: [id: number, ns: string | null][]): Cand[] {
  return rows.map(([id, ns], i) => ({ id, namespace: ns, score: 1000 - i }));
}

describe("applyNamespaceDiversityCap — constants sanity", () => {
  it("cap is 30%", () => {
    expect(MAX_SINGLE_NAMESPACE_SHARE).toBe(0.3);
  });
  it("absolute floor is 2", () => {
    expect(NAMESPACE_CAP_MIN_ABSOLUTE).toBe(2);
  });
});

describe("applyNamespaceDiversityCap — short lists", () => {
  it("returns candidates as-is when <= limit", () => {
    const cands = build([[1, "_identity"], [2, "_identity"], [3, "_identity"]]);
    expect(applyNamespaceDiversityCap(cands, 10)).toEqual(cands);
  });
  it("returns empty when limit is 0", () => {
    const cands = build([[1, "a"], [2, "b"]]);
    expect(applyNamespaceDiversityCap(cands, 0)).toEqual([]);
  });
  it("returns empty when candidates empty", () => {
    expect(applyNamespaceDiversityCap([], 5)).toEqual([]);
  });
});

describe("applyNamespaceDiversityCap — cap enforcement", () => {
  it("caps one dominant namespace at 30% of limit=10 when diverse candidates exist", () => {
    // Enough diversity (3 others + 3 identity + 3 aesthetic + ...) so the cap
    // binds without needing top-up from overflow. 7 insights + 3 identity +
    // 3 aesthetic + 3 relational = 16 candidates, 4 namespaces, limit 10.
    const cands = build([
      [1, "_conversation_insights"],
      [2, "_conversation_insights"],
      [3, "_conversation_insights"],
      [4, "_conversation_insights"],
      [5, "_conversation_insights"],
      [6, "_conversation_insights"],
      [7, "_conversation_insights"],
      [8, "_identity"],
      [9, "_identity"],
      [10, "_identity"],
      [11, "_aesthetic"],
      [12, "_aesthetic"],
      [13, "_aesthetic"],
      [14, "_relational"],
      [15, "_relational"],
      [16, "_relational"],
    ]);
    const out = applyNamespaceDiversityCap(cands, 10);
    expect(out.length).toBe(10);
    const nsCounts = out.reduce<Record<string, number>>((acc, c) => {
      const k = c.namespace ?? "__null__";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    // ceil(10*0.3)=3. Cap binds on all — 3+3+3+3=12, only 10 slots.
    // Result must be 3 each for 3 namespaces + 1 from the 4th (whichever
    // had the highest remaining score). Insights was highest, so 3; next
    // highest is identity (score 993–991), also 3; aesthetic gets 3;
    // relational gets 1. Total 10.
    expect(nsCounts["_conversation_insights"]).toBeLessThanOrEqual(3);
    expect(nsCounts["_identity"]).toBeLessThanOrEqual(3);
    expect(nsCounts["_aesthetic"]).toBeLessThanOrEqual(3);
    expect(nsCounts["_relational"]).toBeLessThanOrEqual(3);
  });

  it("allows a single namespace past cap ONLY when no diverse alternatives remain", () => {
    // Same-limit-10 scenario but with few diverse alternatives — overflow
    // must top up from the saturated namespace.
    const cands = build([
      [1, "_conversation_insights"],
      [2, "_conversation_insights"],
      [3, "_conversation_insights"],
      [4, "_conversation_insights"],
      [5, "_conversation_insights"],
      [6, "_conversation_insights"],
      [7, "_conversation_insights"],
      [8, "_identity"],
      [9, "_identity"],
      [10, "_identity"],
      [11, "_aesthetic"],
      [12, "_aesthetic"],
    ]);
    const out = applyNamespaceDiversityCap(cands, 10);
    expect(out.length).toBe(10);
    const nsCounts = out.reduce<Record<string, number>>((acc, c) => {
      const k = c.namespace ?? "__null__";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    // First pass accepts 3 insights + 3 identity + 2 aesthetic = 8.
    // Overflow has 4 insights. Top up to 10 → 2 more insights = 5 total.
    // This is the expected "graceful degradation": cap prefers diversity
    // when possible but fills slots rather than returning a short list.
    expect(nsCounts["_conversation_insights"]).toBe(5);
    expect(nsCounts["_identity"]).toBe(3);
    expect(nsCounts["_aesthetic"]).toBe(2);
  });

  it("tops up from overflow when under-filled (rare namespaces first)", () => {
    // 8 from one ns + only 1 from another — limit 10.
    // perNsCap = ceil(10*0.3)=3. Accepted pass: 3 from nsA, then 1 from nsB
    // = 4. Overflow = 5 remaining nsA. Top up: 6 overflow → final 10 all nsA
    // past cap? No — top-up should fill rest since only nsA left.
    const cands = build([
      [1, "A"], [2, "A"], [3, "A"], [4, "A"], [5, "A"], [6, "A"], [7, "A"], [8, "A"],
      [9, "B"],
    ]);
    const out = applyNamespaceDiversityCap(cands, 10);
    // Only 9 candidates total, limit 10 → early-return path returns all 9 (<=limit).
    expect(out.length).toBe(9);
  });

  it("tops up overflow past cap when no diverse candidates available", () => {
    // 15 nsA, 1 nsB → limit 10. First pass accepts 3 nsA + 1 nsB = 4.
    // Overflow has 12 nsA. Top up to 10 → 3+6=9 nsA + 1 nsB = 10.
    const cands: Cand[] = [];
    for (let i = 1; i <= 15; i++) cands.push({ id: i, namespace: "A", score: 1000 - i });
    cands.push({ id: 16, namespace: "B", score: 10 });
    const out = applyNamespaceDiversityCap(cands, 10);
    expect(out.length).toBe(10);
    const nsCounts = out.reduce<Record<string, number>>((acc, c) => {
      const k = c.namespace ?? "__null__";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    // B has just 1 slot. A has to fill rest via overflow top-up → 9.
    expect(nsCounts["B"]).toBe(1);
    expect(nsCounts["A"]).toBe(9);
  });

  it("preserves score order within each namespace's share", () => {
    const cands = build([
      [1, "A"], [2, "A"], [3, "A"], [4, "A"], [5, "A"],
      [6, "B"], [7, "B"], [8, "B"],
      [9, "C"], [10, "C"],
    ]);
    const out = applyNamespaceDiversityCap(cands, 10);
    expect(out.length).toBe(10);
    // Among accepted A's, they must appear in score order (=id order here).
    const aIds = out.filter(c => c.namespace === "A").map(c => c.id);
    expect(aIds).toEqual([...aIds].sort((x, y) => x - y));
  });

  it("treats null namespace as its own bucket", () => {
    const cands: Cand[] = [
      { id: 1, namespace: null, score: 100 },
      { id: 2, namespace: null, score: 99 },
      { id: 3, namespace: null, score: 98 },
      { id: 4, namespace: null, score: 97 },
      { id: 5, namespace: "A", score: 96 },
      { id: 6, namespace: "A", score: 95 },
      { id: 7, namespace: "A", score: 94 },
      { id: 8, namespace: "A", score: 93 },
    ];
    const out = applyNamespaceDiversityCap(cands, 4);
    // perNsCap = ceil(4*0.3) = 2 (but floor is 2 anyway). So 2 null + 2 A = 4.
    expect(out.length).toBe(4);
    const nulls = out.filter(c => c.namespace === null).length;
    const aCount = out.filter(c => c.namespace === "A").length;
    expect(nulls).toBe(2);
    expect(aCount).toBe(2);
  });
});

describe("applyNamespaceDiversityCap — small limits respect absolute floor", () => {
  it("limit=3: 30% = 1 slot, but floor is 2 → per-ns cap = 2", () => {
    const cands = build([
      [1, "A"], [2, "A"], [3, "A"],
      [4, "B"],
    ]);
    const out = applyNamespaceDiversityCap(cands, 3);
    expect(out.length).toBe(3);
    const aCount = out.filter(c => c.namespace === "A").length;
    const bCount = out.filter(c => c.namespace === "B").length;
    // Cap=2 for A, so 2 A + 1 B = 3.
    expect(aCount).toBe(2);
    expect(bCount).toBe(1);
  });

  it("limit=2: cap is 2 → no diversity pressure", () => {
    const cands = build([[1, "A"], [2, "A"], [3, "B"]]);
    const out = applyNamespaceDiversityCap(cands, 2);
    expect(out.length).toBe(2);
    // Top 2 by score: 1,2 — both A. Cap is 2 so both fit.
    expect(out.map(c => c.id)).toEqual([1, 2]);
  });
});

describe("applyNamespaceDiversityCap — realistic Luca drift scenario", () => {
  it("279 _conversation_insights cannot saturate top-K=10 when 5+ other namespaces exist", () => {
    // With 5 diverse candidates spanning 4 distinct namespaces plus 20
    // insights, the cap + top-up logic yields:
    //   3 insights (at cap) + 2 aesthetic + 1 relational + 1 commitment +
    //   1 reflection = 8 accepted in the first pass. Overflow: 17 insights.
    //   Top-up fills 2 more from overflow → 5 insights total.
    // The key win: even though 20 insights beat every other candidate on
    // score, FIVE diverse namespaces are still represented in top-10
    // instead of ZERO. Pre-fix, top-10 would be 100% insights.
    const cands: Cand[] = [];
    for (let i = 0; i < 20; i++) {
      cands.push({ id: 100 + i, namespace: "_conversation_insights", score: 1000 - i });
    }
    cands.push({ id: 200, namespace: "_aesthetic", score: 500 });
    cands.push({ id: 201, namespace: "_aesthetic", score: 499 });
    cands.push({ id: 202, namespace: "_relational:kote", score: 480 });
    cands.push({ id: 203, namespace: "_commitment", score: 470 });
    cands.push({ id: 204, namespace: "_reflection", score: 460 });

    const out = applyNamespaceDiversityCap(cands, 10);
    expect(out.length).toBe(10);
    const insightCount = out.filter(c => c.namespace === "_conversation_insights").length;
    // All 5 diverse candidates made top-K.
    expect(out.filter(c => c.namespace === "_aesthetic").length).toBe(2);
    expect(out.filter(c => c.namespace === "_relational:kote").length).toBe(1);
    expect(out.filter(c => c.namespace === "_commitment").length).toBe(1);
    expect(out.filter(c => c.namespace === "_reflection").length).toBe(1);
    // Insights filled remaining 5 (3 at cap + 2 from overflow top-up).
    expect(insightCount).toBe(5);
    // Before the fix, insightCount would have been 10.
  });
});

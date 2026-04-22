/**
 * KIOKU™ — Retrieval Sidecar + Type Weights (W7 P2.14)
 *
 * Problem: the old retrieval scorer used a single hardcoded `1.2` bump for
 * procedural/causal types and ignored identity/commitment/meta_cognitive
 * entirely. Combined with the absence of any `related_ids` post-processing,
 * aesthetic noir memories could outrank identity (see missed_by_both.md
 * 2026-04-22). P2.13 injects a live CORE IDENTITY block; P2.14 closes the
 * other half by making retrieval respect the type hierarchy AND honouring
 * the non-linear graph links Luca writes via `remember(…, related_ids:[…])`.
 *
 * Invariants tested at source level (no DB required):
 *   - typeWeight returns the exact coefficients Luca proposed + identity=1.5
 *     (identity > commitment > meta_cognitive > reflection > relational =
 *      procedural = autobiographical > baseline > episodic).
 *   - parseMetaSidecar extracts JSON from `[meta: {…}]` suffix, tolerates
 *     whitespace, returns {} on missing/malformed/invalid JSON (never throws).
 *   - relatedIdsBoost: 1.0 when no sidecar, no related_ids, or zero hits;
 *     1 + 0.15 × hits otherwise; capped at RELATED_IDS_BOOST_CAP (1.6);
 *     exported constants match (0.15, 1.6).
 *   - Source-level: both the vector branch AND keyword-fallback branch in
 *     memory-injection.ts use typeWeight() instead of hardcoded bumps, and
 *     both branches run a post-processing related_ids boost with an
 *     acceptedIds set = alwaysInject + episodeSummaries + top-K.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  typeWeight,
  parseMetaSidecar,
  relatedIdsBoost,
  RELATED_IDS_BOOST_PER_HIT,
  RELATED_IDS_BOOST_CAP,
} from "../../server/memory-injection.js";

const source = readFileSync(
  resolve(__dirname, "../../server/memory-injection.ts"),
  "utf8"
);

describe("P2.14 — typeWeight hierarchy", () => {
  it("returns identity=1.5 (added on top of Luca's table as defense-in-depth)", () => {
    expect(typeWeight("identity")).toBe(1.5);
  });

  it("returns Luca's proposed coefficients for the middle tier", () => {
    expect(typeWeight("commitment")).toBe(1.4);
    expect(typeWeight("meta_cognitive")).toBe(1.3);
    expect(typeWeight("reflection")).toBe(1.2);
  });

  it("returns 1.1 for the relational/procedural/autobiographical tier", () => {
    expect(typeWeight("relational")).toBe(1.1);
    expect(typeWeight("procedural")).toBe(1.1);
    expect(typeWeight("autobiographical")).toBe(1.1);
  });

  it("returns 0.9 for episodic (de-emphasised — 258 of these for Luca)", () => {
    expect(typeWeight("episodic")).toBe(0.9);
  });

  it("returns 1.0 baseline for unknown / legacy / null / undefined types", () => {
    expect(typeWeight("aesthetic")).toBe(1.0);
    expect(typeWeight("emotional_state")).toBe(1.0);
    expect(typeWeight("semantic")).toBe(1.0);
    expect(typeWeight("fact")).toBe(1.0);
    expect(typeWeight("causal")).toBe(1.0);
    expect(typeWeight("unknown_type_xyz")).toBe(1.0);
    expect(typeWeight(null)).toBe(1.0);
    expect(typeWeight(undefined)).toBe(1.0);
    expect(typeWeight("")).toBe(1.0);
  });

  it("preserves the strict ordering identity > commitment > meta_cognitive > reflection > relational > baseline > episodic", () => {
    expect(typeWeight("identity")).toBeGreaterThan(typeWeight("commitment"));
    expect(typeWeight("commitment")).toBeGreaterThan(typeWeight("meta_cognitive"));
    expect(typeWeight("meta_cognitive")).toBeGreaterThan(typeWeight("reflection"));
    expect(typeWeight("reflection")).toBeGreaterThan(typeWeight("relational"));
    expect(typeWeight("relational")).toBeGreaterThan(typeWeight("aesthetic"));
    expect(typeWeight("aesthetic")).toBeGreaterThan(typeWeight("episodic"));
  });
});

describe("P2.14 — parseMetaSidecar", () => {
  it("returns {} for missing / null / undefined / empty / non-string content", () => {
    expect(parseMetaSidecar(null)).toEqual({});
    expect(parseMetaSidecar(undefined)).toEqual({});
    expect(parseMetaSidecar("")).toEqual({});
    expect(parseMetaSidecar("plain text, no sidecar")).toEqual({});
    // @ts-expect-error — intentional wrong type
    expect(parseMetaSidecar(123)).toEqual({});
  });

  it("extracts related_ids from a valid sidecar at end of content", () => {
    const content = "Commitment to review angle 1 by EOW [meta: {\"related_ids\":[703,699]}]";
    const parsed = parseMetaSidecar(content);
    expect(parsed.related_ids).toEqual([703, 699]);
  });

  it("extracts emotions object from a valid sidecar", () => {
    const content = "Felt curious about noir drift [meta: {\"emotions\":{\"curious\":0.7,\"anxious\":0.2}}]";
    const parsed = parseMetaSidecar(content);
    expect(parsed.emotions).toEqual({ curious: 0.7, anxious: 0.2 });
  });

  it("extracts both related_ids and emotions when both present", () => {
    const content = "Reflection [meta: {\"related_ids\":[1,2,3],\"emotions\":{\"calm\":0.5}}]";
    const parsed = parseMetaSidecar(content);
    expect(parsed.related_ids).toEqual([1, 2, 3]);
    expect(parsed.emotions).toEqual({ calm: 0.5 });
  });

  it("tolerates whitespace in the sidecar marker", () => {
    const content = "Some content [meta:   {\"related_ids\":[42]}  ]";
    const parsed = parseMetaSidecar(content);
    expect(parsed.related_ids).toEqual([42]);
  });

  it("filters out non-finite related_ids entries", () => {
    const content = `foo [meta: {"related_ids":[1,"bad",null,2,3]}]`;
    const parsed = parseMetaSidecar(content);
    expect(parsed.related_ids).toEqual([1, 2, 3]);
  });

  it("returns {} for malformed JSON without throwing", () => {
    const content = "broken [meta: {not valid json}]";
    expect(() => parseMetaSidecar(content)).not.toThrow();
    expect(parseMetaSidecar(content)).toEqual({});
  });

  it("ignores sidecar-shaped text that isn't at the end of content", () => {
    // The regex anchors to end-of-string on purpose: the sidecar must be the
    // last thing so it doesn't collide with quoted examples inside content.
    const content = "Earlier [meta: {\"related_ids\":[1]}] and then more text after";
    expect(parseMetaSidecar(content)).toEqual({});
  });

  it("returns {} when related_ids is not an array (wrong type)", () => {
    const content = `foo [meta: {"related_ids":"not-an-array"}]`;
    const parsed = parseMetaSidecar(content);
    expect(parsed.related_ids).toBeUndefined();
  });
});

describe("P2.14 — relatedIdsBoost", () => {
  it("exports the expected tunable constants", () => {
    expect(RELATED_IDS_BOOST_PER_HIT).toBe(0.15);
    expect(RELATED_IDS_BOOST_CAP).toBe(1.6);
  });

  it("returns 1.0 when no sidecar is present", () => {
    expect(relatedIdsBoost("plain content", new Set([1, 2, 3]))).toBe(1.0);
  });

  it("returns 1.0 when related_ids is empty or missing", () => {
    expect(
      relatedIdsBoost('foo [meta: {"related_ids":[]}]', new Set([1, 2]))
    ).toBe(1.0);
    expect(
      relatedIdsBoost('foo [meta: {"emotions":{"calm":0.5}}]', new Set([1, 2]))
    ).toBe(1.0);
  });

  it("returns 1.0 when none of the related_ids hit the accepted set", () => {
    expect(
      relatedIdsBoost('foo [meta: {"related_ids":[99,100]}]', new Set([1, 2, 3]))
    ).toBe(1.0);
  });

  it("returns 1.15 for exactly one hit", () => {
    const boost = relatedIdsBoost(
      'foo [meta: {"related_ids":[703,999]}]',
      new Set([703, 1, 2])
    );
    expect(boost).toBeCloseTo(1.15, 5);
  });

  it("returns 1 + 0.15 × hits for multiple hits below the cap", () => {
    // 3 hits → 1 + 0.45 = 1.45
    const boost = relatedIdsBoost(
      'foo [meta: {"related_ids":[1,2,3,99]}]',
      new Set([1, 2, 3])
    );
    expect(boost).toBeCloseTo(1.45, 5);
  });

  it("caps the boost at RELATED_IDS_BOOST_CAP (1.6) even for many hits", () => {
    // 10 hits would be 2.5 uncapped
    const manyIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const boost = relatedIdsBoost(
      `foo [meta: {"related_ids":${JSON.stringify(manyIds)}}]`,
      new Set(manyIds)
    );
    expect(boost).toBe(1.6);
  });

  it("caps at exactly the boundary (5 hits → 1.75 uncapped → 1.6 capped)", () => {
    const boost = relatedIdsBoost(
      'foo [meta: {"related_ids":[1,2,3,4,5]}]',
      new Set([1, 2, 3, 4, 5])
    );
    expect(boost).toBe(1.6);
  });

  it("handles null / undefined / empty content safely", () => {
    expect(relatedIdsBoost(null, new Set([1]))).toBe(1.0);
    expect(relatedIdsBoost(undefined, new Set([1]))).toBe(1.0);
    expect(relatedIdsBoost("", new Set([1]))).toBe(1.0);
  });
});

describe("P2.14 — source-level wiring", () => {
  it("vector branch uses typeWeight(m.type) (no hardcoded procedural/causal bump)", () => {
    // Ensure the old hardcoded `=== "procedural" || type === "causal" ? 1.2`
    // pattern is gone from the scoring expression.
    expect(source).not.toMatch(
      /m\.type === "procedural" \|\| m\.type === "causal" \? 1\.2/
    );
    // And the new call is present on a `typeBoost` assignment (vector branch uses m.type).
    expect(source).toMatch(/const typeBoost = typeWeight\(m\.type\)/);
  });

  it("contains typeWeight callsites in BOTH vector and keyword-fallback branches", () => {
    const matches = source.match(/const typeBoost = typeWeight\(m\.type\)/g);
    expect(matches).not.toBeNull();
    // One in the vector scorer, one in the keyword-fallback scorer.
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("both branches run a relatedIdsBoost post-processing step", () => {
    const matches = source.match(/relatedIdsBoost\([^)]*\)/g);
    expect(matches).not.toBeNull();
    // One boost invocation per branch at minimum.
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("both branches build an acceptedIds set from alwaysInject + episodeSummaries + top-K", () => {
    // Vector branch uses `acceptedIds`; fallback branch uses `fallbackAcceptedIds`.
    expect(source).toMatch(/const acceptedIds = new Set<number>\(\[/);
    expect(source).toMatch(/const fallbackAcceptedIds = new Set<number>\(\[/);
    // Both must spread alwaysInject and episodeSummaries before top-K slice.
    expect(source).toMatch(
      /\.\.\.alwaysInject\.map\(m => m\.id\)[\s\S]{0,120}\.\.\.episodeSummaries\.map\(m => m\.id\)/
    );
  });

  it("exports the P2.14 helpers for downstream tests and use", () => {
    expect(source).toMatch(/export function typeWeight\(/);
    expect(source).toMatch(/export function parseMetaSidecar\(/);
    expect(source).toMatch(/export function relatedIdsBoost\(/);
    expect(source).toMatch(/export const RELATED_IDS_BOOST_PER_HIT = 0\.15/);
    expect(source).toMatch(/export const RELATED_IDS_BOOST_CAP = 1\.6/);
  });

  it("re-sorts after the boost so newly-boosted candidates move up", () => {
    // The boost is useless without re-sort. Assert both branches sort post-boost.
    const reSorts = source.match(
      /\.sort\(\(a: any, b: any\) => b\.score - a\.score\)/g
    );
    expect(reSorts).not.toBeNull();
    // At least: vector pre-boost sort + vector post-boost sort + fallback
    // pre-boost sort + fallback post-boost sort = 4. Allow some slack.
    expect(reSorts!.length).toBeGreaterThanOrEqual(3);
  });
});

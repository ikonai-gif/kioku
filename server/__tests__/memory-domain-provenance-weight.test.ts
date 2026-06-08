import { describe, it, expect } from "vitest";
import { provenanceWeight } from "../lib/memory-domain";

// Phase 0.5 — honesty layer ranker. Verifies the two new rules layered on top of
// the existing domain hierarchy: (1) verified=true wins regardless of origin,
// (2) room_decision (unverified) sits above the luca_inferred floor.
const BEHAVIORAL_NS = "_self";       // member of BEHAVIORAL_NS allow-list
const SEMANTIC_NS = null;            // null/unknown → semantic domain

describe("provenanceWeight — Phase 0.5 honesty rules", () => {
  it("verified=true → 1.0 regardless of provenance or domain", () => {
    expect(provenanceWeight("luca_inferred", SEMANTIC_NS, true)).toBe(1.0);
    expect(provenanceWeight("room_decision", "room_decisions", true)).toBe(1.0);
    expect(provenanceWeight("luca_inferred", BEHAVIORAL_NS, true)).toBe(1.0); // verified overrides domain floor
    expect(provenanceWeight("user_told", SEMANTIC_NS, true)).toBe(1.0);
  });

  it("room_decision (unverified) → 0.7, above the luca_inferred floor", () => {
    expect(provenanceWeight("room_decision", "room_decisions", false)).toBe(0.7);
    expect(provenanceWeight("room_decision", "room_decisions")).toBe(0.7);        // verified omitted
    expect(provenanceWeight("room_decision", "room_decisions", false)).toBeGreaterThan(
      provenanceWeight("luca_inferred", "room_decisions", false),
    );
  });

  it("verified room_decision outranks unverified room_decision", () => {
    expect(provenanceWeight("room_decision", "room_decisions", true)).toBeGreaterThan(
      provenanceWeight("room_decision", "room_decisions", false),
    );
  });

  it("REGRESSION: existing semantic weights unchanged when not verified", () => {
    expect(provenanceWeight("user_told", SEMANTIC_NS)).toBe(1.0);
    expect(provenanceWeight("tool_observed", SEMANTIC_NS)).toBe(0.7);
    expect(provenanceWeight("luca_inferred", SEMANTIC_NS)).toBe(0.3);
    expect(provenanceWeight("something_unknown", SEMANTIC_NS)).toBe(0.3);
  });

  it("REGRESSION: existing behavioral weights unchanged when not verified", () => {
    expect(provenanceWeight("tool_observed", BEHAVIORAL_NS)).toBe(1.0);
    expect(provenanceWeight("user_told", BEHAVIORAL_NS)).toBe(0.5);
    expect(provenanceWeight("luca_inferred", BEHAVIORAL_NS)).toBe(0.3);
  });
});

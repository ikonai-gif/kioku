// tests/unit/provenance-supersede.test.ts
// [BRO2-325] 2.1b — provenance hierarchy gate for bi-temporal supersession.
// Pins the locked policy: a NEW fact may close an existing fact only when its
// provenance is at least as strong. The remember() tool path always writes
// 'luca_inferred', so these cases double as the prod-behaviour contract.
import { provenanceStrength, canSupersede, PROVENANCE_STRENGTH } from "@shared/namespaces";

describe("provenanceStrength", () => {
  it("maps the known provenance tiers", () => {
    expect(provenanceStrength("boss_told")).toBe(100);
    expect(provenanceStrength("user_told")).toBe(90);
    expect(provenanceStrength("verified_import")).toBe(80);
    expect(provenanceStrength("tool_observed")).toBe(70);
    expect(provenanceStrength("agent_inferred")).toBe(50);
    expect(provenanceStrength("luca_inferred")).toBe(50);
    expect(provenanceStrength("unknown")).toBe(10);
  });

  it("treats null / undefined / unrecognized as 'unknown' (10)", () => {
    expect(provenanceStrength(null)).toBe(PROVENANCE_STRENGTH.unknown);
    expect(provenanceStrength(undefined)).toBe(PROVENANCE_STRENGTH.unknown);
    expect(provenanceStrength("")).toBe(PROVENANCE_STRENGTH.unknown);
    expect(provenanceStrength("totally_made_up")).toBe(PROVENANCE_STRENGTH.unknown);
  });
});

describe("canSupersede", () => {
  it("allows closing equal-or-weaker provenance", () => {
    expect(canSupersede("luca_inferred", "luca_inferred")).toBe(true); // equal
    expect(canSupersede("luca_inferred", "agent_inferred")).toBe(true); // equal tier
    expect(canSupersede("luca_inferred", "unknown")).toBe(true);
    expect(canSupersede("luca_inferred", null)).toBe(true);
  });

  it("never lets luca_inferred override human-told or observed truth", () => {
    expect(canSupersede("luca_inferred", "user_told")).toBe(false);
    expect(canSupersede("luca_inferred", "boss_told")).toBe(false);
    expect(canSupersede("luca_inferred", "tool_observed")).toBe(false);
    expect(canSupersede("luca_inferred", "verified_import")).toBe(false);
  });

  it("lets stronger provenance supersede weaker", () => {
    expect(canSupersede("boss_told", "user_told")).toBe(true);
    expect(canSupersede("user_told", "luca_inferred")).toBe(true);
    expect(canSupersede("tool_observed", "agent_inferred")).toBe(true);
  });

  it("treats unknown/empty new-provenance as weakest (cannot close real facts)", () => {
    expect(canSupersede(null, "luca_inferred")).toBe(false);
    expect(canSupersede("totally_made_up", "luca_inferred")).toBe(false);
    expect(canSupersede("unknown", "unknown")).toBe(true); // equal weakest
  });
});

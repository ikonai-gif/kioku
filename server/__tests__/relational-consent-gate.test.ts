import { describe, it, expect } from "vitest";
import {
  gateRelationalPiiByConsent,
  isRelationalPiiNamespace,
  RELATIONAL_PII_NAMESPACES,
} from "../lib/relational-consent-gate";

// Phase 1a [BRO2-322 #5] — read-path PII relational consent gate.
describe("relational-consent-gate", () => {
  const rows = [
    { id: 1, namespace: "_identity", type: "identity" },
    { id: 2, namespace: "_relational", type: "relational" },
    { id: 3, namespace: "_relational:kote", type: "relational" },
    { id: 4, namespace: "_relational:nicole", type: "relational" },
    { id: 5, namespace: "_relational:bro2", type: "relational" }, // internal, NOT PII
    { id: 6, namespace: "_relational:boss", type: "relational" }, // internal, NOT PII
    { id: 7, namespace: "_aesthetics", type: "aesthetic" },
    { id: 8, namespace: null, type: "procedural" },
  ];

  it("PII namespace set matches [BRO2-322] FINAL DECISIONS #5", () => {
    expect([...RELATIONAL_PII_NAMESPACES].sort()).toEqual(
      ["_relational", "_relational:kote", "_relational:nicole"].sort(),
    );
  });

  it("isRelationalPiiNamespace: only PII slugs + bare bucket; internal/other excluded", () => {
    expect(isRelationalPiiNamespace("_relational")).toBe(true);
    expect(isRelationalPiiNamespace("_relational:kote")).toBe(true);
    expect(isRelationalPiiNamespace("_relational:nicole")).toBe(true);
    expect(isRelationalPiiNamespace("_relational:bro2")).toBe(false);
    expect(isRelationalPiiNamespace("_relational:boss")).toBe(false);
    expect(isRelationalPiiNamespace("_identity")).toBe(false);
    expect(isRelationalPiiNamespace(null)).toBe(false);
    expect(isRelationalPiiNamespace(undefined)).toBe(false);
  });

  it("consent granted: returns all rows unchanged", () => {
    const out = gateRelationalPiiByConsent(rows, true);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("consent withheld: drops ONLY PII relational; keeps internal + non-relational", () => {
    const out = gateRelationalPiiByConsent(rows, false);
    expect(out.map((r) => r.id)).toEqual([1, 5, 6, 7, 8]);
  });

  it("is pure — does not mutate input", () => {
    const before = rows.length;
    gateRelationalPiiByConsent(rows, false);
    expect(rows.length).toBe(before);
  });
});

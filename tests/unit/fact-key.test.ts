// tests/unit/fact-key.test.ts
// [BRO2-325] fact_key format validation (2.1a).
import { isValidFactKey, FACT_KEY_REGEX } from "@shared/namespaces";

describe("isValidFactKey", () => {
  it("accepts <subject>.<attribute> lowercase keys", () => {
    for (const k of ["kote.hair_color", "luca.provider_model", "ikonbai.production_domain", "boss.priority", "a.b.c"]) {
      expect(isValidFactKey(k)).toBe(true);
    }
  });

  it("rejects keys without a dot", () => {
    expect(isValidFactKey("hair_color")).toBe(false);
    expect(isValidFactKey("kote")).toBe(false);
  });

  it("rejects uppercase, spaces, and stray punctuation", () => {
    expect(isValidFactKey("Kote.HairColor")).toBe(false);
    expect(isValidFactKey("kote.hair color")).toBe(false);
    expect(isValidFactKey("kote.hair-color")).toBe(false);
    expect(isValidFactKey("kote..color")).toBe(false);
    expect(isValidFactKey(".color")).toBe(false);
    expect(isValidFactKey("kote.")).toBe(false);
  });

  it("rejects non-strings / empties", () => {
    expect(isValidFactKey(null)).toBe(false);
    expect(isValidFactKey(undefined)).toBe(false);
    expect(isValidFactKey("")).toBe(false);
    expect(isValidFactKey(123)).toBe(false);
  });

  it("regex is exported and consistent", () => {
    expect(FACT_KEY_REGEX.test("kote.hair_color")).toBe(true);
    expect(FACT_KEY_REGEX.test("nope")).toBe(false);
  });
});

/**
 * [LUCA-098 / SPEC-3b] CRON-2 consolidation gate tests.
 */
import { describe, it, expect } from "vitest";
import { consolidationEnabled } from "../../server/cron/consolidation";

describe("consolidationEnabled", () => {
  it("returns false by default (no env)", () => {
    expect(consolidationEnabled({})).toBe(false);
  });

  it("returns false for explicit false", () => {
    expect(consolidationEnabled({ MEMORY_CONSOLIDATION_ENABLED: "false" })).toBe(false);
  });

  it("returns true only for exact 'true' (case-insensitive, trimmed)", () => {
    expect(consolidationEnabled({ MEMORY_CONSOLIDATION_ENABLED: "true" })).toBe(true);
    expect(consolidationEnabled({ MEMORY_CONSOLIDATION_ENABLED: "TRUE" })).toBe(true);
    expect(consolidationEnabled({ MEMORY_CONSOLIDATION_ENABLED: "  true  " })).toBe(true);
  });

  it("returns false for garbage values", () => {
    expect(consolidationEnabled({ MEMORY_CONSOLIDATION_ENABLED: "1" })).toBe(false);
    expect(consolidationEnabled({ MEMORY_CONSOLIDATION_ENABLED: "yes" })).toBe(false);
  });
});

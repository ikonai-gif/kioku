/**
 * PR cleanup (LUCA-053) — room-detail sub-component strings missed by part A.
 * Pure, deterministic. ru/en parity + the 6 cleanup keys resolve.
 */
import { describe, it, expect } from "vitest";
import { dictionaries } from "@/i18n/dictionaries";
import { translate } from "@/i18n/core";

describe("i18n room-detail cleanup keys", () => {
  it("ru and en have identical key sets", () => {
    expect(Object.keys(dictionaries.ru).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });
  it("cleanup keys resolve in both languages", () => {
    const keys = [
      "roomDetail.errorBadge", "roomDetail.changedMind",
      "roomDetail.consensusConfidence", "roomDetail.overallDecision",
      "roomDetail.dissentingOpinions", "roomDetail.deliberationHistory",
      "roomDetail.human",
    ];
    for (const k of keys) {
      expect(translate("ru", k)).not.toBe(`[${k}]`);
      expect(translate("en", k)).not.toBe(`[${k}]`);
    }
  });
});

/**
 * PR-B2.2 (LUCA-053) — memory screen i18n keys. Pure, deterministic.
 * Asserts ru/en key parity and that memory.* keys resolve in both languages.
 */
import { describe, it, expect } from "vitest";
import { dictionaries } from "@/i18n/dictionaries";
import { translate } from "@/i18n/core";

describe("i18n memory keys", () => {
  it("ru and en have identical key sets", () => {
    expect(Object.keys(dictionaries.ru).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });
  it("memory.* keys resolve in both languages", () => {
    const keys = [
      "memory.title", "memory.searchPlaceholder", "memory.empty",
      "memory.addTitle", "memory.content", "memory.saveMemory",
      "memory.importance", "memory.contextTriggerPlaceholder",
    ];
    for (const k of keys) {
      expect(translate("ru", k)).not.toBe(`[${k}]`);
      expect(translate("en", k)).not.toBe(`[${k}]`);
    }
  });
});

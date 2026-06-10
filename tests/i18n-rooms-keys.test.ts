/**
 * PR-B2.3 (LUCA-053) — rooms screen i18n keys. Pure, deterministic.
 */
import { describe, it, expect } from "vitest";
import { dictionaries } from "@/i18n/dictionaries";
import { translate } from "@/i18n/core";

describe("i18n rooms keys", () => {
  it("ru and en have identical key sets", () => {
    expect(Object.keys(dictionaries.ru).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });
  it("rooms.* keys resolve in both languages", () => {
    const keys = [
      "rooms.title", "rooms.subtitle", "rooms.newRoom", "rooms.empty",
      "rooms.status.active", "rooms.status.standby", "rooms.status.idle",
      "rooms.dialogTitle", "rooms.createRoom", "rooms.purposePlaceholder",
    ];
    for (const k of keys) {
      expect(translate("ru", k)).not.toBe(`[${k}]`);
      expect(translate("en", k)).not.toBe(`[${k}]`);
    }
  });
});

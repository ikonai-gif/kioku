/**
 * PR-B2.1 (LUCA-053) — connectors + common i18n keys.
 * Asserts ru/en parity (no missing key in either language) and that the
 * connectors/common namespaces resolve (BRO4/BRO5: ru+en filled, namespaced).
 */
import { describe, it, expect } from "vitest";
import { dictionaries } from "@/i18n/dictionaries";
import { translate } from "@/i18n/core";

describe("i18n connectors/common keys", () => {
  it("ru and en have identical key sets", () => {
    const ru = Object.keys(dictionaries.ru).sort();
    const en = Object.keys(dictionaries.en).sort();
    expect(ru).toEqual(en);
  });

  it("connectors + common keys resolve in both languages", () => {
    const keys = [
      "connectors.title", "connectors.intro", "connectors.connectGmail",
      "connectors.statusConnected", "connectors.desc.google_drive",
      "common.disconnect", "common.connect", "common.cancel",
    ];
    for (const k of keys) {
      expect(translate("ru", k)).not.toBe(`[${k}]`);
      expect(translate("en", k)).not.toBe(`[${k}]`);
    }
  });
});

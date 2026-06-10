/**
 * PR-B1 (LUCA-053) — i18n core helpers. Pure, deterministic.
 * Verifies namespaced lookups (BRO4 M1), [key] fallback (BRO4 M2),
 * and initial-language resolution (stored -> browser -> ru).
 */
import { describe, it, expect } from "vitest";
import { translate, resolveInitialLang } from "@/i18n/core";

describe("translate", () => {
  it("returns ru/en strings for known namespaced keys", () => {
    expect(translate("ru", "chat.send")).toBe("Отправить");
    expect(translate("en", "chat.send")).toBe("Send");
  });
  it("falls back to [key] for missing keys (never empty)", () => {
    expect(translate("ru", "chat.does.not.exist")).toBe("[chat.does.not.exist]");
    expect(translate("en", "nope")).toBe("[nope]");
  });
});

describe("resolveInitialLang", () => {
  it("respects stored value", () => {
    expect(resolveInitialLang("en")).toBe("en");
    expect(resolveInitialLang("ru")).toBe("ru");
  });
  it("uses browser language when nothing stored", () => {
    expect(resolveInitialLang(null, "en-US")).toBe("en");
    expect(resolveInitialLang(null, "ru-RU")).toBe("ru");
  });
  it("defaults to ru for unknown/empty", () => {
    expect(resolveInitialLang(null)).toBe("ru");
    expect(resolveInitialLang("garbage", "fr-FR")).toBe("ru");
  });
});

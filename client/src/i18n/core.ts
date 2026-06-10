/**
 * Pure i18n helpers (PR-B1, LUCA-053). No React/DOM — testable in node.
 */
import { dictionaries, type Lang } from "./dictionaries";

export const LANG_KEY = "kioku-lang";
export const LANGS: Lang[] = ["ru", "en"];

/** Translate a namespaced key. Missing -> [key] (BRO4 M2: visible, never ''). */
export function translate(lang: Lang, key: string): string {
  const dict = dictionaries[lang] ?? {};
  const v = dict[key];
  return typeof v === "string" ? v : `[${key}]`;
}

/** Resolve initial language: stored -> browser -> ru default. */
export function resolveInitialLang(stored: string | null, browserLang?: string): Lang {
  if (stored === "ru" || stored === "en") return stored;
  if (browserLang && browserLang.toLowerCase().startsWith("en")) return "en";
  return "ru";
}

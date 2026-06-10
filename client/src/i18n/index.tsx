import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { type Lang } from "./dictionaries";
import { translate, resolveInitialLang, LANG_KEY } from "./core";

interface I18nCtx { lang: Lang; setLang: (l: Lang) => void; t: (key: string) => string; }

const I18nContext = createContext<I18nCtx>({ lang: "ru", setLang: () => {}, t: (k) => `[${k}]` });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      return resolveInitialLang(localStorage.getItem(LANG_KEY), navigator?.language);
    } catch { return "ru"; }
  });
  useEffect(() => {
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
    try { document.documentElement.setAttribute("lang", lang); } catch { /* ignore */ }
  }, [lang]);
  const value: I18nCtx = { lang, setLang: setLangState, t: (key) => translate(lang, key) };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }
export type { Lang };

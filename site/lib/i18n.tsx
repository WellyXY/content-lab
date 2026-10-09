"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "content-lab-lang";

type LocaleValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Pick the text for the current language: t("简体中文", "English"). */
  t: (zh: string, en: string) => string;
  /** Read `${field}_zh` / `${field}_en` from Agent output, falling back to Chinese when English is missing. */
  pick: (item: object | null | undefined, field: string) => string;
};

const LocaleContext = createContext<LocaleValue>({
  lang: "zh",
  setLang: () => undefined,
  t: (zh) => zh,
  pick: (item, field) => String((item as Record<string, unknown> | null | undefined)?.[`${field}_zh`] ?? ""),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("zh");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "zh" || saved === "en") setLangState(saved);
    } catch {
      // Storage can be unavailable (private windows); Chinese stays the default.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* keep the choice for this visit only */ }
  }, []);

  const value = useMemo<LocaleValue>(() => ({
    lang,
    setLang,
    t: (zh, en) => (lang === "zh" ? zh : en),
    pick: (item, field) => {
      const record = item as Record<string, unknown> | null | undefined;
      const preferred = record?.[`${field}_${lang}`];
      if (typeof preferred === "string" && preferred.trim()) return preferred;
      const fallback = record?.[`${field}_zh`];
      return typeof fallback === "string" ? fallback : "";
    },
  }), [lang, setLang]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  return useContext(LocaleContext);
}

/** 中文 / EN switch for the header. */
export function LanguageSwitch() {
  const { lang, setLang } = useLocale();
  return (
    <div aria-label="Language" className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs" role="group">
      {(["zh", "en"] as const).map((option) => (
        <button
          aria-pressed={lang === option}
          className={`rounded-md px-2.5 py-1 transition-colors ${lang === option ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
          key={option}
          onClick={() => setLang(option)}
          type="button"
        >
          {option === "zh" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}

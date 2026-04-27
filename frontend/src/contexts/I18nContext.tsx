import React, { createContext, useContext, useState, ReactNode } from "react";
import fr from "../locales/fr";
import en from "../locales/en";

type Lang = "fr" | "en";
type Translations = typeof fr;

const translations: Record<Lang, Translations> = { fr, en };

interface I18nContextType {
  lang: Lang;
  setLanguage: (l: Lang) => void;
  t: (key: keyof Translations) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: "fr",
  setLanguage: () => {},
  t: (key) => key as string,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const stored = localStorage.getItem("language");
    return (stored === "en" ? "en" : "fr") as Lang;
  });

  function setLanguage(l: Lang) {
    setLang(l);
    localStorage.setItem("language", l);
  }

  function t(key: keyof Translations): string {
    return translations[lang][key] as string || key as string;
  }

  return (
    <I18nContext.Provider value={{ lang, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

import React from "react";
import { useI18n } from "../contexts/I18nContext";

export default function LanguageSwitcher({ className = "", dark = false, compact = false }: { className?: string; dark?: boolean; compact?: boolean }) {
  const { lang, setLanguage } = useI18n();

  if (compact) {
    const next = lang === "fr" ? "en" : "fr";
    return (
      <button
        onClick={() => setLanguage(next)}
        title={next === "en" ? "Switch to English" : "Passer en français"}
        className={`w-9 h-9 rounded-lg text-xs font-bold transition-all flex items-center justify-center ${dark ? "bg-white/15 text-white hover:bg-white/25" : "bg-gray-100 text-gray-700 hover:bg-gray-200"} ${className}`}
      >
        {lang.toUpperCase()}
      </button>
    );
  }

  return (
    <div className={`flex items-center p-0.5 rounded-lg ${dark ? "bg-white/10" : "bg-gray-100"} ${className}`}>
      <button
        onClick={() => setLanguage("fr")}
        className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
          lang === "fr"
            ? dark ? "bg-white/25 text-white shadow-sm" : "bg-white text-gray-800 shadow-sm"
            : dark ? "text-white/45 hover:text-white/70" : "text-gray-400 hover:text-gray-600"
        }`}
        title="Français"
      >
        FR
      </button>
      <button
        onClick={() => setLanguage("en")}
        className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
          lang === "en"
            ? dark ? "bg-white/25 text-white shadow-sm" : "bg-white text-gray-800 shadow-sm"
            : dark ? "text-white/45 hover:text-white/70" : "text-gray-400 hover:text-gray-600"
        }`}
        title="English"
      >
        EN
      </button>
    </div>
  );
}

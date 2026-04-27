import React from "react";
import { useI18n } from "../contexts/I18nContext";

export default function LanguageSwitcher({ className = "", dark = false }: { className?: string; dark?: boolean }) {
  const { lang, setLanguage } = useI18n();

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

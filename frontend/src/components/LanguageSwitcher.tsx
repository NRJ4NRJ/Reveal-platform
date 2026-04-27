import React from "react";
import { useI18n } from "../contexts/I18nContext";

export default function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { lang, setLanguage } = useI18n();

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        onClick={() => setLanguage("fr")}
        className={`flex items-center gap-1 px-2 py-1 rounded text-sm transition-colors ${lang === "fr" ? "bg-gray-200 font-semibold" : "hover:bg-gray-100 text-gray-500"}`}
        title="Français"
      >
        🇫🇷 FR
      </button>
      <button
        onClick={() => setLanguage("en")}
        className={`flex items-center gap-1 px-2 py-1 rounded text-sm transition-colors ${lang === "en" ? "bg-gray-200 font-semibold" : "hover:bg-gray-100 text-gray-500"}`}
        title="English"
      >
        🇬🇧 EN
      </button>
    </div>
  );
}

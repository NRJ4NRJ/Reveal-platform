"use client";

import { useTranslation } from "@/lib/i18n";

export function LanguageToggle() {
  const { lang, setLang } = useTranslation();
  const options = ["en", "fr", "de"] as const;

  return (
    <div className="segmented-control flex rounded-xl border border-header overflow-hidden bg-row p-1 text-xs transition-colors duration-200">
      {options.map((option) => (
        <button
          key={option}
          onClick={() => setLang(option)}
          className={`segmented-control-button rounded-lg px-3 py-1.5 font-semibold transition-colors ${
            lang === option ? "segmented-control-button-active bg-orange-DEFAULT text-white" : "text-nav-active"
          }`}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

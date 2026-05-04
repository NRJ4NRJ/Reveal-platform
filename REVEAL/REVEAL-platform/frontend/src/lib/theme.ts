"use client";

import { createContext, createElement, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "dark" | "light";

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
}>({
  theme: "dark",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  // Read saved preference on mount
  useEffect(() => {
    const saved = window.localStorage.getItem("reveal_theme");
    if (saved === "dark" || saved === "light") {
      setThemeState(saved);
    }
  }, []);

  // Apply theme attribute to <html> and persist
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("reveal_theme", theme);
  }, [theme]);

  function setTheme(t: Theme) {
    setThemeState(t);
  }

  return createElement(ThemeContext.Provider, { value: { theme, setTheme } }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}

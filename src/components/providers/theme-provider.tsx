"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { t } from "@/lib/i18n";

/**
 * Colour theme provider.
 *
 * The scheme is set on <html> before paint by an inline script in the layout, so
 * this provider only mirrors and mutates it. Storing the choice in localStorage
 * keeps the decision local to the device, matching the "nothing on disk
 * server-side" promise in the UI copy.
 */

type Theme = "light" | "dark";

interface ThemeContextValue {
  readonly theme: Theme;
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "ragdoll-theme";

const readDomTheme = (): Theme =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(readDomTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private-mode storage failures must not break the toggle.
      }
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }
  return context;
};

export const themeToggleLabel = (theme: Theme): string =>
  theme === "dark" ? t("nav.themeLight") : t("nav.themeDark");

/** Inline script that applies the stored theme before the first paint. */
export const themeBootstrapScript = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(s==='dark'||(!s&&d)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

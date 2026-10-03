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
 *
 * **Light is the default, and the operating system does not override it.** A dark
 * OS preference used to decide the first visit, which meant most users met a dark
 * app they had not asked for; dark is now opt-in through the toggle.
 */

type Theme = "light" | "dark";

interface ThemeContextValue {
  readonly theme: Theme;
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Where the choice is remembered.
 *
 * Versioned on purpose. The key this replaced held `"dark"` for anyone whose
 * operating system preferred dark — the app wrote it as the default, not as a
 * choice — so those devices would have stayed dark after light became the default.
 * Abandoning the old key gives every browser the new default exactly once, while
 * still remembering what the toggle does from here on.
 */
const STORAGE_KEY = "ragdoll-theme-v2";

/** Browser chrome colour per theme; mirrors `viewport.themeColor` in the layout. */
const THEME_COLOR: Readonly<Record<Theme, string>> = {
  light: "#fdf0df",
  dark: "#094454",
};

const readDomTheme = (): Theme =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";

/**
 * Applies a theme to the document.
 *
 * The `<meta name="theme-color">` is repainted too: it is a single tag rather than a
 * pair of media queries, because the app theme no longer follows the OS, so a
 * media-driven tag would colour the browser chrome for the wrong scheme.
 */
const applyTheme = (theme: Theme): void => {
  document.documentElement.classList.toggle("dark", theme === "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", THEME_COLOR[theme]);
};

export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(readDomTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      applyTheme(next);
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

/**
 * Inline script that applies the stored theme before the first paint.
 *
 * Only an explicit stored choice turns dark on: absent one, the app renders light
 * whatever `prefers-color-scheme` says.
 */
export const themeBootstrapScript = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var dark=s==='dark';if(dark){document.documentElement.classList.add('dark');}var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content',dark?'${THEME_COLOR.dark}':'${THEME_COLOR.light}');}}catch(e){}})();`;

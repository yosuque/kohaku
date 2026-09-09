import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { ThemeMode } from "./tokens.js";

const STORAGE_KEY = "kohaku-sample.theme";

interface ThemeModeValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const ThemeModeContext = createContext<ThemeModeValue | null>(null);

/** Initial mode: an explicit choice in localStorage takes top priority; otherwise it follows the OS prefers-color-scheme. */
function initialMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * The theme mode referenced by both the page chrome (header, cards, background, etc.) and the Spec render theme.
 * Reflects data-theme onto documentElement (switching app-theme.css's --app-* / color-scheme),
 * and persists an explicit choice to localStorage. SpecSurface reads mode from here and passes it to buildTheme.
 */
export function ThemeModeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);

  // Reflect <html data-theme> before paint to suppress the initial flash.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  // toggle delegates to setMode to funnel persistence through a single path (only setMode holds localStorage.setItem).
  const toggle = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  const value = useMemo<ThemeModeValue>(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);
  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeValue {
  const ctx = useContext(ThemeModeContext);
  if (ctx == null) throw new Error("useThemeMode must be used inside ThemeModeProvider");
  return ctx;
}

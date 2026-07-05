/**
 * useTheme.ts
 *
 * Studio dark-mode theme hook (issue #94).
 *
 * Manages three modes:
 *   - "light"  — always light, regardless of OS preference.
 *   - "dark"   — always dark, regardless of OS preference.
 *   - "system" — follows `window.matchMedia("(prefers-color-scheme: dark)")`.
 *
 * Behaviour:
 *   - The chosen mode is persisted to `localStorage` under `THEME_STORAGE_KEY`.
 *   - On first load, the persisted mode is read; if absent (or invalid), the
 *     mode defaults to "system".
 *   - The EFFECTIVE theme ("light" | "dark") is computed by resolving "system"
 *     via `matchMedia`, and is written as `data-theme` on
 *     `document.documentElement` so `theme/tokens.css` can switch its CSS
 *     custom properties.
 *   - While `mode === "system"`, a `matchMedia` change listener keeps the
 *     effective theme (and `data-theme`) in sync with OS-level changes, and is
 *     cleaned up on unmount / mode change.
 */

import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

/** localStorage key the chosen theme mode is persisted under. */
export const THEME_STORAGE_KEY = "redeploy-studio-theme";

const VALID_MODES: ThemeMode[] = ["light", "dark", "system"];

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (VALID_MODES as string[]).includes(value);
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolves a `ThemeMode` to the concrete "light" | "dark" theme to apply. */
function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark() ? "dark" : "light";
}

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "system";
  } catch {
    // localStorage may be unavailable (e.g. privacy mode) — fall back safely.
    return "system";
  }
}

export interface UseThemeResult {
  /** The user's chosen mode: "light" | "dark" | "system". */
  mode: ThemeMode;
  /** The resolved theme actually applied ("system" is never returned here). */
  effectiveTheme: EffectiveTheme;
  /** Sets the mode and persists it to localStorage. */
  setMode: (mode: ThemeMode) => void;
}

export function useTheme(): UseThemeResult {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() =>
    resolveEffectiveTheme(readStoredMode()),
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures (e.g. storage disabled) — the in-memory
      // mode still takes effect for the current session.
    }
  }, []);

  // Apply the effective theme to document.documentElement whenever mode
  // changes, and — while mode === "system" — keep it tracking live OS changes.
  useEffect(() => {
    const applyTheme = (theme: EffectiveTheme) => {
      setEffectiveTheme(theme);
      document.documentElement.setAttribute("data-theme", theme);
    };

    applyTheme(resolveEffectiveTheme(mode));

    if (mode !== "system") {
      return undefined;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      applyTheme(mql.matches ? "dark" : "light");
    };

    mql.addEventListener("change", handleChange);
    return () => {
      mql.removeEventListener("change", handleChange);
    };
  }, [mode]);

  return { mode, effectiveTheme, setMode };
}

export default useTheme;

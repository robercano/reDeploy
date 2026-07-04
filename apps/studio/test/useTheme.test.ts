/**
 * useTheme.test.ts
 *
 * Tests for the studio dark-mode theme hook (issue #94):
 *   - default mode is "system" when localStorage is empty
 *   - reads a persisted mode from localStorage on first load
 *   - setMode persists the new mode to localStorage
 *   - effective theme resolves "system" via matchMedia
 *   - data-theme is written to document.documentElement
 *   - "system" mode tracks live OS matchMedia changes
 *   - the matchMedia change listener is cleaned up on unmount / mode change
 *
 * jsdom does not implement `window.matchMedia`, so each test installs a
 * minimal mock supporting `matches`, `addEventListener("change", ...)`, and
 * `removeEventListener("change", ...)` — enough for useTheme's usage.
 */

import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { useTheme, THEME_STORAGE_KEY } from "../src/theme/useTheme.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

// ---------------------------------------------------------------------------
// matchMedia mock helper
// ---------------------------------------------------------------------------

interface MatchMediaMock {
  mql: MediaQueryList;
  setMatches: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMediaMock(initialMatches: boolean): MatchMediaMock {
  let matches = initialMatches;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();

  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (event: string, cb: (e: MediaQueryListEvent) => void) => {
      if (event === "change") listeners.add(cb);
    },
    removeEventListener: (event: string, cb: (e: MediaQueryListEvent) => void) => {
      if (event === "change") listeners.delete(cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  } as unknown as MediaQueryList;

  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue(mql),
  );

  return {
    mql,
    setMatches: (next: boolean) => {
      matches = next;
      listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
    },
    listenerCount: () => listeners.size,
  };
}

// ---------------------------------------------------------------------------
// Defaults / persistence
// ---------------------------------------------------------------------------

describe("useTheme — mode defaults and persistence", () => {
  it("defaults to 'system' when localStorage is empty", () => {
    installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");
  });

  it("reads a persisted mode from localStorage on first load", () => {
    installMatchMediaMock(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("dark");
    expect(result.current.effectiveTheme).toBe("dark");
  });

  it("ignores an invalid persisted value and falls back to 'system'", () => {
    installMatchMediaMock(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "not-a-real-mode");
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");
  });

  it("setMode updates the mode and persists it to localStorage", () => {
    installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setMode("dark");
    });

    expect(result.current.mode).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      result.current.setMode("light");
    });

    expect(result.current.mode).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });
});

// ---------------------------------------------------------------------------
// Effective theme resolution + data-theme attribute
// ---------------------------------------------------------------------------

describe("useTheme — effective theme resolution", () => {
  it("resolves 'system' to 'dark' when matchMedia reports a dark OS preference", () => {
    installMatchMediaMock(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");
    expect(result.current.effectiveTheme).toBe("dark");
  });

  it("resolves 'system' to 'light' when matchMedia reports a light OS preference", () => {
    installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.effectiveTheme).toBe("light");
  });

  it("mode='light' always resolves to 'light' regardless of OS preference", () => {
    installMatchMediaMock(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.effectiveTheme).toBe("light");
  });

  it("mode='dark' always resolves to 'dark' regardless of OS preference", () => {
    installMatchMediaMock(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.effectiveTheme).toBe("dark");
  });

  it("writes the effective theme as data-theme on document.documentElement", () => {
    installMatchMediaMock(true);
    renderHook(() => useTheme());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("updates data-theme when setMode changes the effective theme", () => {
    installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    act(() => {
      result.current.setMode("dark");
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// Live OS theme tracking (mode === "system")
// ---------------------------------------------------------------------------

describe("useTheme — live system theme tracking", () => {
  it("updates the effective theme when the OS preference changes while mode is 'system'", () => {
    const mm = installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.effectiveTheme).toBe("light");

    act(() => {
      mm.setMatches(true);
    });

    expect(result.current.effectiveTheme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("does NOT track OS changes when mode is explicitly 'light' or 'dark'", () => {
    const mm = installMatchMediaMock(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.effectiveTheme).toBe("light");

    act(() => {
      mm.setMatches(true);
    });

    // Still "light" — the OS-change listener is only attached in "system" mode.
    expect(result.current.effectiveTheme).toBe("light");
  });

  it("registers exactly one matchMedia change listener while mode is 'system'", () => {
    const mm = installMatchMediaMock(false);
    renderHook(() => useTheme());
    expect(mm.listenerCount()).toBe(1);
  });

  it("cleans up the matchMedia change listener on unmount", () => {
    const mm = installMatchMediaMock(false);
    const { unmount } = renderHook(() => useTheme());
    expect(mm.listenerCount()).toBe(1);

    unmount();

    expect(mm.listenerCount()).toBe(0);
  });

  it("removes the system listener when switching mode away from 'system'", () => {
    const mm = installMatchMediaMock(false);
    const { result } = renderHook(() => useTheme());
    expect(mm.listenerCount()).toBe(1);

    act(() => {
      result.current.setMode("dark");
    });

    expect(mm.listenerCount()).toBe(0);
  });
});

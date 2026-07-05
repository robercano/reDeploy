/**
 * ThemeToggle.test.tsx
 *
 * Tests for the three-way light / dark / system theme control (issue #94).
 * ThemeToggle is a controlled component (mode + onChange props), so these
 * tests exercise it directly without needing to mock matchMedia/localStorage
 * (that's covered by useTheme.test.ts).
 */

import { useState } from "react";
import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ThemeToggle } from "../src/components/ThemeToggle.js";
import type { ThemeMode } from "../src/theme/useTheme.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThemeToggle — rendering", () => {
  it("renders all three mode options", () => {
    render(<ThemeToggle mode="system" onChange={() => {}} />);
    const group = screen.getByTestId("theme-toggle");
    const q = within(group);

    expect(q.getByTestId("theme-toggle-light")).not.toBeNull();
    expect(q.getByTestId("theme-toggle-dark")).not.toBeNull();
    expect(q.getByTestId("theme-toggle-system")).not.toBeNull();
  });

  it("marks the currently active mode with aria-pressed=true and the others false", () => {
    render(<ThemeToggle mode="dark" onChange={() => {}} />);

    expect(screen.getByTestId("theme-toggle-dark").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-toggle-light").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("theme-toggle-system").getAttribute("aria-pressed")).toBe("false");
  });

  it("exposes an accessible group label", () => {
    render(<ThemeToggle mode="light" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Theme" })).not.toBeNull();
  });
});

describe("ThemeToggle — interaction", () => {
  it("calls onChange with the clicked mode", () => {
    const onChange = vi.fn();
    render(<ThemeToggle mode="system" onChange={onChange} />);

    fireEvent.click(screen.getByTestId("theme-toggle-dark"));
    expect(onChange).toHaveBeenCalledWith("dark");

    fireEvent.click(screen.getByTestId("theme-toggle-light"));
    expect(onChange).toHaveBeenCalledWith("light");

    fireEvent.click(screen.getByTestId("theme-toggle-system"));
    expect(onChange).toHaveBeenCalledWith("system");

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("re-renders with the new active mode when the parent updates the `mode` prop (simulating a real useTheme consumer)", () => {
    function Wrapper() {
      const [mode, setMode] = useState<ThemeMode>("system");
      return <ThemeToggle mode={mode} onChange={setMode} />;
    }

    render(<Wrapper />);
    expect(screen.getByTestId("theme-toggle-system").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("theme-toggle-dark"));

    expect(screen.getByTestId("theme-toggle-dark").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-toggle-system").getAttribute("aria-pressed")).toBe("false");
  });
});

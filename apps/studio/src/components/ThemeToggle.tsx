/**
 * ThemeToggle.tsx
 *
 * Three-way light / dark / system theme control rendered in the app chrome
 * (issue #94). Controlled by the parent (App.tsx) so there is a single
 * source of truth for the current mode — the parent owns the `useTheme()`
 * hook instance and passes `mode` + `onChange` down, rather than this
 * component calling `useTheme()` itself (which would create a second,
 * independently-updating hook instance and risk desyncing the ReactFlow
 * `colorMode` prop from the toggle's own displayed state).
 */

import type { ThemeMode } from "../theme/useTheme.js";

export interface ThemeToggleProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
};

const optionBtnStyle: React.CSSProperties = {
  padding: "6px 10px",
  cursor: "pointer",
  borderRadius: 4,
  fontSize: 13,
  border: "1px solid var(--color-border-strong)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text)",
  boxShadow: "var(--shadow-md)",
};

const activeOptionBtnStyle: React.CSSProperties = {
  ...optionBtnStyle,
  background: "var(--color-primary)",
  color: "var(--color-text-on-accent)",
  border: "1px solid var(--color-primary-border)",
};

const OPTIONS: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: "light", label: "Light", icon: "☀" },
  { mode: "dark", label: "Dark", icon: "☾" },
  { mode: "system", label: "System", icon: "⚙" },
];

export function ThemeToggle({ mode, onChange }: ThemeToggleProps) {
  return (
    <div style={containerStyle} data-testid="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((opt) => (
        <button
          key={opt.mode}
          type="button"
          style={mode === opt.mode ? activeOptionBtnStyle : optionBtnStyle}
          onClick={() => onChange(opt.mode)}
          aria-pressed={mode === opt.mode}
          data-testid={`theme-toggle-${opt.mode}`}
          title={`${opt.label} theme`}
        >
          {opt.icon} {opt.label}
        </button>
      ))}
    </div>
  );
}

export default ThemeToggle;

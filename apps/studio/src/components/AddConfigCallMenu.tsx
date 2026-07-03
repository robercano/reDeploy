/**
 * AddConfigCallMenu.tsx
 *
 * Shared "Add config call" picker used by both the per-node inline config
 * section (ContractNode.tsx) and the side-panel config editor
 * (ConfigPanel.tsx).
 *
 * Replaces the old pair of always-visible "+ setX" / "+ grantRole" buttons
 * with a single "Add config call" trigger button that reveals an accessible
 * menu listing exactly the two supported config-call kinds. Selecting an
 * option invokes the caller-supplied `onSelect` with the same kind argument
 * the old per-kind buttons used to pass — all downstream behavior (add-step
 * handler, resulting step card, etc.) is unchanged.
 *
 * Accessibility: the trigger is a real `<button>` with
 * `aria-haspopup="menu"` / `aria-expanded`, and the revealed options are
 * rendered as `role="menu"` / `role="menuitem"` buttons so RTL / axe can
 * query them naturally (via role + accessible name), independent of the
 * `data-testid`s also provided for convenience.
 */

import { useState } from "react";

export type ConfigCallKind = "setX" | "grantRole";

interface ConfigCallOption {
  kind: ConfigCallKind;
  label: string;
}

/** The exactly-two supported config-call kinds. Keep in sync with StudioConfigStep. */
const CONFIG_CALL_OPTIONS: ConfigCallOption[] = [
  { kind: "setX", label: "setX" },
  { kind: "grantRole", label: "grantRole" },
];

export interface AddConfigCallMenuProps {
  /** Invoked with the selected kind — same signature as the old per-kind onClick handlers. */
  onSelect: (kind: ConfigCallKind) => void;
  /**
   * Prefix used to build stable, unique `data-testid`s for the trigger button,
   * the menu container, and each option (e.g. `node-add-config-call-${nodeId}`).
   */
  idPrefix: string;
  buttonStyle?: React.CSSProperties;
  menuStyle?: React.CSSProperties;
  itemStyle?: React.CSSProperties;
}

const defaultMenuStyle: React.CSSProperties = {
  position: "absolute",
  zIndex: 20,
  background: "#fff",
  border: "1px solid #ccc",
  borderRadius: 3,
  marginTop: 2,
  minWidth: 110,
  boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
};

const defaultItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "4px 8px",
  fontSize: 11,
  border: "none",
  background: "none",
  cursor: "pointer",
};

export function AddConfigCallMenu({ onSelect, idPrefix, buttonStyle, menuStyle, itemStyle }: AddConfigCallMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = `${idPrefix}-menu`;

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        style={buttonStyle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        data-testid={`${idPrefix}-btn`}
      >
        Add config call
      </button>
      {open && (
        <div role="menu" id={menuId} style={{ ...defaultMenuStyle, ...menuStyle }} data-testid={`${idPrefix}-menu`}>
          {CONFIG_CALL_OPTIONS.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              role="menuitem"
              style={{ ...defaultItemStyle, ...itemStyle }}
              onClick={() => {
                onSelect(opt.kind);
                setOpen(false);
              }}
              data-testid={`${idPrefix}-option-${opt.kind}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default AddConfigCallMenu;

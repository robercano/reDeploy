/**
 * AddConfigCallMenu.tsx
 *
 * Shared "Add config call" picker used by both the per-node inline config
 * section (ContractNode.tsx) and the side-panel config editor
 * (ConfigPanel.tsx).
 *
 * Owner feedback (issue #85/#89): the picker used to list two SYNTHETIC
 * options ("setX" / "grantRole") that had nothing to do with the target
 * contract's actual ABI. It now lists the target contract's REAL
 * state-changing (nonpayable/payable) functions — see
 * `getStateChangingFunctions` in manifest/index.ts — labeled by their
 * canonical signature (e.g. `mint(address,uint256)`), so overloads are
 * unambiguous. `grantRole` is no longer special-cased: it simply appears
 * here like any other function when the target contract's ABI declares it
 * (e.g. AccessControl-based contracts).
 *
 * Selecting an option invokes the caller-supplied `onSelect` with the full
 * `ManifestFunction` entry (name + signature + inputs) so the caller can
 * build a setX config-call step with one arg slot pre-populated per real
 * parameter.
 *
 * Contracts absent from the manifest (free-text fallback) have no known
 * functions — callers pass an empty `functions` array and the menu renders
 * a "No functions available" empty state instead of crashing.
 *
 * Accessibility: the trigger is a real `<button>` with
 * `aria-haspopup="menu"` / `aria-expanded`, and the revealed options are
 * rendered as `role="menu"` / `role="menuitem"` buttons so RTL / axe can
 * query them naturally (via role + accessible name), independent of the
 * `data-testid`s also provided for convenience.
 */

import { useState } from "react";
import type { ManifestFunction } from "../manifest/types.js";

export interface AddConfigCallMenuProps {
  /**
   * The target contract's real state-changing functions to list, already
   * filtered to nonpayable/payable and deduped by signature (see
   * `getStateChangingFunctions`). An empty array renders a "No functions
   * available" empty state instead of a menu item list.
   */
  functions: ManifestFunction[];
  /** Invoked with the selected function's full manifest entry. */
  onSelect: (fn: ManifestFunction) => void;
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

const emptyStateStyle: React.CSSProperties = {
  ...defaultItemStyle,
  cursor: "default",
  color: "#999",
  fontStyle: "italic",
};

export function AddConfigCallMenu({ functions, onSelect, idPrefix, buttonStyle, menuStyle, itemStyle }: AddConfigCallMenuProps) {
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
          {functions.length === 0 ? (
            <div style={{ ...emptyStateStyle, ...itemStyle }} data-testid={`${idPrefix}-empty`}>
              No functions available
            </div>
          ) : (
            functions.map((fn) => (
              <button
                key={fn.signature}
                type="button"
                role="menuitem"
                style={{ ...defaultItemStyle, ...itemStyle }}
                onClick={() => {
                  onSelect(fn);
                  setOpen(false);
                }}
                data-testid={`${idPrefix}-option-${fn.signature}`}
              >
                {fn.signature}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default AddConfigCallMenu;

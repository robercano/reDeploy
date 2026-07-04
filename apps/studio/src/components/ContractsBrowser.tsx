/**
 * ContractsBrowser.tsx
 *
 * Left-sidebar panel for browsing and searching compiled contracts from the
 * manifest. Supports:
 * - Add-to-canvas on click via the optional `onAddContract` prop.
 * - Drag-to-canvas: each row is draggable; dragStart sets the dataTransfer key
 *   "application/redeploy-contract" to the contract's unique id
 *   (`sourcePath::name`). App.tsx reads this on drop and looks up the manifest.
 * - Tap-to-add fallback (issue #90): HTML5 drag-and-drop (`draggable` +
 *   dragstart/drop) never fires from touch input on mobile browsers, so each
 *   row also tracks touchstart/touchend directly. A touchend that ends close
 *   to where the touch started (i.e. not a scroll/drag gesture) is treated as
 *   a tap and calls the SAME `onAddContract` callback used by click, via
 *   `preventDefault()` on the touchend to suppress the browser's synthesized
 *   click that would otherwise follow (avoiding a double-add). The caller
 *   (App.tsx) positions the resulting node at the canvas center with a small
 *   cascade offset — see AuthoringCanvas.handleTapAddContract.
 *
 * ## View modes
 * - Flat: all contracts sorted alphabetically by name, filtered by search.
 * - Folders: contracts grouped by packageSegments into a collapsible tree,
 *   filtered by search. Empty folders (all children filtered out) are hidden.
 *
 * ## Search
 * A search input (always visible) filters contracts by case-insensitive
 * substring match on name in both Flat and Folders modes.
 *
 * ## Constructor signature
 * Selecting a row shows the constructor signature built from constructorArgs,
 * e.g. `constructor(uint256 amount, address owner)` or `constructor()`.
 */

import { useRef, useState } from "react";
import { contractManifest } from "../manifest/index.js";
import type { ContractManifest } from "../manifest/types.js";

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface ContractsBrowserProps {
  /** Contracts to display. Defaults to contractManifest from the manifest. */
  contracts?: ContractManifest[];
  /**
   * Called when the user clicks a contract row to add it to the canvas at a
   * default position. The caller (App.tsx) is responsible for positioning.
   */
  onAddContract?: (contract: ContractManifest) => void;
  /**
   * Top offset (px) for the fixed panel. The caller (App.tsx) MUST pass a
   * value that clears every fixed toolbar row above the canvas so that
   * opening/closing this panel never needs to shift a toolbar row sideways
   * (issue #80). Defaults to 56 for standalone usage (e.g. tests/storybook).
   */
  top?: number;
}

// ---------------------------------------------------------------------------
// dataTransfer key used by drag-to-canvas
// ---------------------------------------------------------------------------

/**
 * The MIME-type-style key used in HTML5 dataTransfer for dragging a contract
 * row onto the React Flow canvas. The value is the contract's unique id
 * (`sourcePath::name`), which App.tsx uses to look up the ContractManifest.
 */
export const DRAG_TRANSFER_KEY = "application/redeploy-contract";

// ---------------------------------------------------------------------------
// View mode type
// ---------------------------------------------------------------------------

type ViewMode = "flat" | "folders";

// ---------------------------------------------------------------------------
// Folder tree structure
// ---------------------------------------------------------------------------

interface FolderNode {
  segment: string;
  children: Map<string, FolderNode>;
  contracts: ContractManifest[];
}

// ---------------------------------------------------------------------------
// Unique contract id
// ---------------------------------------------------------------------------

function contractUniqueId(contract: ContractManifest): string {
  return `${contract.sourcePath}::${contract.name}`;
}

// ---------------------------------------------------------------------------
// Tap-to-add (issue #90)
// ---------------------------------------------------------------------------

/**
 * Max finger movement (px) between touchstart and touchend still considered a
 * tap rather than a scroll/drag gesture. The contracts list is scrollable
 * (see `listStyle.overflowY`), so a touchend that lands on a row after the
 * user scrolled must NOT be treated as an add.
 */
const TAP_MOVE_THRESHOLD_PX = 10;

function buildFolderTree(contracts: ContractManifest[]): Map<string, FolderNode> {
  const root = new Map<string, FolderNode>();

  for (const contract of contracts) {
    const segments = contract.packageSegments.length > 0 ? contract.packageSegments : ["(root)"];
    let currentMap = root;

    for (const segment of segments) {
      if (!currentMap.has(segment)) {
        currentMap.set(segment, { segment, children: new Map(), contracts: [] });
      }
      const node = currentMap.get(segment)!;
      currentMap = node.children;
    }

    // Place contract in last segment node
    let currentMapForContract = root;
    for (let i = 0; i < segments.length; i++) {
      const node = currentMapForContract.get(segments[i])!;
      if (i === segments.length - 1) {
        node.contracts.push(contract);
      }
      currentMapForContract = node.children;
    }
  }

  return root;
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  position: "fixed",
  left: 0,
  top: 56,
  bottom: 0,
  width: 280,
  background: "#f8f9fa",
  borderRight: "1px solid #dee2e6",
  display: "flex",
  flexDirection: "column",
  zIndex: 10,
  fontSize: 13,
};

const headerStyle: React.CSSProperties = {
  padding: "12px 16px 8px",
  borderBottom: "1px solid #dee2e6",
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 8,
};

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 12,
  padding: "4px 8px",
  border: "1px solid #ccc",
  borderRadius: 3,
  marginBottom: 8,
};

const modeBtnStyle: React.CSSProperties = {
  padding: "3px 10px",
  cursor: "pointer",
  borderRadius: 4,
  fontSize: 12,
  border: "1px solid #ccc",
  background: "#fff",
  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
};

const activeModeBtnStyle: React.CSSProperties = {
  ...modeBtnStyle,
  background: "#1a73e8",
  color: "#fff",
  border: "1px solid #1a73e8",
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 0",
};

const contractRowStyle: React.CSSProperties = {
  padding: "5px 16px",
  cursor: "pointer",
  userSelect: "none",
};

const contractRowSelectedStyle: React.CSSProperties = {
  ...contractRowStyle,
  background: "#e8f0fe",
  borderLeft: "3px solid #1a73e8",
  paddingLeft: 13,
};

const contractNameStyle: React.CSSProperties = {
  fontWeight: 500,
  fontSize: 13,
};

const contractHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#888",
  marginTop: 1,
};

const folderRowStyle: React.CSSProperties = {
  padding: "5px 12px",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 12,
  color: "#444",
  userSelect: "none",
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const sigPanelStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderTop: "1px solid #dee2e6",
  background: "#fff",
  flexShrink: 0,
  fontSize: 12,
};

const sigCodeStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#1a73e8",
  wordBreak: "break-all",
  marginTop: 4,
};

// ---------------------------------------------------------------------------
// Constructor signature builder
// ---------------------------------------------------------------------------

function buildConstructorSignature(contract: ContractManifest): string {
  if (contract.constructorArgs.length === 0) {
    return "constructor()";
  }
  const args = contract.constructorArgs.map((a) => `${a.type} ${a.name}`).join(", ");
  return `constructor(${args})`;
}

// ---------------------------------------------------------------------------
// Package hint builder
// ---------------------------------------------------------------------------

function buildPackageHint(contract: ContractManifest): string {
  if (contract.packageSegments.length > 0) {
    return contract.packageSegments.join("/");
  }
  return contract.sourcePath;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ContractRowProps {
  contract: ContractManifest;
  selected: boolean;
  onSelect: (uniqueId: string) => void;
  onAddContract?: (contract: ContractManifest) => void;
  indent?: number;
}

function ContractRow({ contract, selected, onSelect, onAddContract, indent = 0 }: ContractRowProps) {
  const style = selected
    ? { ...contractRowSelectedStyle, paddingLeft: 13 + indent * 8 }
    : { ...contractRowStyle, paddingLeft: 16 + indent * 8 };

  // Tracks the touch start point so touchend can tell a tap (small/no
  // movement) apart from a scroll/drag gesture within the list.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  function handleClick() {
    onSelect(contractUniqueId(contract));
    onAddContract?.(contract);
  }

  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(DRAG_TRANSFER_KEY, contractUniqueId(contract));
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    const touch = e.touches[0];
    touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  // Tap-to-add fallback (issue #90) — HTML5 drag-and-drop never fires from
  // touch input, so a genuine tap (touchend close to where the touch
  // started) must add the contract directly, exactly like handleClick.
  function handleTouchEnd(e: React.TouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;

    const touch = e.changedTouches[0];
    if (!touch) return;

    const dx = Math.abs(touch.clientX - start.x);
    const dy = Math.abs(touch.clientY - start.y);
    if (dx > TAP_MOVE_THRESHOLD_PX || dy > TAP_MOVE_THRESHOLD_PX) {
      // Scroll/drag gesture, not a tap — let the browser handle it natively
      // (e.g. scrolling the contracts list) instead of adding a node.
      return;
    }

    // preventDefault() suppresses the browser's synthesized mouse events
    // (mousedown/mouseup/click) that would otherwise follow this touchend,
    // so the add only fires once (not once here + once via handleClick).
    e.preventDefault();
    onSelect(contractUniqueId(contract));
    onAddContract?.(contract);
  }

  return (
    <div
      style={style}
      data-testid={`contract-row-${contract.name}`}
      draggable
      onClick={handleClick}
      onDragStart={handleDragStart}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div style={contractNameStyle}>{contract.name}</div>
      <div style={contractHintStyle}>{buildPackageHint(contract)}</div>
    </div>
  );
}

interface FolderTreeProps {
  node: FolderNode;
  selectedId: string | null;
  onSelect: (uniqueId: string) => void;
  onAddContract?: (contract: ContractManifest) => void;
  depth?: number;
  /** Accumulated path from root — used to build collision-safe folder keys. */
  path?: string;
}

function FolderTree({ node, selectedId, onSelect, onAddContract, depth = 0, path = "" }: FolderTreeProps) {
  const fullPath = path === "" ? node.segment : `${path}/${node.segment}`;
  const [open, setOpen] = useState(true);

  const hasContent =
    node.contracts.length > 0 ||
    Array.from(node.children.values()).some((child) => hasVisibleContent(child));

  if (!hasContent) return null;

  const sortedContracts = [...node.contracts].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

  const sortedChildren = Array.from(node.children.values()).sort((a, b) =>
    a.segment.toLowerCase().localeCompare(b.segment.toLowerCase()),
  );

  const indentPx = 8 + depth * 12;

  return (
    <div data-testid={`folder-${node.segment}`}>
      <div
        style={{ ...folderRowStyle, paddingLeft: indentPx }}
        data-testid={`folder-toggle-${node.segment}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{node.segment}</span>
      </div>

      {open && (
        <div>
          {sortedContracts.map((contract) => (
            <ContractRow
              key={contractUniqueId(contract)}
              contract={contract}
              selected={selectedId === contractUniqueId(contract)}
              onSelect={onSelect}
              onAddContract={onAddContract}
              indent={depth + 1}
            />
          ))}
          {sortedChildren.map((child) => (
            <FolderTree
              key={`${fullPath}/${child.segment}`}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddContract={onAddContract}
              depth={depth + 1}
              path={fullPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function hasVisibleContent(node: FolderNode): boolean {
  if (node.contracts.length > 0) return true;
  return Array.from(node.children.values()).some(hasVisibleContent);
}

// ---------------------------------------------------------------------------
// Main ContractsBrowser component
// ---------------------------------------------------------------------------

export function ContractsBrowser({
  contracts = contractManifest,
  onAddContract,
  top = 56,
}: ContractsBrowserProps) {
  const [mode, setMode] = useState<ViewMode>("flat");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Apply case-insensitive substring filter on name.
  const filtered =
    search.trim() === ""
      ? contracts
      : contracts.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()));

  const sortedFlat = [...filtered].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

  const selectedContract = selectedId != null ? contracts.find((c) => contractUniqueId(c) === selectedId) : null;

  return (
    <div style={{ ...panelStyle, top }} data-testid="contracts-browser">
      {/* Header: title, search, mode toggle */}
      <div style={headerStyle}>
        <div style={titleStyle}>Contracts</div>

        <input
          style={searchInputStyle}
          type="text"
          placeholder="Search contracts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="contracts-search"
          aria-label="search-contracts"
        />

        <div style={{ display: "flex", gap: 6 }}>
          <button
            style={mode === "flat" ? activeModeBtnStyle : modeBtnStyle}
            onClick={() => setMode("flat")}
            data-testid="mode-flat"
          >
            Flat
          </button>
          <button
            style={mode === "folders" ? activeModeBtnStyle : modeBtnStyle}
            onClick={() => setMode("folders")}
            data-testid="mode-folders"
          >
            Folders
          </button>
        </div>
      </div>

      {/* Contract list */}
      <div style={listStyle} data-testid="contracts-list">
        {mode === "flat" &&
          sortedFlat.map((contract) => (
            <ContractRow
              key={contractUniqueId(contract)}
              contract={contract}
              selected={selectedId === contractUniqueId(contract)}
              onSelect={setSelectedId}
              onAddContract={onAddContract}
            />
          ))}

        {mode === "folders" && (() => {
          const tree = buildFolderTree(filtered);
          const sortedFolders = Array.from(tree.values()).sort((a, b) =>
            a.segment.toLowerCase().localeCompare(b.segment.toLowerCase()),
          );
          return sortedFolders.map((folder) => (
            <FolderTree
              key={folder.segment}
              node={folder}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAddContract={onAddContract}
            />
          ));
        })()}
      </div>

      {/* Constructor signature for selected contract */}
      {selectedContract && (
        <div style={sigPanelStyle} data-testid="constructor-signature-panel">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedContract.name}</div>
          <div
            style={sigCodeStyle}
            data-testid="constructor-signature"
          >
            {buildConstructorSignature(selectedContract)}
          </div>
        </div>
      )}
    </div>
  );
}

export default ContractsBrowser;

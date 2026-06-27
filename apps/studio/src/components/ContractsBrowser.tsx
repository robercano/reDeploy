/**
 * ContractsBrowser.tsx
 *
 * Left-sidebar panel for browsing and searching compiled contracts from the
 * manifest. Read-only: no graph mutation (add-to-canvas is issue #37).
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

import { useState } from "react";
import { contractManifest } from "../manifest/index.js";
import type { ContractManifest } from "../manifest/types.js";

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface ContractsBrowserProps {
  /** Contracts to display. Defaults to contractManifest from the manifest. */
  contracts?: ContractManifest[];
}

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
  top: 0,
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
  onSelect: (name: string) => void;
  indent?: number;
}

function ContractRow({ contract, selected, onSelect, indent = 0 }: ContractRowProps) {
  const style = selected
    ? { ...contractRowSelectedStyle, paddingLeft: 13 + indent * 8 }
    : { ...contractRowStyle, paddingLeft: 16 + indent * 8 };

  return (
    <div
      style={style}
      data-testid={`contract-row-${contract.name}`}
      onClick={() => onSelect(contract.name)}
    >
      <div style={contractNameStyle}>{contract.name}</div>
      <div style={contractHintStyle}>{buildPackageHint(contract)}</div>
    </div>
  );
}

interface FolderTreeProps {
  node: FolderNode;
  selectedName: string | null;
  onSelect: (name: string) => void;
  depth?: number;
}

function FolderTree({ node, selectedName, onSelect, depth = 0 }: FolderTreeProps) {
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
              key={contract.name}
              contract={contract}
              selected={selectedName === contract.name}
              onSelect={onSelect}
              indent={depth + 1}
            />
          ))}
          {sortedChildren.map((child) => (
            <FolderTree
              key={child.segment}
              node={child}
              selectedName={selectedName}
              onSelect={onSelect}
              depth={depth + 1}
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

export function ContractsBrowser({ contracts = contractManifest }: ContractsBrowserProps) {
  const [mode, setMode] = useState<ViewMode>("flat");
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Apply case-insensitive substring filter on name.
  const filtered =
    search.trim() === ""
      ? contracts
      : contracts.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()));

  const sortedFlat = [...filtered].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );

  const selectedContract = selectedName != null ? contracts.find((c) => c.name === selectedName) : null;

  return (
    <div style={panelStyle} data-testid="contracts-browser">
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
              key={contract.name}
              contract={contract}
              selected={selectedName === contract.name}
              onSelect={setSelectedName}
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
              selectedName={selectedName}
              onSelect={setSelectedName}
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

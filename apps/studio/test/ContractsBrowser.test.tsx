/**
 * ContractsBrowser.test.tsx
 *
 * Tests for the ContractsBrowser component: view-mode switching, folder
 * grouping from packageSegments, search filtering (flat and folders), and
 * constructor signature rendering.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContractsBrowser, DRAG_TRANSFER_KEY } from "../src/components/ContractsBrowser.js";
import type { ContractManifest } from "../src/manifest/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN: ContractManifest = {
  name: "Token",
  sourcePath: "src/Token.sol",
  packageSegments: ["src"],
  constructorArgs: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
  ],
  inheritance: ["Token"],
  functions: [],
};

const VAULT: ContractManifest = {
  name: "Vault",
  sourcePath: "src/Vault.sol",
  packageSegments: ["src"],
  constructorArgs: [{ name: "owner", type: "address" }],
  inheritance: ["Vault"],
  functions: [],
};

const ERC20: ContractManifest = {
  name: "ERC20",
  sourcePath: "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol",
  packageSegments: ["@openzeppelin", "token", "ERC20"],
  constructorArgs: [],
  inheritance: ["ERC20"],
  functions: [],
};

const ACCESS_CONTROL: ContractManifest = {
  name: "AccessControl",
  sourcePath: "lib/openzeppelin-contracts/contracts/access/AccessControl.sol",
  packageSegments: ["@openzeppelin", "access"],
  constructorArgs: [{ name: "admin", type: "address" }],
  inheritance: ["AccessControl"],
  functions: [],
};

const NO_ARGS_CONTRACT: ContractManifest = {
  name: "Registry",
  sourcePath: "src/Registry.sol",
  packageSegments: ["src"],
  constructorArgs: [],
  inheritance: ["Registry"],
  functions: [],
};

const ALL_CONTRACTS: ContractManifest[] = [TOKEN, VAULT, ERC20, ACCESS_CONTROL, NO_ARGS_CONTRACT];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ContractsBrowser — rendering", () => {
  it("renders the panel", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    expect(screen.getByTestId("contracts-browser")).not.toBeNull();
  });

  it("renders the search input", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    expect(screen.getByTestId("contracts-search")).not.toBeNull();
  });

  it("renders the Flat and Folders mode toggle buttons", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    expect(screen.getByTestId("mode-flat")).not.toBeNull();
    expect(screen.getByTestId("mode-folders")).not.toBeNull();
  });

  it("renders all contracts in flat mode by default", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    for (const c of ALL_CONTRACTS) {
      expect(screen.getByTestId(`contract-row-${c.name}`)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// View mode switching
// ---------------------------------------------------------------------------

describe("ContractsBrowser — view mode switching", () => {
  it("starts in flat mode (all contracts visible without folders)", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    // In flat mode, rows are visible and no folder-toggle elements shown
    expect(screen.getByTestId("contract-row-Token")).not.toBeNull();
    expect(screen.queryByTestId("folder-toggle-src")).toBeNull();
  });

  it("switches to folders mode and shows folder toggles", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("mode-folders"));
    // src folder should now appear
    expect(screen.getByTestId("folder-toggle-src")).not.toBeNull();
    // @openzeppelin folder should appear
    expect(screen.getByTestId("folder-toggle-@openzeppelin")).not.toBeNull();
  });

  it("switches back to flat mode and removes folder toggles", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("mode-folders"));
    fireEvent.click(screen.getByTestId("mode-flat"));
    expect(screen.queryByTestId("folder-toggle-src")).toBeNull();
    expect(screen.getByTestId("contract-row-Token")).not.toBeNull();
  });

  it("flat mode shows contracts sorted alphabetically", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    const rows = screen.getAllByTestId(/^contract-row-/);
    const names = rows.map((r) => r.getAttribute("data-testid")!.replace("contract-row-", ""));
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Folder grouping
// ---------------------------------------------------------------------------

describe("ContractsBrowser — folder grouping", () => {
  beforeEach(() => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("mode-folders"));
  });

  it("groups Token, Vault, Registry under 'src' folder", () => {
    const srcFolder = screen.getByTestId("folder-src");
    expect(srcFolder.textContent).toContain("Token");
    expect(srcFolder.textContent).toContain("Vault");
    expect(srcFolder.textContent).toContain("Registry");
  });

  it("groups ERC20 and AccessControl under '@openzeppelin' folder", () => {
    const ozFolder = screen.getByTestId("folder-@openzeppelin");
    expect(ozFolder.textContent).toContain("ERC20");
    expect(ozFolder.textContent).toContain("AccessControl");
  });

  it("nests ERC20 under @openzeppelin/token/ERC20", () => {
    // The nested ERC20 folder should exist
    expect(screen.getByTestId("folder-ERC20")).not.toBeNull();
  });

  it("nests AccessControl under @openzeppelin/access", () => {
    expect(screen.getByTestId("folder-access")).not.toBeNull();
  });

  it("collapses a folder when toggle is clicked", () => {
    // Initially src folder is open (contracts visible)
    expect(screen.getByTestId("contract-row-Token")).not.toBeNull();

    // Click folder toggle to collapse
    fireEvent.click(screen.getByTestId("folder-toggle-src"));

    // Contracts inside should be hidden
    expect(screen.queryByTestId("contract-row-Token")).toBeNull();
    expect(screen.queryByTestId("contract-row-Vault")).toBeNull();
  });

  it("re-expands a folder when toggle clicked again", () => {
    fireEvent.click(screen.getByTestId("folder-toggle-src"));
    expect(screen.queryByTestId("contract-row-Token")).toBeNull();

    fireEvent.click(screen.getByTestId("folder-toggle-src"));
    expect(screen.getByTestId("contract-row-Token")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Search filtering — flat mode
// ---------------------------------------------------------------------------

describe("ContractsBrowser — search in flat mode", () => {
  it("filters contracts by case-insensitive substring", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    const search = screen.getByTestId("contracts-search");
    fireEvent.change(search, { target: { value: "vault" } });

    expect(screen.getByTestId("contract-row-Vault")).not.toBeNull();
    expect(screen.queryByTestId("contract-row-Token")).toBeNull();
    expect(screen.queryByTestId("contract-row-ERC20")).toBeNull();
  });

  it("search is case-insensitive (uppercase input)", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    const search = screen.getByTestId("contracts-search");
    fireEvent.change(search, { target: { value: "TOKEN" } });

    expect(screen.getByTestId("contract-row-Token")).not.toBeNull();
    expect(screen.queryByTestId("contract-row-Vault")).toBeNull();
  });

  it("clears filter when search is emptied", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    const search = screen.getByTestId("contracts-search");
    fireEvent.change(search, { target: { value: "vault" } });
    fireEvent.change(search, { target: { value: "" } });

    // All contracts visible again
    for (const c of ALL_CONTRACTS) {
      expect(screen.getByTestId(`contract-row-${c.name}`)).not.toBeNull();
    }
  });

  it("shows no contracts when search matches nothing", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    const search = screen.getByTestId("contracts-search");
    fireEvent.change(search, { target: { value: "XYZNOTFOUND" } });

    for (const c of ALL_CONTRACTS) {
      expect(screen.queryByTestId(`contract-row-${c.name}`)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Search filtering — folders mode
// ---------------------------------------------------------------------------

describe("ContractsBrowser — search in folders mode", () => {
  it("hides folders where all children are filtered out", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("mode-folders"));
    const search = screen.getByTestId("contracts-search");

    // Search for "vault" — only src/Vault matches; @openzeppelin has no matches
    fireEvent.change(search, { target: { value: "vault" } });

    // @openzeppelin folder should not render (no matches inside)
    expect(screen.queryByTestId("folder-@openzeppelin")).toBeNull();
    // src folder still renders (Vault is there)
    expect(screen.getByTestId("folder-src")).not.toBeNull();
    expect(screen.getByTestId("contract-row-Vault")).not.toBeNull();
    // Token row should be hidden
    expect(screen.queryByTestId("contract-row-Token")).toBeNull();
  });

  it("shows folders with at least one matching contract", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("mode-folders"));
    const search = screen.getByTestId("contracts-search");

    // Search for "erc20" — only ERC20 (in @openzeppelin/token/ERC20) matches
    fireEvent.change(search, { target: { value: "erc20" } });

    expect(screen.getByTestId("folder-@openzeppelin")).not.toBeNull();
    expect(screen.getByTestId("contract-row-ERC20")).not.toBeNull();
    // src folder should not show (no matches)
    expect(screen.queryByTestId("folder-src")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constructor signature
// ---------------------------------------------------------------------------

describe("ContractsBrowser — constructor signature", () => {
  it("does not show constructor panel before a contract is selected", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    expect(screen.queryByTestId("constructor-signature-panel")).toBeNull();
  });

  it("shows constructor signature with args when a contract is selected", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("contract-row-Token"));

    const sigPanel = screen.getByTestId("constructor-signature-panel");
    expect(sigPanel).not.toBeNull();

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor(string name, string symbol)");
  });

  it("shows constructor() when contract has no args", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("contract-row-Registry"));

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor()");
  });

  it("shows constructor signature for ERC20 (no args)", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("contract-row-ERC20"));

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor()");
  });

  it("shows constructor with single arg for Vault", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("contract-row-Vault"));

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor(address owner)");
  });

  it("shows constructor signature for contract in folders mode", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("mode-folders"));
    fireEvent.click(screen.getByTestId("contract-row-Token"));

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor(string name, string symbol)");
  });

  it("updates constructor signature when different contract selected", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);
    fireEvent.click(screen.getByTestId("contract-row-Token"));
    expect(screen.getByTestId("constructor-signature").textContent).toBe(
      "constructor(string name, string symbol)",
    );

    fireEvent.click(screen.getByTestId("contract-row-Vault"));
    expect(screen.getByTestId("constructor-signature").textContent).toBe(
      "constructor(address owner)",
    );
  });
});

// ---------------------------------------------------------------------------
// Empty contracts list
// ---------------------------------------------------------------------------

describe("ContractsBrowser — empty contracts", () => {
  it("renders without errors when contracts array is empty", () => {
    render(<ContractsBrowser contracts={[]} />);
    expect(screen.getByTestId("contracts-browser")).not.toBeNull();
    expect(screen.getByTestId("contracts-list").children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onAddContract callback (click-add)
// ---------------------------------------------------------------------------

describe("ContractsBrowser — onAddContract callback", () => {
  it("calls onAddContract with the contract when a row is clicked", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    fireEvent.click(screen.getByTestId("contract-row-Token"));

    expect(onAddContract).toHaveBeenCalledTimes(1);
    expect(onAddContract).toHaveBeenCalledWith(TOKEN);
  });

  it("still selects the contract (shows signature panel) when onAddContract is set", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    fireEvent.click(screen.getByTestId("contract-row-Token"));

    // Selection still works
    expect(screen.getByTestId("constructor-signature-panel")).not.toBeNull();
    expect(screen.getByTestId("constructor-signature").textContent).toBe(
      "constructor(string name, string symbol)",
    );
  });

  it("calls onAddContract with correct contract when a different row is clicked", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    fireEvent.click(screen.getByTestId("contract-row-Vault"));

    expect(onAddContract).toHaveBeenCalledWith(VAULT);
  });

  it("does not throw when onAddContract is not provided", () => {
    // No onAddContract prop — should behave exactly as before (select only)
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);

    expect(() => {
      fireEvent.click(screen.getByTestId("contract-row-Token"));
    }).not.toThrow();

    // Selection still works
    expect(screen.getByTestId("constructor-signature-panel")).not.toBeNull();
  });

  it("calls onAddContract for a contract in folders mode", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);
    fireEvent.click(screen.getByTestId("mode-folders"));

    fireEvent.click(screen.getByTestId("contract-row-Vault"));

    expect(onAddContract).toHaveBeenCalledWith(VAULT);
  });
});

// ---------------------------------------------------------------------------
// Duplicate contract names (same name, different sourcePath)
// ---------------------------------------------------------------------------

describe("ContractsBrowser — duplicate contract names", () => {
  // Two contracts share the name "Token" but come from different source paths.
  // The second one has a different constructor signature so we can confirm
  // the correct one shows up after selection.
  const TOKEN_SRC: ContractManifest = {
    name: "Token",
    sourcePath: "src/Token.sol",
    packageSegments: ["src"],
    constructorArgs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
    ],
    inheritance: ["Token"],
    functions: [],
  };

  const TOKEN_LIB: ContractManifest = {
    name: "Token",
    sourcePath: "lib/vendor/Token.sol",
    packageSegments: ["lib", "vendor"],
    constructorArgs: [{ name: "initialSupply", type: "uint256" }],
    inheritance: ["Token"],
    functions: [],
  };

  const DUPLICATE_CONTRACTS: ContractManifest[] = [TOKEN_SRC, TOKEN_LIB];

  it("renders both rows when two contracts share the same name", () => {
    render(<ContractsBrowser contracts={DUPLICATE_CONTRACTS} />);
    // Both Token rows should appear; getAllByTestId returns all matching elements.
    const rows = screen.getAllByTestId("contract-row-Token");
    expect(rows).toHaveLength(2);
  });

  it("selecting TOKEN_SRC shows its constructor signature (string name, string symbol)", () => {
    render(<ContractsBrowser contracts={DUPLICATE_CONTRACTS} />);
    const rows = screen.getAllByTestId("contract-row-Token");
    // TOKEN_SRC is sorted first alphabetically by sourcePath (lib sorts after src, but
    // sorted flat by name so both appear — click the one showing the src hint).
    const srcRow = rows.find((r) => r.textContent && r.textContent.includes("src"));
    expect(srcRow).toBeDefined();
    fireEvent.click(srcRow!);

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor(string name, string symbol)");
  });

  it("selecting TOKEN_LIB shows its constructor signature (uint256 initialSupply)", () => {
    render(<ContractsBrowser contracts={DUPLICATE_CONTRACTS} />);
    const rows = screen.getAllByTestId("contract-row-Token");
    const libRow = rows.find((r) => r.textContent && r.textContent.includes("lib"));
    expect(libRow).toBeDefined();
    fireEvent.click(libRow!);

    const sig = screen.getByTestId("constructor-signature");
    expect(sig.textContent).toBe("constructor(uint256 initialSupply)");
  });

  it("selecting TOKEN_SRC does not highlight TOKEN_LIB row", () => {
    render(<ContractsBrowser contracts={DUPLICATE_CONTRACTS} />);
    const rows = screen.getAllByTestId("contract-row-Token");
    const srcRow = rows.find((r) => r.textContent && r.textContent.includes("src"));
    fireEvent.click(srcRow!);

    // After selecting the src row, the lib row should NOT have the selected style
    // (selected rows get a blue left-border; check via inline style or by verifying
    // only one row has background set to the selection color).
    const libRow = rows.find((r) => r.textContent && r.textContent.includes("lib"));
    expect(libRow).toBeDefined();
    // The selected row has a blue selection background (jsdom normalizes hex to rgb).
    // Unselected row should have no selection background.
    const libBg = (libRow as HTMLElement).style.background;
    const srcBg = (srcRow as HTMLElement).style.background;
    // src row should be selected (non-empty background)
    expect(srcBg).toBeTruthy();
    // lib row should not be selected (empty background)
    expect(libBg).toBe("");
  });

  it("can switch selection from TOKEN_SRC to TOKEN_LIB independently", () => {
    render(<ContractsBrowser contracts={DUPLICATE_CONTRACTS} />);
    const rows = screen.getAllByTestId("contract-row-Token");
    const srcRow = rows.find((r) => r.textContent && r.textContent.includes("src"))!;
    const libRow = rows.find((r) => r.textContent && r.textContent.includes("lib"))!;

    // Select src first
    fireEvent.click(srcRow);
    expect(screen.getByTestId("constructor-signature").textContent).toBe(
      "constructor(string name, string symbol)",
    );

    // Now select lib
    fireEvent.click(libRow);
    expect(screen.getByTestId("constructor-signature").textContent).toBe(
      "constructor(uint256 initialSupply)",
    );
  });
});

// ---------------------------------------------------------------------------
// Tap-to-add fallback (issue #90) — touchstart/touchend on contract rows
// ---------------------------------------------------------------------------

function touchAt(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] };
}

function touchEndAt(x: number, y: number) {
  return { changedTouches: [{ clientX: x, clientY: y }] };
}

describe("ContractsBrowser — tap-to-add (touch fallback)", () => {
  it("calls onAddContract on a tap (touchstart+touchend with no movement)", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    const row = screen.getByTestId("contract-row-Token");
    fireEvent.touchStart(row, touchAt(10, 10));
    fireEvent.touchEnd(row, touchEndAt(10, 10));

    expect(onAddContract).toHaveBeenCalledTimes(1);
    expect(onAddContract).toHaveBeenCalledWith(TOKEN);
  });

  it("also selects the contract (shows signature panel) on tap", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);

    const row = screen.getByTestId("contract-row-Token");
    fireEvent.touchStart(row, touchAt(10, 10));
    fireEvent.touchEnd(row, touchEndAt(10, 10));

    expect(screen.getByTestId("constructor-signature-panel")).not.toBeNull();
  });

  it("tolerates small jitter (below the tap threshold) as a tap", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    const row = screen.getByTestId("contract-row-Vault");
    fireEvent.touchStart(row, touchAt(10, 10));
    fireEvent.touchEnd(row, touchEndAt(14, 12));

    expect(onAddContract).toHaveBeenCalledWith(VAULT);
  });

  it("does NOT call onAddContract when touchend is far from touchstart (scroll gesture)", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    const row = screen.getByTestId("contract-row-Vault");
    fireEvent.touchStart(row, touchAt(10, 10));
    fireEvent.touchEnd(row, touchEndAt(60, 60));

    expect(onAddContract).not.toHaveBeenCalled();
  });

  it("does NOT call onAddContract on a pure-vertical scroll (dx=0, dy beyond threshold)", () => {
    // A vertically-scrollable list's dominant gesture is a pure-vertical drag: dx≈0,
    // dy large. Diagonal-gesture tests above short-circuit on the dx term, so this
    // exercises the `dy > TAP_MOVE_THRESHOLD_PX` branch specifically.
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    const row = screen.getByTestId("contract-row-Token");
    fireEvent.touchStart(row, touchAt(100, 200));
    fireEvent.touchEnd(row, touchEndAt(100, 80));

    expect(onAddContract).not.toHaveBeenCalled();
  });

  it("does not throw when onAddContract is not provided and the row is tapped", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);

    const row = screen.getByTestId("contract-row-Token");
    expect(() => {
      fireEvent.touchStart(row, touchAt(10, 10));
      fireEvent.touchEnd(row, touchEndAt(10, 10));
    }).not.toThrow();
  });

  it("does not throw and adds nothing when touchend fires without a prior touchstart", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    const row = screen.getByTestId("contract-row-Token");
    expect(() => {
      fireEvent.touchEnd(row, touchEndAt(10, 10));
    }).not.toThrow();
    expect(onAddContract).not.toHaveBeenCalled();
  });

  it("does nothing when touchend fires with no changedTouches", () => {
    const onAddContract = vi.fn();
    render(<ContractsBrowser contracts={ALL_CONTRACTS} onAddContract={onAddContract} />);

    const row = screen.getByTestId("contract-row-Token");
    fireEvent.touchStart(row, touchAt(10, 10));
    expect(() => {
      fireEvent.touchEnd(row, { changedTouches: [] });
    }).not.toThrow();
    expect(onAddContract).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drag SOURCE — handleDragStart on contract rows
// ---------------------------------------------------------------------------

describe("ContractsBrowser — drag source (handleDragStart)", () => {
  it("sets effectAllowed='copy' and dataTransfer.setData with DRAG_TRANSFER_KEY on drag start", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);

    const setData = vi.fn();
    const mockDataTransfer = {
      effectAllowed: "none",
      setData,
    };

    const row = screen.getByTestId("contract-row-Token");
    fireEvent.dragStart(row, { dataTransfer: mockDataTransfer });

    // effectAllowed must be set to "copy"
    expect(mockDataTransfer.effectAllowed).toBe("copy");
    // setData must have been called with the DRAG_TRANSFER_KEY and Token's uniqueId
    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(DRAG_TRANSFER_KEY, "src/Token.sol::Token");
  });

  it("uses sourcePath::name as the uniqueId for Vault", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);

    const setData = vi.fn();
    const mockDataTransfer = {
      effectAllowed: "none",
      setData,
    };

    const row = screen.getByTestId("contract-row-Vault");
    fireEvent.dragStart(row, { dataTransfer: mockDataTransfer });

    expect(setData).toHaveBeenCalledWith(DRAG_TRANSFER_KEY, "src/Vault.sol::Vault");
  });

  it("uses sourcePath::name from deeply nested ERC20 contract", () => {
    render(<ContractsBrowser contracts={ALL_CONTRACTS} />);

    const setData = vi.fn();
    const mockDataTransfer = {
      effectAllowed: "none",
      setData,
    };

    const row = screen.getByTestId("contract-row-ERC20");
    fireEvent.dragStart(row, { dataTransfer: mockDataTransfer });

    expect(setData).toHaveBeenCalledWith(
      DRAG_TRANSFER_KEY,
      "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol::ERC20",
    );
  });
});


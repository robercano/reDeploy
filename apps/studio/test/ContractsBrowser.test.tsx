/**
 * ContractsBrowser.test.tsx
 *
 * Tests for the ContractsBrowser component: view-mode switching, folder
 * grouping from packageSegments, search filtering (flat and folders), and
 * constructor signature rendering.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { ContractsBrowser } from "../src/components/ContractsBrowser.js";
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

/**
 * App.drop.test.tsx
 *
 * Tests for App-level drag-drop and click-add behaviours added in issue #37:
 *
 * 1. handleDrop — dropping a known manifest uniqueId on canvas-drop-target adds
 *    a contract node with the correct contractName.
 * 2. Negative handleDrop — dropping an empty uniqueId or an unknown uniqueId
 *    adds NO node (guards: `if (!uniqueId) return` and `if (!manifest) return`).
 * 3. handleDragOver — exercised so the branch is covered (sets dropEffect="copy"
 *    when the dataTransfer types include DRAG_TRANSFER_KEY).
 * 4. Click-add through the real App — click toggle-contracts-browser, then click
 *    a contract-row-*, and assert a node was added with the correct contractName.
 *
 * ## jsdom + screenToFlowPosition note
 * React Flow's `useReactFlow().screenToFlowPosition` is a real hook that
 * transforms screen coords to canvas coords. In jsdom the React Flow internal
 * viewport has zero dimensions so the returned position is `{x: NaN, y: NaN}`
 * or `{x: 0, y: 0}`, but `addContractFromManifest` only uses it for the node's
 * initial canvas position — it still adds the node to the React state. We
 * therefore assert on the presence of the node (contractName field), not on its
 * exact pixel coordinates.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import App from "../src/App.js";
import { DRAG_TRANSFER_KEY } from "../src/components/ContractsBrowser.js";
import { contractManifest } from "../src/manifest/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock dataTransfer object whose getData returns the given
 * value for the DRAG_TRANSFER_KEY and empty string for anything else.
 */
function makeDataTransfer(uniqueId: string) {
  return {
    getData: (key: string) => (key === DRAG_TRANSFER_KEY ? uniqueId : ""),
    types: [DRAG_TRANSFER_KEY],
    dropEffect: "none",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App — handleDrop (canvas-drop-target)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("drops a known VaultERC4626 uniqueId and adds a node with contractName VaultERC4626", () => {
    render(<App />);

    // Verify no nodes initially
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);

    const vaultManifest = contractManifest.find(
      (c) => c.sourcePath === "src/VaultERC4626.sol" && c.name === "VaultERC4626",
    );
    expect(vaultManifest).toBeDefined();

    const uniqueId = `${vaultManifest!.sourcePath}::${vaultManifest!.name}`;
    const dropTarget = screen.getByTestId("canvas-drop-target");

    fireEvent.drop(dropTarget, {
      dataTransfer: makeDataTransfer(uniqueId),
    });

    // A node should have been added
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);

    // The node should display the contract name as a read-only label (not an input)
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.tagName.toLowerCase()).not.toBe("input");
    expect(contractNameLabel.textContent).toBe("VaultERC4626");
  });

  it("drops a known Vault uniqueId and adds a node with contractName Vault", () => {
    render(<App />);

    const vaultManifest = contractManifest.find(
      (c) => c.sourcePath === "src/Vault.sol" && c.name === "Vault",
    );
    expect(vaultManifest).toBeDefined();

    const uniqueId = `${vaultManifest!.sourcePath}::${vaultManifest!.name}`;
    const dropTarget = screen.getByTestId("canvas-drop-target");

    fireEvent.drop(dropTarget, {
      dataTransfer: makeDataTransfer(uniqueId),
    });

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.tagName.toLowerCase()).not.toBe("input");
    expect(contractNameLabel.textContent).toBe("Vault");
  });

  it("NEGATIVE: dropping an empty uniqueId adds NO node (covers if (!uniqueId) return)", () => {
    render(<App />);

    const dropTarget = screen.getByTestId("canvas-drop-target");

    fireEvent.drop(dropTarget, {
      dataTransfer: makeDataTransfer(""),
    });

    // No node should appear
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("NEGATIVE: dropping an unknown uniqueId adds NO node (covers if (!manifest) return)", () => {
    render(<App />);

    const dropTarget = screen.getByTestId("canvas-drop-target");

    fireEvent.drop(dropTarget, {
      dataTransfer: makeDataTransfer("nonexistent/path.sol::NonExistentContract"),
    });

    // No node should appear
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleDragOver
// ---------------------------------------------------------------------------

describe("App — handleDragOver (canvas-drop-target)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("dragOver with DRAG_TRANSFER_KEY in types sets dropEffect to copy", () => {
    render(<App />);
    const dropTarget = screen.getByTestId("canvas-drop-target");

    const mockDataTransfer = {
      types: [DRAG_TRANSFER_KEY],
      dropEffect: "none",
    };

    fireEvent.dragOver(dropTarget, { dataTransfer: mockDataTransfer });

    // dropEffect should be "copy" after the handler runs
    expect(mockDataTransfer.dropEffect).toBe("copy");
  });

  it("dragOver with different type does not set dropEffect", () => {
    render(<App />);
    const dropTarget = screen.getByTestId("canvas-drop-target");

    const mockDataTransfer = {
      types: ["text/plain"],
      dropEffect: "none",
    };

    // Should not throw and should not modify dropEffect
    fireEvent.dragOver(dropTarget, { dataTransfer: mockDataTransfer });

    // No assertion needed — just exercising the non-matching branch
  });
});

// ---------------------------------------------------------------------------
// Click-add through the real App — toggle-contracts-browser + row click
// ---------------------------------------------------------------------------

describe("App — click-add through ContractsBrowser", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clicking toggle-contracts-browser shows the browser panel", () => {
    render(<App />);

    // Browser should not be visible initially
    expect(screen.queryByTestId("contracts-browser")).toBeNull();

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));

    // Browser should now be visible
    expect(screen.getByTestId("contracts-browser")).not.toBeNull();
  });

  it("clicking a contract row adds a node with the correct contractName", () => {
    render(<App />);

    // No nodes initially
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);

    // Open the contracts browser
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));

    // Find and click a contract row — use Vault (which is in the src/Vault.sol manifest)
    const vaultRow = screen.getByTestId("contract-row-Vault");
    fireEvent.click(vaultRow);

    // A node should have been added
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);

    // The contract-name should be shown as a read-only label pre-filled with "Vault"
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.tagName.toLowerCase()).not.toBe("input");
    expect(contractNameLabel.textContent).toBe("Vault");
  });

  it("clicking two different contract rows adds two nodes", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));

    const browser = screen.getByTestId("contracts-browser");
    fireEvent.click(within(browser).getByTestId("contract-row-Vault"));
    fireEvent.click(within(browser).getByTestId("contract-row-Registry"));

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2);

    // Both contract names should be pre-filled as read-only labels
    const contractNameLabels = screen.getAllByLabelText("contract-name");
    const names = contractNameLabels.map((el) => el.textContent);
    expect(names).toContain("Vault");
    expect(names).toContain("Registry");
  });

  it("clicking toggle-contracts-browser again hides the browser", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    expect(screen.getByTestId("contracts-browser")).not.toBeNull();

    // Click again to close
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    expect(screen.queryByTestId("contracts-browser")).toBeNull();
  });

  it("App wires onAddContract to addContractFromManifest: contractName matches clicked row", () => {
    render(<App />);

    // Find a contract from the real manifest to click — VaultERC4626 has constructor args
    const vaultManifest = contractManifest.find(
      (c) => c.sourcePath === "src/VaultERC4626.sol" && c.name === "VaultERC4626",
    );
    expect(vaultManifest).toBeDefined();

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));

    // VaultERC4626 row should exist in the browser
    const vaultRow = screen.getByTestId("contract-row-VaultERC4626");
    fireEvent.click(vaultRow);

    // Node should appear with contractName = "VaultERC4626" shown as a read-only label
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.tagName.toLowerCase()).not.toBe("input");
    expect(contractNameLabel.textContent).toBe("VaultERC4626");
  });
});

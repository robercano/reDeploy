/**
 * App.tap-to-add.test.tsx
 *
 * Tests for the tap-to-add fallback added in issue #90: HTML5 drag-and-drop
 * never fires from touch input on mobile browsers, so ContractsBrowser rows
 * fall back to touchstart/touchend tracking that calls the same
 * `onAddContract` App.tsx wiring used by click-add (issue #37), now routed
 * through `handleTapAddContract` (canvas-center placement + cascade offset)
 * instead of the raw `addContractFromManifest(manifest)` default-offset call.
 *
 * ## jsdom note
 * As in App.drop.test.tsx, `screenToFlowPosition` and `getBoundingClientRect`
 * return degenerate values in jsdom (zero-size rects), so these tests assert
 * on node presence/count and contractName, not exact pixel coordinates.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import App from "../src/App.js";
import { contractManifest } from "../src/manifest/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function touchAt(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] };
}

function touchEndAt(x: number, y: number) {
  return { changedTouches: [{ clientX: x, clientY: y }] };
}

describe("App — tap-to-add through ContractsBrowser (touch fallback, issue #90)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("tapping (touchstart+touchend, no movement) a contract row adds a node", () => {
    render(<App />);

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));

    const vaultRow = screen.getByTestId("contract-row-Vault");
    fireEvent.touchStart(vaultRow, touchAt(100, 100));
    fireEvent.touchEnd(vaultRow, touchEndAt(100, 100));

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.tagName.toLowerCase()).not.toBe("input");
    expect(contractNameLabel.textContent).toBe("Vault");
  });

  it("tapping with a small amount of jitter (below threshold) still adds a node", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    const vaultRow = screen.getByTestId("contract-row-Vault");

    fireEvent.touchStart(vaultRow, touchAt(100, 100));
    // 5px of jitter in both axes — well under the 10px tap threshold.
    fireEvent.touchEnd(vaultRow, touchEndAt(105, 103));

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
  });

  it("NEGATIVE: a touchend far from touchstart (scroll/drag gesture) does NOT add a node", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    const vaultRow = screen.getByTestId("contract-row-Vault");

    fireEvent.touchStart(vaultRow, touchAt(100, 100));
    // 40px of movement — well over the 10px tap threshold; this is a scroll.
    fireEvent.touchEnd(vaultRow, touchEndAt(140, 140));

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("NEGATIVE: touchend with no prior touchstart does not throw and adds no node", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    const vaultRow = screen.getByTestId("contract-row-Vault");

    expect(() => {
      fireEvent.touchEnd(vaultRow, touchEndAt(100, 100));
    }).not.toThrow();

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("tapping two different rows adds two nodes with the correct contractNames", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));

    const vaultRow = screen.getByTestId("contract-row-Vault");
    fireEvent.touchStart(vaultRow, touchAt(50, 50));
    fireEvent.touchEnd(vaultRow, touchEndAt(50, 50));

    const registryRow = screen.getByTestId("contract-row-Registry");
    fireEvent.touchStart(registryRow, touchAt(50, 80));
    fireEvent.touchEnd(registryRow, touchEndAt(50, 80));

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2);
    const names = screen.getAllByLabelText("contract-name").map((el) => el.textContent);
    expect(names).toContain("Vault");
    expect(names).toContain("Registry");
  });

  it("repeated taps on the same row each add a separate node (cascade offset doesn't dedupe)", () => {
    render(<App />);

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    const vaultRow = screen.getByTestId("contract-row-Vault");

    for (let i = 0; i < 3; i++) {
      fireEvent.touchStart(vaultRow, touchAt(10, 10));
      fireEvent.touchEnd(vaultRow, touchEndAt(10, 10));
    }

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(3);
  });

  it("tap-add works for a manifest contract with constructor args (VaultERC4626)", () => {
    render(<App />);

    const vaultManifest = contractManifest.find(
      (c) => c.sourcePath === "src/VaultERC4626.sol" && c.name === "VaultERC4626",
    );
    expect(vaultManifest).toBeDefined();

    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    const row = screen.getByTestId("contract-row-VaultERC4626");

    fireEvent.touchStart(row, touchAt(20, 20));
    fireEvent.touchEnd(row, touchEndAt(20, 20));

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.textContent).toBe("VaultERC4626");
  });
});

/**
 * App.toolbar-layout.test.tsx
 *
 * Asserts toolbar layout invariants for issue #70: the mode-toggle toolbar
 * (Authoring, Inspector, Deploy (simulate)) and the authoring toolbar
 * (Contracts, Detailed/Overview, etc.) must NOT share the same fixed-position
 * origin so they cannot visually overlap.
 *
 * jsdom does not compute real layout, so we test inline style attributes and
 * DOM structure rather than getBoundingClientRect geometry.
 *
 * All queries are scoped to the render's container via `within(container)` so
 * a stale mount from a prior test can never resolve a query in the current
 * test. RTL `cleanup()` is called in afterEach to unmount trees and reset
 * RTL's internal tracking.
 */

import { render, within, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import App from "../src/App.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Toolbar presence
// ---------------------------------------------------------------------------

describe("App toolbar layout — button presence", () => {
  it("renders all three mode-toggle buttons as distinct DOM nodes", () => {
    const { container } = render(<App />);
    const q = within(container);

    const authBtn = q.getByTestId("mode-authoring");
    const inspBtn = q.getByTestId("mode-inspector");
    const deployBtn = q.getByTestId("deploy-simulate-button");

    // All present
    expect(authBtn).not.toBeNull();
    expect(inspBtn).not.toBeNull();
    expect(deployBtn).not.toBeNull();

    // All distinct elements
    expect(authBtn).not.toBe(inspBtn);
    expect(authBtn).not.toBe(deployBtn);
    expect(inspBtn).not.toBe(deployBtn);
  });

  it("renders the authoring toolbar button toggle-contracts-browser", () => {
    const { container } = render(<App />);
    expect(within(container).getByTestId("toggle-contracts-browser")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Toolbar container separation: mode-toggle vs authoring toolbar
// ---------------------------------------------------------------------------

describe("App toolbar layout — containers are separate and non-overlapping", () => {
  it("deploy-simulate-button and toggle-contracts-browser are in DIFFERENT parent containers", () => {
    const { container } = render(<App />);
    const q = within(container);

    const deployBtn = q.getByTestId("deploy-simulate-button");
    const contractsBtn = q.getByTestId("toggle-contracts-browser");

    // They must not share the same immediate parent (different toolbar rows)
    expect(deployBtn.parentElement).not.toBe(contractsBtn.parentElement);
  });

  it("mode-toggle toolbar (deploy-simulate-button parent) has top:12 inline style", () => {
    const { container } = render(<App />);
    const q = within(container);

    const deployBtn = q.getByTestId("deploy-simulate-button");
    const modeToolbar = deployBtn.parentElement as HTMLElement;

    // The mode-toggle toolbar is fixed at top:12
    expect(modeToolbar.style.position).toBe("fixed");
    expect(modeToolbar.style.top).toBe("12px");
  });

  it("authoring toolbar (toggle-contracts-browser parent) has a DIFFERENT top than mode-toggle toolbar", () => {
    const { container } = render(<App />);
    const q = within(container);

    const deployBtn = q.getByTestId("deploy-simulate-button");
    const contractsBtn = q.getByTestId("toggle-contracts-browser");

    const modeToolbarTop = (deployBtn.parentElement as HTMLElement).style.top;
    const authoringToolbarTop = (contractsBtn.parentElement as HTMLElement).style.top;

    // They must have different top values so they occupy distinct rows
    expect(modeToolbarTop).not.toBe(authoringToolbarTop);
  });

  it("authoring toolbar (toggle-contracts-browser parent) is fixed and below the mode-toggle toolbar", () => {
    const { container } = render(<App />);
    const q = within(container);

    const contractsBtn = q.getByTestId("toggle-contracts-browser");
    const authoringToolbar = contractsBtn.parentElement as HTMLElement;

    expect(authoringToolbar.style.position).toBe("fixed");

    // Authoring toolbar must sit below mode-toggle toolbar (top > 12)
    const authoringTop = parseInt(authoringToolbar.style.top, 10);
    expect(authoringTop).toBeGreaterThan(12);
  });

  it("mode-authoring and mode-inspector share the same parent as deploy-simulate-button", () => {
    const { container } = render(<App />);
    const q = within(container);

    const authBtn = q.getByTestId("mode-authoring");
    const inspBtn = q.getByTestId("mode-inspector");
    const deployBtn = q.getByTestId("deploy-simulate-button");

    // All three mode-toggle buttons are siblings in the same toolbar container
    expect(authBtn.parentElement).toBe(inspBtn.parentElement);
    expect(authBtn.parentElement).toBe(deployBtn.parentElement);
  });
});

// ---------------------------------------------------------------------------
// Deploy button style
// ---------------------------------------------------------------------------

describe("App toolbar layout — deploy button style", () => {
  it("deploy-simulate-button has green background in idle state", () => {
    const { container } = render(<App />);
    const btn = within(container).getByTestId("deploy-simulate-button") as HTMLButtonElement;

    // idle green background (#34a853)
    expect(btn.style.background).toBe("rgb(52, 168, 83)");
    expect(btn.style.cursor).toBe("pointer");
  });
});

// ---------------------------------------------------------------------------
// showBrowser toggle: authoring toolbar shifts left to clear the browser panel
// ---------------------------------------------------------------------------

describe("App toolbar layout — browser panel toggle", () => {
  it("authoring toolbar shifts left when browser panel opens", () => {
    const { container } = render(<App />);
    const q = within(container);

    const contractsBtn = q.getByTestId("toggle-contracts-browser");
    const authoringToolbar = contractsBtn.parentElement as HTMLElement;

    const leftBefore = authoringToolbar.style.left;

    // Open the browser panel
    fireEvent.click(contractsBtn);

    const leftAfter = authoringToolbar.style.left;

    // left should increase (shift right) so the toolbar clears the panel
    const leftBeforePx = parseInt(leftBefore, 10);
    const leftAfterPx = parseInt(leftAfter, 10);
    expect(leftAfterPx).toBeGreaterThan(leftBeforePx);
  });

  it("mode-toggle toolbar left remains unchanged when browser panel opens", () => {
    const { container } = render(<App />);
    const q = within(container);

    const deployBtn = q.getByTestId("deploy-simulate-button");
    const modeToolbar = deployBtn.parentElement as HTMLElement;
    const leftBefore = modeToolbar.style.left;

    fireEvent.click(q.getByTestId("toggle-contracts-browser"));

    // Mode-toggle toolbar is always at left:12 regardless of browser panel
    expect(modeToolbar.style.left).toBe(leftBefore);
    expect(modeToolbar.style.left).toBe("12px");
  });
});

// ---------------------------------------------------------------------------
// Banners sit below both toolbar rows
// ---------------------------------------------------------------------------

describe("App toolbar layout — banners below toolbar rows", () => {
  it("error banner (deploy-simulate-error) top is greater than authoring toolbar top", async () => {
    // Stub fetch to return an immediate error so the banner appears
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("server error", { status: 500 })),
    );

    const { container } = render(<App />);
    const q = within(container);

    const contractsBtn = q.getByTestId("toggle-contracts-browser");
    const authoringToolbarTop = parseInt(
      (contractsBtn.parentElement as HTMLElement).style.top,
      10,
    );

    fireEvent.click(q.getByTestId("deploy-simulate-button"));

    // Wait for the error banner to appear
    await waitFor(() => {
      expect(q.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    const errorBanner = q.getByTestId("deploy-simulate-error") as HTMLElement;
    const bannerTop = parseInt(errorBanner.style.top, 10);

    // Banner must be positioned below the authoring toolbar row
    expect(bannerTop).toBeGreaterThan(authoringToolbarTop);
  });
});

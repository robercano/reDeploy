/**
 * App.persistence.test.tsx
 *
 * End-to-end coverage for issue #80's autosave/restore fix, exercised through
 * the real <App/> component:
 *
 * 1. A reload (simulated by unmounting and remounting <App/>, which is what
 *    actually happens on a real page reload — React state doesn't survive it
 *    either way) restores an in-progress graph from localStorage.
 * 2. Corrupt / stale saved state is discarded gracefully — a "reload" starts
 *    from a blank canvas instead of crashing.
 * 3. The "New / Clear canvas" affordance (toolbar button + confirm modal)
 *    resets the canvas AND the persisted copy, so a subsequent "reload"
 *    doesn't resurrect the cleared graph.
 *
 * Debounce timing uses vi.useFakeTimers() + vi.advanceTimersByTime() so these
 * tests don't need to wait on real wall-clock time.
 */

import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import App from "../src/App.js";
import {
  AUTHORING_STORAGE_KEY,
  AUTHORING_STATE_VERSION,
  loadPersistedState,
} from "../src/hooks/authoring-persistence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Reload restores in-progress work
// ---------------------------------------------------------------------------

describe("App persistence — reload restores the in-progress graph", () => {
  it("a node added before 'reload' is present after remounting App", () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);

    addNodeByName("Token");
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);

    // Let the debounced autosave fire.
    vi.advanceTimersByTime(1000);

    // Simulate a page reload: unmount, then mount a fresh App instance.
    unmount();
    render(<App />);

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
  });

  it("the restored node's deploy-id edits from before the reload are preserved", () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);

    addNodeByName("Token");
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "myToken" } });

    vi.advanceTimersByTime(1000);
    unmount();
    render(<App />);

    const restoredInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(restoredInput.value).toBe("myToken");
  });

  it("multiple nodes all survive a reload", () => {
    vi.useFakeTimers();
    const { unmount } = render(<App />);

    addNodeByName("Token");
    addNodeByName("Registry");
    addNodeByName("Vault");
    vi.advanceTimersByTime(1000);

    unmount();
    render(<App />);

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(3);
  });

  it("with nothing saved, App starts with a blank canvas", () => {
    render(<App />);
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Corrupt / stale saved state discarded gracefully
// ---------------------------------------------------------------------------

describe("App persistence — corrupt/stale saved state never crashes the app", () => {
  it("renders a blank canvas instead of crashing when localStorage JSON is corrupt", () => {
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, "NOT VALID JSON {{{");

    expect(() => render(<App />)).not.toThrow();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("renders a blank canvas instead of crashing when the saved version tag is stale", () => {
    const stale = {
      version: AUTHORING_STATE_VERSION + 1,
      nodes: [
        {
          id: "contract-1",
          position: { x: 0, y: 0 },
          data: { deployId: "x", contractName: "X", args: [], after: [], configSteps: [] },
        },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(stale));

    expect(() => render(<App />)).not.toThrow();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("renders a blank canvas instead of crashing when a saved node is missing required fields", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [{ id: "contract-1" }],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));

    expect(() => render(<App />)).not.toThrow();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// "New / Clear canvas" affordance
// ---------------------------------------------------------------------------

describe("App persistence — New / Clear canvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("shows a confirmation modal before clearing", () => {
    render(<App />);
    addNodeByName("Token");

    fireEvent.click(screen.getByTestId("new-canvas-btn"));

    expect(screen.getByTestId("new-canvas-modal")).not.toBeNull();
    // Clicking the button alone must NOT have cleared the canvas yet.
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
  });

  it("cancelling the modal leaves the canvas untouched", () => {
    render(<App />);
    addNodeByName("Token");

    fireEvent.click(screen.getByTestId("new-canvas-btn"));
    fireEvent.click(screen.getByTestId("new-canvas-cancel"));

    expect(screen.queryByTestId("new-canvas-modal")).toBeNull();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
  });

  it("confirming clears every node from the canvas", () => {
    render(<App />);
    addNodeByName("Token");
    addNodeByName("Registry");

    fireEvent.click(screen.getByTestId("new-canvas-btn"));
    fireEvent.click(screen.getByTestId("new-canvas-confirm"));

    expect(screen.queryByTestId("new-canvas-modal")).toBeNull();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("confirming clears the persisted localStorage copy so a reload doesn't resurrect the cleared graph", () => {
    const { unmount } = render(<App />);
    addNodeByName("Token");
    vi.advanceTimersByTime(1000);
    expect(loadPersistedState()).not.toBeNull();

    fireEvent.click(screen.getByTestId("new-canvas-btn"));
    fireEvent.click(screen.getByTestId("new-canvas-confirm"));

    expect(loadPersistedState()).toBeNull();

    // Simulate reload after clearing.
    unmount();
    render(<App />);
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });
});

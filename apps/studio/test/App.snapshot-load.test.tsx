/**
 * App.snapshot-load.test.tsx
 *
 * Tests the "Load snapshot" file-load path wired into App.tsx (issue #105):
 * switch to inspector mode, fire a change event on the
 * `load-snapshot-input` file input with a mock File, and assert the
 * SnapshotViewer renders on success / a non-blocking error banner renders
 * (while the normal Inspector stays visible) on parse failure.
 *
 * Mirrors App.simulate.test.tsx's fireEvent + waitFor style.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "../src/App.js";
import type { DeploymentSnapshot } from "@redeploy/reader";

const SAMPLE_SNAPSHOT: DeploymentSnapshot = {
  snapshotVersion: 1,
  takenAt: "2026-07-05T12:00:00.000Z",
  chainId: 1,
  toolVersion: "0.3.1",
  specHash: "abc123",
  contracts: [
    {
      id: "registry",
      contractName: "Registry",
      address: "0x1111111111111111111111111111111111111111",
      args: [],
      links: { dependencies: [], libraries: {} },
    },
  ],
  configSteps: [],
  warnings: [],
};

function jsonFile(content: unknown, name = "snapshot.json"): File {
  return new File([JSON.stringify(content)], name, { type: "application/json" });
}

describe("App — Load snapshot (issue #105)", () => {
  it("renders the load-snapshot input only in inspector mode", () => {
    render(<App />);
    expect(screen.queryByTestId("load-snapshot-input")).toBeNull();

    fireEvent.click(screen.getByTestId("mode-inspector"));
    expect(screen.getByTestId("load-snapshot-input")).not.toBeNull();
  });

  it("renders SnapshotViewer with the loaded snapshot's metadata on a valid file", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("mode-inspector"));

    const input = screen.getByTestId("load-snapshot-input") as HTMLInputElement;
    const file = jsonFile(SAMPLE_SNAPSHOT);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-taken-at").textContent).toBe(
        "2026-07-05T12:00:00.000Z",
      );
    });
    expect(screen.getByTestId("snapshot-contract-registry-address").textContent).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(screen.queryByTestId("snapshot-load-error")).toBeNull();
  });

  it("shows a non-blocking error and keeps the normal inspector on invalid JSON", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("mode-inspector"));

    const input = screen.getByTestId("load-snapshot-input") as HTMLInputElement;
    const file = new File(["not valid json{{"], "bad.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-load-error")).not.toBeNull();
    });
    // The normal inspector (sample deployment view) remains rendered.
    expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
    expect(screen.queryByTestId("snapshot-meta-panel")).toBeNull();
  });

  it("shows a non-blocking error on a well-formed JSON object missing required fields", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("mode-inspector"));

    const input = screen.getByTestId("load-snapshot-input") as HTMLInputElement;
    const file = jsonFile({ not: "a snapshot" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-load-error")).not.toBeNull();
    });
    expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
  });

  it("clears a stale load error and loaded snapshot when switching mode away and back", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("mode-inspector"));

    // Trigger a load error in inspector mode.
    const input = screen.getByTestId("load-snapshot-input") as HTMLInputElement;
    const badFile = new File(["not valid json{{"], "bad.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [badFile] } });
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-load-error")).not.toBeNull();
    });

    // Switching to authoring mode must clear the error banner immediately —
    // it must not linger outside inspector mode.
    fireEvent.click(screen.getByTestId("mode-authoring"));
    expect(screen.queryByTestId("snapshot-load-error")).toBeNull();

    // Switching back to inspector mode must not resurrect the stale error or
    // any previously loaded snapshot — it should show the normal inspector.
    fireEvent.click(screen.getByTestId("mode-inspector"));
    expect(screen.queryByTestId("snapshot-load-error")).toBeNull();
    expect(screen.queryByTestId("snapshot-meta-panel")).toBeNull();
    expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
  });

  it("clears a loaded snapshot when leaving and returning to inspector mode", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("mode-inspector"));

    const input = screen.getByTestId("load-snapshot-input") as HTMLInputElement;
    const file = jsonFile(SAMPLE_SNAPSHOT);
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-meta-panel")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("mode-authoring"));
    fireEvent.click(screen.getByTestId("mode-inspector"));

    // The previously loaded snapshot must not reappear; the default inspector
    // (sample deployment view) should render instead.
    expect(screen.queryByTestId("snapshot-meta-panel")).toBeNull();
    expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
  });
});

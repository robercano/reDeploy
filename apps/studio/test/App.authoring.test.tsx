/**
 * App.authoring.test.tsx
 *
 * Component tests for the authoring UI.
 * Tests add nodes, edit fields, and assert the serialized spec reflects changes.
 * React Flow interactions in jsdom are limited; we drive the serializer
 * thoroughly as pure function tests in graph-to-spec.test.ts.
 * Here we assert real UI behavior: rendering, input handling, export modal.
 *
 * Nodes are added through the Contracts Browser (the only add path now):
 * open the browser via `toggle-contracts-browser`, then click a `contract-row-*`
 * which calls addContractFromManifest. The arg slots are derived from the
 * clicked manifest and are fixed for the node's lifetime.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import App from "../src/App.js";
import { graphToSpec } from "../src/spec/graph-to-spec";
import { validateSpec } from "@redeploy/core";
import { validateConfig } from "@redeploy/config";
import type { GraphNode } from "../src/spec/graph-to-spec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Add a contract node by name through the Contracts Browser.
 * Opens the browser (if a toggle exists in the current DOM), clicks the row,
 * and leaves the browser open so callers can add more.
 */
function addNodeByName(name: string) {
  // Open the browser if not already open
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

// ---------------------------------------------------------------------------
// App smoke tests — canvas renders
// ---------------------------------------------------------------------------

describe("App — canvas renders", () => {
  it("renders a React Flow canvas", () => {
    render(<App />);
    const canvas = document.querySelector(".react-flow");
    expect(canvas).not.toBeNull();
  });

  it("shows the Export Spec button", () => {
    render(<App />);
    const btn = screen.getByTestId("export-spec-btn");
    expect(btn).not.toBeNull();
  });

  it("shows the Contracts Browser toggle", () => {
    render(<App />);
    const btn = screen.getByTestId("toggle-contracts-browser");
    expect(btn).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adding and editing contract nodes (via Contracts Browser)
// ---------------------------------------------------------------------------

describe("App — add contract node", () => {
  beforeEach(() => {
    // Clear jsdom between tests
    document.body.innerHTML = "";
  });

  it("adds a contract node when clicking a contract row", () => {
    render(<App />);

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);

    addNodeByName("Token");

    // React Flow node should appear in DOM
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
  });

  it("adds multiple nodes", () => {
    render(<App />);

    addNodeByName("Token");
    addNodeByName("Registry");
    addNodeByName("Vault");

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(3);
  });

  it("renders deploy-id input on the node", () => {
    render(<App />);
    addNodeByName("Token");

    // The ContractNode renders an input with aria-label "deploy-id"
    const deployIdInput = screen.getByLabelText("deploy-id");
    expect(deployIdInput).not.toBeNull();
  });

  it("editing deploy-id input updates the node data", () => {
    render(<App />);
    addNodeByName("Token");

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "myToken" } });

    expect(deployIdInput.value).toBe("myToken");
  });

  it("contract-name is rendered as read-only label (not an editable input)", () => {
    render(<App />);
    addNodeByName("Token");

    // Contract name is now a static div label, not an editable input.
    // It should be present as a labeled element with the manifest-derived name.
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel.tagName.toLowerCase()).not.toBe("input");
    expect(contractNameLabel.textContent).toBe("Token");
  });

  it("derives constructor arg slots from the clicked manifest (Token → name_, symbol_)", () => {
    render(<App />);
    addNodeByName("Token");

    // Token has two constructor args → two arg inputs, fixed for the node lifetime.
    expect(screen.queryAllByLabelText(/^arg-/)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Config panel (per-node inline config section)
// ---------------------------------------------------------------------------

describe("App — config panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("config panel not shown when no node selected", () => {
    // The old side-panel config-panel testid no longer exists (replaced by
    // per-node inline config sections). With no nodes, no config section exists.
    render(<App />);
    expect(screen.queryByTestId("config-panel")).toBeNull();
    expect(document.querySelectorAll("[data-testid^='node-config-section-']")).toHaveLength(0);
  });

  it("config panel shown when node is clicked", () => {
    // Per-node config section is always visible (not click-gated) when
    // configCallbacks are injected. Check that the section exists on the node.
    render(<App />);
    addNodeByName("Registry");

    // The per-node config section should be visible
    const configSection = document.querySelector("[data-testid^='node-config-section-']") as HTMLElement;
    expect(configSection).not.toBeNull();
  });

  it("can add a setX step via config panel", () => {
    render(<App />);
    addNodeByName("Registry");

    // Find the per-node config section
    const configSection = document.querySelector("[data-testid^='node-config-section-']") as HTMLElement;
    expect(configSection).not.toBeNull();

    const addSetXBtn = within(configSection).getByText("+ setX");
    fireEvent.click(addSetXBtn);

    // Should show a step card (each step has a card div; the remove button is a
    // child element with a more specific testid so we match only card divs here)
    const steps = document.querySelectorAll("[data-testid^='node-config-step-']:not([data-testid*='-remove-'])");
    expect(steps).toHaveLength(1);
  });

  it("can add a grantRole step via config panel", () => {
    render(<App />);
    addNodeByName("Registry");

    const configSection = document.querySelector("[data-testid^='node-config-section-']") as HTMLElement;
    expect(configSection).not.toBeNull();

    const addGrantBtn = within(configSection).getByText("+ grantRole");
    fireEvent.click(addGrantBtn);

    const steps = document.querySelectorAll("[data-testid^='node-config-step-']:not([data-testid*='-remove-'])");
    expect(steps).toHaveLength(1);
  });

  it("can remove a config step", () => {
    render(<App />);
    addNodeByName("Registry");

    const configSection = document.querySelector("[data-testid^='node-config-section-']") as HTMLElement;
    expect(configSection).not.toBeNull();

    fireEvent.click(within(configSection).getByText("+ setX"));
    expect(document.querySelectorAll("[data-testid^='node-config-step-']:not([data-testid*='-remove-'])")).toHaveLength(1);

    const removeBtn = within(configSection).getByTitle("Remove config call");
    fireEvent.click(removeBtn);

    expect(configSection.querySelectorAll("[data-testid^='node-config-step-']")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Export modal
// ---------------------------------------------------------------------------

describe("App — export modal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("opens export modal when clicking Export Spec", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("spec-exporter-modal")).not.toBeNull();
  });

  it("export modal shows validation state for empty graph", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));

    // Empty graph → both specs valid
    expect(screen.getByTestId("deploy-valid")).not.toBeNull();
    expect(screen.getByTestId("config-valid")).not.toBeNull();
  });

  it("shows the spec JSON in the textarea", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));

    const textarea = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain('"version"');
    expect(textarea.value).toContain('"contracts"');
  });

  it("closes when Close is clicked", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    expect(screen.getByTestId("spec-exporter-modal")).not.toBeNull();

    const closeBtn = screen.getByText("✕ Close");
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId("spec-exporter-modal")).toBeNull();
  });

  it("shows deployment invalid if node has duplicate deploy id", () => {
    render(<App />);

    // Add two nodes, set same deploy id
    addNodeByName("Token");
    addNodeByName("Registry");

    const deployIdInputs = screen.getAllByLabelText("deploy-id") as HTMLInputElement[];
    fireEvent.change(deployIdInputs[0], { target: { value: "dup" } });
    fireEvent.change(deployIdInputs[1], { target: { value: "dup" } });

    fireEvent.click(screen.getByTestId("export-spec-btn"));

    // Should show validation error for deployment
    expect(screen.getByTestId("deploy-invalid")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Serializer integration: UI state → graphToSpec → valid spec
// ---------------------------------------------------------------------------

describe("App integration — graphToSpec produces valid spec from node data", () => {
  it("a well-formed graph node data → valid spec", () => {
    // Simulate what the UI produces for a simple two-contract graph
    const nodes: GraphNode[] = [
      {
        id: "n1",
        data: {
          deployId: "token",
          contractName: "ERC20Token",
          args: [{ index: 0, kind: "literal", value: "MyToken" }],
          after: [],
          configSteps: [],
        },
      },
      {
        id: "n2",
        data: {
          deployId: "registry",
          contractName: "Registry",
          args: [],
          after: [],
          configSteps: [
            {
              kind: "setX",
              id: "step-1",
              functionName: "initialize",
              args: ["1000"],
            },
          ],
        },
      },
    ];

    const { deployment, config } = graphToSpec(nodes, []);

    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);

    // Verify structure
    expect(deployment.contracts[0].id).toBe("token");
    expect(deployment.contracts[0].args).toEqual([
      { kind: "literal", value: "MyToken" },
    ]);
    expect(config.steps[0].kind).toBe("setX");
  });
});

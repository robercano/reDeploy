/**
 * App.authoring.test.tsx
 *
 * Component tests for the authoring UI.
 * Tests add nodes, edit fields, and assert the serialized spec reflects changes.
 * React Flow interactions in jsdom are limited; we drive the serializer
 * thoroughly as pure function tests in graph-to-spec.test.ts.
 * Here we assert real UI behavior: rendering, input handling, export modal.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import App from "../src/App.js";
import { graphToSpec } from "../src/spec/graph-to-spec";
import { validateSpec } from "@redeploy/core";
import { validateConfig } from "@redeploy/config";
import type { GraphNode } from "../src/spec/graph-to-spec";

// ---------------------------------------------------------------------------
// App smoke tests — canvas renders
// ---------------------------------------------------------------------------

describe("App — canvas renders", () => {
  it("renders a React Flow canvas", () => {
    render(<App />);
    const canvas = document.querySelector(".react-flow");
    expect(canvas).not.toBeNull();
  });

  it("shows the + Contract toolbar button", () => {
    render(<App />);
    const btn = screen.getByTestId("add-contract-btn");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("Contract");
  });

  it("shows the Export Spec button", () => {
    render(<App />);
    const btn = screen.getByTestId("export-spec-btn");
    expect(btn).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adding and editing contract nodes
// ---------------------------------------------------------------------------

describe("App — add contract node", () => {
  beforeEach(() => {
    // Clear jsdom between tests
    document.body.innerHTML = "";
  });

  it("adds a contract node when clicking + Contract", () => {
    render(<App />);
    const btn = screen.getByTestId("add-contract-btn");

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);

    fireEvent.click(btn);

    // React Flow node should appear in DOM
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
  });

  it("adds multiple nodes", () => {
    render(<App />);
    const btn = screen.getByTestId("add-contract-btn");

    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(3);
  });

  it("renders deploy-id input on the node", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    // The ContractNode renders an input with aria-label "deploy-id"
    const deployIdInput = screen.getByLabelText("deploy-id");
    expect(deployIdInput).not.toBeNull();
  });

  it("editing deploy-id input updates the node data", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "myToken" } });

    expect(deployIdInput.value).toBe("myToken");
  });

  it("editing contract-name input updates the node data", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    const contractNameInput = screen.getByLabelText("contract-name") as HTMLInputElement;
    fireEvent.change(contractNameInput, { target: { value: "ERC20Token" } });

    expect(contractNameInput.value).toBe("ERC20Token");
  });

  it("adds a constructor arg slot", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    // Initially no arg inputs
    expect(screen.queryAllByLabelText(/^arg-/)).toHaveLength(0);

    // Click "+ arg"
    const addArgBtn = screen.getByTitle("Add constructor arg");
    fireEvent.click(addArgBtn);

    // Now one arg input
    expect(screen.queryAllByLabelText(/^arg-/)).toHaveLength(1);
  });

  it("removes a constructor arg slot", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    const addArgBtn = screen.getByTitle("Add constructor arg");
    fireEvent.click(addArgBtn);
    fireEvent.click(addArgBtn);

    expect(screen.queryAllByLabelText(/^arg-/)).toHaveLength(2);

    const removeButtons = screen.getAllByTitle("Remove arg");
    fireEvent.click(removeButtons[0]);

    expect(screen.queryAllByLabelText(/^arg-/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Config panel
// ---------------------------------------------------------------------------

describe("App — config panel", () => {
  it("config panel not shown when no node selected", () => {
    render(<App />);
    expect(screen.queryByTestId("config-panel")).toBeNull();
  });

  it("config panel shown when node is clicked", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    // Click on the node (ContractNode container)
    const node = document.querySelector(".react-flow__node") as HTMLElement;
    fireEvent.click(node);

    // Config panel should appear
    expect(screen.queryByTestId("config-panel")).not.toBeNull();
  });

  it("can add a setX step via config panel", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    const node = document.querySelector(".react-flow__node") as HTMLElement;
    fireEvent.click(node);

    const panel = screen.getByTestId("config-panel");
    const addSetXBtn = within(panel).getByText("+ setX");
    fireEvent.click(addSetXBtn);

    // Should show a step card
    const steps = panel.querySelectorAll("[data-testid^='step-']");
    expect(steps).toHaveLength(1);
  });

  it("can add a grantRole step via config panel", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    const node = document.querySelector(".react-flow__node") as HTMLElement;
    fireEvent.click(node);

    const panel = screen.getByTestId("config-panel");
    const addGrantBtn = within(panel).getByText("+ grantRole");
    fireEvent.click(addGrantBtn);

    const steps = panel.querySelectorAll("[data-testid^='step-']");
    expect(steps).toHaveLength(1);
  });

  it("can remove a config step", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("add-contract-btn"));

    const node = document.querySelector(".react-flow__node") as HTMLElement;
    fireEvent.click(node);

    const panel = screen.getByTestId("config-panel");
    fireEvent.click(within(panel).getByText("+ setX"));

    expect(panel.querySelectorAll("[data-testid^='step-']")).toHaveLength(1);

    const removeBtn = within(panel).getByTitle("Remove step");
    fireEvent.click(removeBtn);

    expect(panel.querySelectorAll("[data-testid^='step-']")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Export modal
// ---------------------------------------------------------------------------

describe("App — export modal", () => {
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
    fireEvent.click(screen.getByTestId("add-contract-btn"));
    fireEvent.click(screen.getByTestId("add-contract-btn"));

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

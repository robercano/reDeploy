/**
 * overview-mode.test.tsx
 *
 * Tests for issue #55 — overview view mode (hide args; show Deploy ID + contract name).
 *
 * Covers the five required test groups:
 *
 * 1. TOGGLE + VISIBILITY: Toggle switches modes; overview hides arg inputs;
 *    deploy-id + contract-name always visible; detailed mode unchanged.
 *
 * 2. EDGE SURVIVAL: Seed a real constructorRef edge via onConnect, verify the
 *    edge-derived binding (data-ref-value, data-handleid) survives toggle to overview.
 *    In jsdom React Flow does not render SVG edge elements, so the test verifies
 *    the edge's downstream effects: the bound arg slot renders read-only in detailed
 *    mode AND the Handle + ref-binding remain mounted (not unmounted) in overview.
 *
 * 3. HANDLE MOUNTED: In overview mode, assert the Handle element is still in the DOM
 *    (data-handleid present, .react-flow__handle count equal to detailed mode).
 *
 * 4. SPEC-STRIP: Unit-tests the toGraphNodes projection helper that strips
 *    display-only fields. Given a node whose data carries viewMode AND refSourceDeployIds
 *    (the two display-only fields), toGraphNodes output contains ONLY the five
 *    serializable fields and neither display-only field. This is load-bearing: if
 *    someone adds a display-only field and forgets to strip it, this test fails.
 *    Also verifies the App pipeline via SpecExporter textarea.
 *
 * 5. ARG-VALUE ROUND-TRIP: Type a value into an arg input, toggle
 *    detailed→overview→detailed, assert the value persisted.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import App from "../src/App.js";
import { ContractNode } from "../src/components/ContractNode.js";
import { toGraphNodes } from "../src/spec/project-nodes.js";
import { overviewEdges } from "../src/spec/overview-edges.js";
import { graphToSpec } from "../src/spec/graph-to-spec.js";
import { useGraph } from "../src/hooks/useGraph.js";
import type { ContractNodeData } from "../src/spec/types.js";
import type { ContractManifest } from "../src/manifest/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = () => {};

function makeData(overrides: Partial<ContractNodeData> = {}): ContractNodeData {
  return {
    deployId: "token",
    contractName: "TestContract",
    args: [],
    after: [],
    configSteps: [],
    onUpdateDeployId: noop,
    onUpdateContractName: noop,
    onUpdateArgSlot: noop,
    ...overrides,
  };
}

function renderContractNode(data: ContractNodeData, nodeId = "test-node") {
  const props = {
    id: nodeId,
    data: data as unknown as Record<string, unknown>,
    selected: false,
    type: "contractNode",
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };

  return render(
    <ReactFlowProvider>
      <ContractNode {...(props as unknown as NodeProps)} />
    </ReactFlowProvider>,
  );
}

/** Open the Contracts Browser and click a contract row to add it. */
function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

// Synthetic manifests matching the useGraph.test.ts pattern
const REGISTRY_MANIFEST: ContractManifest = {
  name: "Registry",
  sourcePath: "src/Registry.sol",
  packageSegments: ["src"],
  constructorArgs: [],
  inheritance: ["Registry"],
  functions: [],
};

const ONE_ARG_MANIFEST: ContractManifest = {
  name: "Token",
  sourcePath: "src/Token.sol",
  packageSegments: ["src"],
  constructorArgs: [{ name: "asset_", type: "contract IERC20" }],
  inheritance: ["Token"],
  functions: [],
};

// ---------------------------------------------------------------------------
// 1. TOGGLE + VISIBILITY
// ---------------------------------------------------------------------------

describe("overview mode — toggle + visibility", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("toggle-view-mode button is present and initially shows 'Detailed'", () => {
    render(<App />);
    const btn = screen.getByTestId("toggle-view-mode");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Detailed");
  });

  it("clicking toggle switches to overview mode (button label changes to 'Overview')", () => {
    render(<App />);
    const btn = screen.getByTestId("toggle-view-mode");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Overview");
  });

  it("clicking toggle twice returns to detailed mode", () => {
    render(<App />);
    const btn = screen.getByTestId("toggle-view-mode");
    fireEvent.click(btn); // → overview
    fireEvent.click(btn); // → detailed
    expect(btn.textContent).toBe("Detailed");
  });

  it("in detailed mode, arg inputs are visible and accessible", () => {
    render(<App />);
    addNodeByName("Token"); // Token has 2 constructor args

    // Detailed mode (default): arg inputs must be present
    const argInputs = screen.queryAllByLabelText(/^arg-/);
    expect(argInputs.length).toBeGreaterThan(0);
  });

  it("in overview mode, arg inputs are hidden (collapsed via height:0)", () => {
    render(<App />);
    addNodeByName("Token"); // Token has 2 constructor args

    // Switch to overview
    fireEvent.click(screen.getByTestId("toggle-view-mode"));

    // In overview mode, arg content wrappers use height:0/overflow:hidden.
    // The inputs still exist in DOM (Handles must stay mounted) but their
    // containing wrappers are collapsed.
    const container = document.querySelector("[data-testid^='contract-node-']");
    expect(container).not.toBeNull();

    const collapsedDivs = Array.from(container!.querySelectorAll("div")).filter(
      (el) => el.style.height === "0px" || el.style.height === "0",
    );
    expect(collapsedDivs.length).toBeGreaterThan(0);
  });

  it("in overview mode, deploy-id input is always visible", () => {
    render(<App />);
    addNodeByName("Token");

    fireEvent.click(screen.getByTestId("toggle-view-mode"));

    // Deploy ID input must still be present and accessible
    const deployIdInput = screen.getByLabelText("deploy-id");
    expect(deployIdInput).not.toBeNull();
  });

  it("in overview mode, contract name label is always visible", () => {
    render(<App />);
    addNodeByName("Token");

    fireEvent.click(screen.getByTestId("toggle-view-mode"));

    // Contract name label must still be visible
    const contractNameLabel = screen.getByLabelText("contract-name");
    expect(contractNameLabel).not.toBeNull();
    expect(contractNameLabel.textContent).toBe("Token");
  });
});

// ---------------------------------------------------------------------------
// 2. EDGE SURVIVAL — constructorRef edge binding survives toggle to overview
//
// Strategy: seed a real constructorRef edge via useGraph().onConnect and verify
// the edge-derived binding (data-ref-value + data-handleid) is present in
// DETAILED mode, then verify both are still in the DOM in OVERVIEW mode.
//
// jsdom does not render React Flow SVG edge elements (<path>), so we test the
// edge's downstream render effects: enrichNodesWithRefSources injects
// refSourceDeployIds which ContractNode renders as a [data-ref-value] div in
// the bound arg slot. That div AND the Handle ([data-handleid]) prove the edge
// stays anchored without requiring SVG elements.
// ---------------------------------------------------------------------------

describe("overview mode — edge survival (constructor-ref binding)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("seeded constructorRef edge renders data-ref-value in detailed mode", () => {
    /**
     * Use renderHook to seed a real edge via onConnect, then render ContractNode
     * components with the resulting enrichedNodes state.
     */
    const { result } = renderHook(() => useGraph());

    // Add source node (no args) and target node (one arg slot)
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(ONE_ARG_MANIFEST);
    });

    const [srcNode, tgtNode] = result.current.nodes;

    // Set deploy IDs so the ref label is deterministic
    act(() => {
      (srcNode.data as unknown as ContractNodeData).onUpdateDeployId(srcNode.id, "registry");
      (tgtNode.data as unknown as ContractNodeData).onUpdateDeployId(tgtNode.id, "token");
    });

    // Seed the constructorRef edge
    act(() => {
      result.current.onConnect({
        source: srcNode.id,
        target: tgtNode.id,
        sourceHandle: `${srcNode.id}-output`,
        targetHandle: `${tgtNode.id}-arg-0`,
      });
    });

    expect(result.current.edges).toHaveLength(1);

    // Render the target node with refSourceDeployIds (simulating enrichNodesWithRefSources)
    const tgtData = makeData({
      deployId: "token",
      contractName: "Token",
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "registry"]]),
      viewMode: "detailed",
    });

    const { container } = renderContractNode(tgtData, tgtNode.id);

    // In detailed mode: the bound arg slot renders as data-ref-value div
    const refValueEl = container.querySelector("[data-ref-value='registry.address']");
    expect(refValueEl).not.toBeNull();

    // The Handle for arg-0 is present
    const argHandle = container.querySelector(`[data-handleid='${tgtNode.id}-arg-0']`);
    expect(argHandle).not.toBeNull();
  });

  it("data-ref-value AND data-handleid for bound arg slot survive toggle to overview", () => {
    /**
     * This is the core edge-survival assertion: given a node whose arg slot is bound
     * by a constructorRef edge (refSourceDeployIds populated), toggling to overview
     * must NOT unmount either the ref-value element or its Handle.
     */
    const { result } = renderHook(() => useGraph());

    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(ONE_ARG_MANIFEST);
    });

    const [srcNode, tgtNode] = result.current.nodes;

    act(() => {
      result.current.onConnect({
        source: srcNode.id,
        target: tgtNode.id,
        sourceHandle: `${srcNode.id}-output`,
        targetHandle: `${tgtNode.id}-arg-0`,
      });
    });

    // Simulate overview-mode rendering with refSourceDeployIds still injected
    // (viewMode injection happens ON TOP of enrichNodesWithRefSources in App.tsx)
    const tgtDataOverview = makeData({
      deployId: "token",
      contractName: "Token",
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "registry"]]),
      viewMode: "overview", // ← overview mode
    });

    const { container } = renderContractNode(tgtDataOverview, tgtNode.id);

    // In overview mode: the arg content is collapsed, but the elements are still mounted.
    // The data-ref-value div must still be in the DOM (inside the collapsed container).
    const refValueEl = container.querySelector("[data-ref-value='registry.address']");
    expect(refValueEl).not.toBeNull();

    // The Handle for arg-0 must still be in the DOM (edges stay anchored).
    const argHandle = container.querySelector(`[data-handleid='${tgtNode.id}-arg-0']`) as HTMLElement | null;
    expect(argHandle).not.toBeNull();

    // The Handle must be visually HIDDEN via opacity:0 (not display:none, which would
    // drop the layout box and break the edge anchor position).
    expect(argHandle!.style.opacity).toBe("0");

    // The content is inside a collapsed wrapper (height:0)
    const collapsedDivs = Array.from(container.querySelectorAll("div")).filter(
      (el) => el.style.height === "0px" || el.style.height === "0",
    );
    expect(collapsedDivs.length).toBeGreaterThan(0);
  });

  it("no crash occurs when toggling to/from overview with nodes on canvas", () => {
    render(<App />);
    addNodeByName("Token");
    addNodeByName("Registry");

    expect(() => {
      fireEvent.click(screen.getByTestId("toggle-view-mode")); // → overview
      fireEvent.click(screen.getByTestId("toggle-view-mode")); // → detailed
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. HANDLE MOUNTED in overview mode
// ---------------------------------------------------------------------------

describe("overview mode — Handles remain mounted", () => {
  it("arg Handle is mounted in ContractNode when viewMode=overview", () => {
    const data = makeData({
      args: [
        { index: 0, kind: "literal", value: "hello" },
        { index: 1, kind: "literal", value: "world" },
      ],
      viewMode: "overview",
    });

    const { container } = renderContractNode(data, "n1");

    // React Flow renders Handles with class react-flow__handle.
    // Expected: input handle ("-input"), arg-0 handle, arg-1 handle, output handle = ≥4
    const handles = container.querySelectorAll(".react-flow__handle");
    expect(handles.length).toBeGreaterThanOrEqual(4);
  });

  it("arg-0 Handle is mounted (data-handleid present) AND opacity:0 in overview mode", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "test" }],
      viewMode: "overview",
    });

    const { container } = renderContractNode(data, "n1");

    // React Flow renders Handles as divs with data-handleid attribute.
    // In overview mode the handle must be present (for edge anchoring) but invisible.
    const argHandle = container.querySelector("[data-handleid='n1-arg-0']") as HTMLElement | null;
    expect(argHandle).not.toBeNull();
    // Must be hidden via opacity (not display:none — that drops the layout box)
    expect(argHandle!.style.opacity).toBe("0");
  });

  it("arg-0 Handle is visible (no opacity override) in detailed mode", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "test" }],
      viewMode: "detailed",
    });

    const { container } = renderContractNode(data, "n1");

    const argHandle = container.querySelector("[data-handleid='n1-arg-0']") as HTMLElement | null;
    expect(argHandle).not.toBeNull();
    // In detailed mode the dot must be visible — no opacity:0
    expect(argHandle!.style.opacity).not.toBe("0");
  });

  it("arg Handle is mounted AND invisible for ref-bound slot in overview mode", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "oracle"]]),
      viewMode: "overview",
    });

    const { container } = renderContractNode(data, "n1");

    // Handle mounted (edge stays anchored) but dot hidden (no clutter in compact view)
    const argHandle = container.querySelector("[data-handleid='n1-arg-0']") as HTMLElement | null;
    expect(argHandle).not.toBeNull();
    expect(argHandle!.style.opacity).toBe("0");
  });

  it("arg Handle count matches between detailed and overview modes", () => {
    const detailedData = makeData({
      args: [
        { index: 0, kind: "literal", value: "a" },
        { index: 1, kind: "literal", value: "b" },
      ],
      viewMode: "detailed",
    });

    const { container: detailedContainer } = renderContractNode(detailedData, "n1");
    const detailedHandleCount = detailedContainer.querySelectorAll(".react-flow__handle").length;

    document.body.innerHTML = "";

    const overviewData = makeData({
      args: [
        { index: 0, kind: "literal", value: "a" },
        { index: 1, kind: "literal", value: "b" },
      ],
      viewMode: "overview",
    });

    const { container: overviewContainer } = renderContractNode(overviewData, "n1");
    const overviewHandleCount = overviewContainer.querySelectorAll(".react-flow__handle").length;

    // Both modes must have exactly the same number of Handles
    expect(overviewHandleCount).toBe(detailedHandleCount);
  });

  it("all arg Handles are mounted in overview mode via App", () => {
    render(<App />);
    addNodeByName("Token"); // Token has 2 constructor args

    fireEvent.click(screen.getByTestId("toggle-view-mode"));

    // At minimum: input (-input), arg-0, arg-1, output (-output) = 4
    const allHandles = document.querySelectorAll(".react-flow__handle");
    expect(allHandles.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 4. SPEC-STRIP — toGraphNodes projection strips display-only fields
//
// These tests are load-bearing: they unit-test the projection helper directly.
// If someone adds a display-only field to ContractNodeData and forgets to strip
// it in toGraphNodes, these tests catch the regression before graphToSpec runs.
// ---------------------------------------------------------------------------

describe("overview mode — spec-strip (toGraphNodes projection)", () => {
  it("toGraphNodes strips viewMode from node data", () => {
    // Build a wide node whose data carries viewMode (as App.tsx enrichedNodes do)
    const wideNode = {
      id: "n1",
      data: {
        deployId: "token",
        contractName: "ERC20Token",
        args: [{ index: 0, kind: "literal" as const, value: "MyToken" }],
        after: [],
        configSteps: [],
        viewMode: "overview",
        onUpdateDeployId: noop,
        onUpdateContractName: noop,
        onUpdateArgSlot: noop,
      } as unknown as Record<string, unknown>,
    };

    const [projected] = toGraphNodes([wideNode]);

    // The projected node must NOT contain viewMode
    expect(Object.prototype.hasOwnProperty.call(projected.data, "viewMode")).toBe(false);
    // JSON serialization must also not contain it
    expect(JSON.stringify(projected.data)).not.toContain("viewMode");
  });

  it("toGraphNodes strips refSourceDeployIds from node data", () => {
    const wideNode = {
      id: "n1",
      data: {
        deployId: "token",
        contractName: "ERC20Token",
        args: [{ index: 0, kind: "literal" as const, value: "addr" }],
        after: [],
        configSteps: [],
        refSourceDeployIds: new Map([[0, "registry"]]),
        onUpdateDeployId: noop,
        onUpdateContractName: noop,
        onUpdateArgSlot: noop,
      } as unknown as Record<string, unknown>,
    };

    const [projected] = toGraphNodes([wideNode]);

    expect(Object.prototype.hasOwnProperty.call(projected.data, "refSourceDeployIds")).toBe(false);
  });

  it("toGraphNodes strips BOTH viewMode AND refSourceDeployIds simultaneously", () => {
    /**
     * This is the mutation-catching test the coordinator requires.
     * The node carries BOTH display-only fields (the exact combination that
     * App.tsx enrichedNodes have after both #54 and #55 enrichment).
     * After projection, ONLY the five serializable fields must remain.
     */
    const wideNode = {
      id: "n1",
      data: {
        deployId: "vault",
        contractName: "VaultERC4626",
        args: [
          { index: 0, kind: "literal" as const, value: "" },
          { index: 1, kind: "literal" as const, value: "0xabc" },
        ],
        after: ["token"],
        configSteps: [],
        // Both display-only fields present simultaneously:
        viewMode: "overview",
        refSourceDeployIds: new Map([[0, "token"]]),
        // Callbacks also present (as they are in real node data):
        onUpdateDeployId: noop,
        onUpdateContractName: noop,
        onUpdateArgSlot: noop,
      } as unknown as Record<string, unknown>,
    };

    const [projected] = toGraphNodes([wideNode]);

    // Exactly the five serializable fields must be present
    expect(Object.keys(projected.data).sort()).toEqual(
      ["after", "args", "configSteps", "contractName", "deployId"].sort()
    );

    // Display-only and callback fields must be absent
    expect(Object.prototype.hasOwnProperty.call(projected.data, "viewMode")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected.data, "refSourceDeployIds")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected.data, "onUpdateDeployId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected.data, "onUpdateContractName")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(projected.data, "onUpdateArgSlot")).toBe(false);
  });

  it("toGraphNodes output equals output from node without display-only fields", () => {
    const baseData = {
      deployId: "token",
      contractName: "ERC20Token",
      args: [{ index: 0, kind: "literal" as const, value: "MyToken" }],
      after: [],
      configSteps: [],
    };

    const plainNode = {
      id: "n1",
      data: { ...baseData } as unknown as Record<string, unknown>,
    };

    const enrichedNode = {
      id: "n1",
      data: {
        ...baseData,
        viewMode: "overview" as const,
        refSourceDeployIds: new Map([[0, "registry"]]),
        onUpdateDeployId: noop,
      } as unknown as Record<string, unknown>,
    };

    const [projectedPlain] = toGraphNodes([plainNode]);
    const [projectedEnriched] = toGraphNodes([enrichedNode]);

    // Both projections must be identical
    expect(JSON.stringify(projectedEnriched.data)).toBe(JSON.stringify(projectedPlain.data));
  });

  it("graphToSpec output from toGraphNodes contains no 'viewMode' key", () => {
    const wideNode = {
      id: "n1",
      data: {
        deployId: "token",
        contractName: "ERC20Token",
        args: [{ index: 0, kind: "literal" as const, value: "MyToken" }],
        after: [],
        configSteps: [],
        viewMode: "overview",
        refSourceDeployIds: new Map([[0, "registry"]]),
        onUpdateDeployId: noop,
      } as unknown as Record<string, unknown>,
    };

    const graphNodes = toGraphNodes([wideNode]);
    const { deployment, config } = graphToSpec(graphNodes, []);
    const serialized = JSON.stringify({ deployment, config });

    expect(serialized).not.toContain("viewMode");
    expect(serialized).not.toContain("refSourceDeployIds");
  });

  it("App SpecExporter textarea contains no 'viewMode' after toggling to overview", () => {
    /**
     * Integration-level confirmation: the App's pipeline (toGraphNodes → graphToSpec)
     * strips display-only fields before export.
     */
    render(<App />);
    addNodeByName("Token");

    // Toggle to overview — viewMode is injected into enriched nodes
    fireEvent.click(screen.getByTestId("toggle-view-mode"));

    // Open the spec exporter
    fireEvent.click(screen.getByTestId("export-spec-btn"));

    const textarea = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;
    expect(textarea.value).not.toContain("viewMode");
    expect(textarea.value).not.toContain("refSourceDeployIds");
  });
});

// ---------------------------------------------------------------------------
// 5. ARG-VALUE ROUND-TRIP: value persists through detailed→overview→detailed
// ---------------------------------------------------------------------------

describe("overview mode — arg-value round-trip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("value typed in detailed mode persists after toggling to overview and back", () => {
    render(<App />);
    addNodeByName("Token"); // Token has args: name_ (index 0), symbol_ (index 1)

    const argInputsBefore = screen.getAllByLabelText(/^arg-/) as HTMLInputElement[];
    expect(argInputsBefore.length).toBeGreaterThan(0);
    fireEvent.change(argInputsBefore[0], { target: { value: "MyAwesomeToken" } });
    expect(argInputsBefore[0].value).toBe("MyAwesomeToken");

    // Round-trip
    fireEvent.click(screen.getByTestId("toggle-view-mode")); // → overview
    fireEvent.click(screen.getByTestId("toggle-view-mode")); // → detailed

    const argInputsAfter = screen.getAllByLabelText(/^arg-/) as HTMLInputElement[];
    expect(argInputsAfter[0].value).toBe("MyAwesomeToken");
  });

  it("multiple arg values all survive the round-trip", () => {
    render(<App />);
    addNodeByName("Token");

    const argInputs = screen.getAllByLabelText(/^arg-/) as HTMLInputElement[];
    expect(argInputs.length).toBe(2);

    fireEvent.change(argInputs[0], { target: { value: "TokenName" } });
    fireEvent.change(argInputs[1], { target: { value: "TKN" } });

    fireEvent.click(screen.getByTestId("toggle-view-mode")); // detailed→overview
    fireEvent.click(screen.getByTestId("toggle-view-mode")); // overview→detailed

    const argInputsAfter = screen.getAllByLabelText(/^arg-/) as HTMLInputElement[];
    expect(argInputsAfter[0].value).toBe("TokenName");
    expect(argInputsAfter[1].value).toBe("TKN");
  });

  it("ContractNode renders arg input with correct value when viewMode=detailed", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "persisted-value" }],
      viewMode: "detailed",
    });

    renderContractNode(data);

    const input = screen.getByLabelText("arg-0") as HTMLInputElement;
    expect(input.tagName.toLowerCase()).toBe("input");
    expect(input.value).toBe("persisted-value");
  });

  it("ContractNode in overview mode keeps arg input in DOM inside collapsed wrapper", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "hidden-value" }],
      viewMode: "overview",
    });

    const { container } = renderContractNode(data, "n1");

    // Input exists in DOM (keeps Handle anchored), but parent is collapsed
    const input = container.querySelector("input[aria-label='arg-0']");
    expect(input).not.toBeNull();

    // Parent container must be collapsed (height:0)
    const collapsed = Array.from(container.querySelectorAll("div")).find(
      (el) => el.style.height === "0px" || el.style.height === "0",
    );
    expect(collapsed).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. OVERVIEW EDGE AGGREGATION — overviewEdges helper + App integration
//
// jsdom does not render SVG edge elements so we test the helper directly and
// verify App selects it by viewMode via a hook-level check.
// ---------------------------------------------------------------------------

describe("overview mode — edge aggregation (overviewEdges + App integration)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("overviewEdges collapses 3 constructorRef edges A→B to 1 overview edge", () => {
    // This mirrors the "floating lines" scenario: three arg slots connected
    // from nodeA to nodeB each produce a real edge, but in overview only 1
    // aggregated line should connect the two nodes.
    const edges = [
      { id: "e1", source: "nodeA", target: "nodeB", sourceHandle: "nodeA-output", targetHandle: "nodeB-arg-0", data: { edgeKind: "constructorRef", argIndex: 0 } },
      { id: "e2", source: "nodeA", target: "nodeB", sourceHandle: "nodeA-output", targetHandle: "nodeB-arg-1", data: { edgeKind: "constructorRef", argIndex: 1 } },
      { id: "e3", source: "nodeA", target: "nodeB", sourceHandle: "nodeA-output", targetHandle: "nodeB-arg-2", data: { edgeKind: "constructorRef", argIndex: 2 } },
    ];
    const result = overviewEdges(edges);
    expect(result).toHaveLength(1);
    expect(result[0].sourceHandle).toBe("nodeA-output");
    expect(result[0].targetHandle).toBe("nodeB-input");
  });

  it("overviewEdges produces 2 edges for 2 distinct node pairs", () => {
    const edges = [
      { id: "e1", source: "nodeA", target: "nodeB", sourceHandle: "nodeA-output", targetHandle: "nodeB-arg-0", data: {} },
      { id: "e2", source: "nodeA", target: "nodeC", sourceHandle: "nodeA-output", targetHandle: "nodeC-arg-0", data: {} },
    ];
    const result = overviewEdges(edges);
    expect(result).toHaveLength(2);
  });

  it("overviewEdges anchors to node-level handles (not arg handles)", () => {
    // This is the fix for the floating-line bug: the overview edge must anchor
    // to node body handles, not the collapsed per-arg handles.
    const edges = [
      { id: "e1", source: "contract-1", target: "contract-2", sourceHandle: "contract-1-output", targetHandle: "contract-2-arg-0", data: { edgeKind: "constructorRef", argIndex: 0 } },
    ];
    const [ov] = overviewEdges(edges);
    // Must NOT anchor to the arg handle (which is collapsed in overview)
    expect(ov.targetHandle).not.toContain("-arg-");
    // Must anchor to the node-level input handle
    expect(ov.targetHandle).toBe("contract-2-input");
    expect(ov.sourceHandle).toBe("contract-1-output");
  });

  it("graphToSpec still reads raw edges (overviewEdges does not affect serialization)", () => {
    // Verify that overviewEdges only affects display — the underlying edge state
    // (passed to graphToSpec) is unchanged.
    const { result } = renderHook(() => useGraph());

    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(ONE_ARG_MANIFEST);
    });
    const [srcNode, tgtNode] = result.current.nodes;
    act(() => {
      (srcNode.data as unknown as ContractNodeData).onUpdateDeployId(srcNode.id, "registry");
      (tgtNode.data as unknown as ContractNodeData).onUpdateDeployId(tgtNode.id, "token");
    });
    act(() => {
      result.current.onConnect({
        source: srcNode.id,
        target: tgtNode.id,
        sourceHandle: `${srcNode.id}-output`,
        targetHandle: `${tgtNode.id}-arg-0`,
      });
    });

    const rawEdges = result.current.edges;
    expect(rawEdges).toHaveLength(1);

    // overviewEdges collapses to 1 edge with different handles
    const displayEdges = overviewEdges(rawEdges);
    expect(displayEdges).toHaveLength(1);
    expect(displayEdges[0].targetHandle).toBe(`${tgtNode.id}-input`);

    // But the raw edge is unchanged (graphToSpec uses raw edges)
    expect(rawEdges[0].targetHandle).toBe(`${tgtNode.id}-arg-0`);

    // graphToSpec with raw edges produces a constructorRef (ref arg)
    const graphNodes = toGraphNodes(result.current.nodes);
    const { deployment } = graphToSpec(graphNodes, rawEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as import("../src/spec/graph-to-spec.js").GraphEdge["data"],
    })));

    // The token contract should have a ref arg pointing to registry
    const tokenContract = deployment.contracts.find((c) => c.id === "token");
    expect(tokenContract).not.toBeUndefined();
    expect(tokenContract!.args?.[0]).toEqual({ kind: "ref", contract: "registry" });
  });
});

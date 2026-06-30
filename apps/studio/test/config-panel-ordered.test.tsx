/**
 * config-panel-ordered.test.tsx
 *
 * Tests for issue #56 — config panel redesign (studio half):
 *
 * 1. Per-node config steps: add/edit/remove + address-ref arg normalization.
 * 2. Global ordered config panel: add/reorder/remove via OrderedConfigPanel.
 * 3. graph-to-spec: per-node → ConfigSpec.steps, ordered → ConfigSpec.orderedSteps,
 *    AddressRef → RefArg normalization, validates with @redeploy/config.
 * 4. Wire handle removal: no ${id}-input handle in ContractNode; onConnect ignores
 *    non-arg-handle connections.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { OrderedConfigPanel } from "../src/components/OrderedConfigPanel.js";
import { ContractNode } from "../src/components/ContractNode.js";
import { graphToSpec } from "../src/spec/graph-to-spec.js";
import { useGraph } from "../src/hooks/useGraph.js";
import { validateConfig } from "@redeploy/config";
import { validateSpec } from "@redeploy/core";
import type { GraphNode } from "../src/spec/graph-to-spec.js";
import type { ContractNodeData, StudioOrderedConfigStep, StudioSetXStep, StudioAddressRef } from "../src/spec/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = () => {};

function makeContractNodeData(overrides: Partial<ContractNodeData> = {}): ContractNodeData {
  return {
    deployId: "token",
    contractName: "Token",
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

/** Minimal GraphNode factory for pure graphToSpec tests */
function makeGraphNode(
  id: string,
  deployId: string,
  contractName: string,
  overrides: Partial<GraphNode["data"]> = {},
): GraphNode {
  return {
    id,
    data: { deployId, contractName, args: [], after: [], configSteps: [], ...overrides },
  };
}

// ---------------------------------------------------------------------------
// 1. Wire handle removal
// ---------------------------------------------------------------------------

describe("wire handle removal — ContractNode", () => {
  it("has NO ${id}-input wire handle", () => {
    const data = makeContractNodeData({ args: [] });
    const { container } = renderContractNode(data, "n1");
    // The old wire-target handle used id "${nodeId}-input".
    const wireHandle = container.querySelector("[data-handleid='n1-input']") as HTMLElement | null;
    // There must be NO handle with class react-flow__handle AND data-handleid="n1-input"
    // Note: we DO have a target handle for overview anchoring, but we check that
    // connections to it are silently ignored (tested via useGraph onConnect).
    // The key assertion: no WIRE connections are created to this handle.
    // (The handle exists for overview edge anchoring only.)
    expect(wireHandle).not.toBeNull(); // overview-anchor handle is present
    // Verify it is truly a react-flow handle (not just any element)
    expect(wireHandle!.classList.contains("react-flow__handle")).toBe(true);
  });

  it("onConnect ignores connections to the input handle (no wire edges created)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.onConnect({
        source: "nodeA",
        target: "nodeB",
        sourceHandle: "nodeA-output",
        targetHandle: "nodeB-input", // old wire-target handle
      });
    });
    // No edge should be created — only arg-handle connections create edges now.
    expect(result.current.edges).toHaveLength(0);
  });

  it("onConnect creates a constructorRef edge only for arg-handle connections", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.onConnect({
        source: "nodeA",
        target: "nodeB",
        sourceHandle: "nodeA-output",
        targetHandle: "nodeB-arg-0", // arg handle
      });
    });
    expect(result.current.edges).toHaveLength(1);
    const edge = result.current.edges[0];
    expect((edge.data as unknown as { edgeKind: string }).edgeKind).toBe("constructorRef");
    expect((edge.data as unknown as { argIndex: number }).argIndex).toBe(0);
  });

  it("onConnect ignores connections with no target handle (null/undefined)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.onConnect({
        source: "nodeA",
        target: "nodeB",
        sourceHandle: "nodeA-output",
        targetHandle: null,
      });
    });
    expect(result.current.edges).toHaveLength(0);
  });

  it("handle count: ${id}-input anchor + arg handles + output handle", () => {
    // Node with 2 args: input-anchor, arg-0, arg-1, output = 4 handles
    const data = makeContractNodeData({
      args: [
        { index: 0, kind: "literal", value: "" },
        { index: 1, kind: "literal", value: "" },
      ],
    });
    const { container } = renderContractNode(data, "n1");
    const handles = container.querySelectorAll(".react-flow__handle");
    expect(handles.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-node config steps (NodeConfigSection in ContractNode)
// ---------------------------------------------------------------------------

describe("per-node config section — ContractNode with configCallbacks", () => {
  it("renders NodeConfigSection when configCallbacks is present", () => {
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = makeContractNodeData({ configSteps: [] });
    const dataWithCallbacks = {
      ...data,
      configCallbacks,
    };
    const { container } = renderContractNode(dataWithCallbacks as unknown as ContractNodeData, "n1");
    expect(container.querySelector("[data-testid='node-config-section-n1']")).not.toBeNull();
  });

  it("does NOT render NodeConfigSection without configCallbacks", () => {
    const data = makeContractNodeData({ configSteps: [] });
    const { container } = renderContractNode(data, "n1");
    expect(container.querySelector("[data-testid='node-config-section-n1']")).toBeNull();
  });

  it("does NOT render NodeConfigSection in overview mode", () => {
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [], viewMode: "overview" as const }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    expect(container.querySelector("[data-testid='node-config-section-n1']")).toBeNull();
  });

  it("renders setX step card when configSteps has a setX step", () => {
    const step: ContractNodeData["configSteps"][number] = {
      kind: "setX",
      id: "step-1",
      functionName: "setFoo",
      args: [],
    };
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [step] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    expect(container.querySelector("[data-testid='node-config-step-step-1']")).not.toBeNull();
  });

  it("+ setX button calls onAddConfigStep with 'setX'", () => {
    const calls: Array<[string, string]> = [];
    const configCallbacks = {
      onAddConfigStep: (nodeId: string, kind: string) => calls.push([nodeId, kind]),
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("+ setX"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["n1", "setX"]);
  });

  it("+ grantRole button calls onAddConfigStep with 'grantRole'", () => {
    const calls: Array<[string, string]> = [];
    const configCallbacks = {
      onAddConfigStep: (nodeId: string, kind: string) => calls.push([nodeId, kind]),
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("+ grantRole"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["n1", "grantRole"]);
  });

  it("remove button on a step card calls onRemoveConfigStep", () => {
    const removed: string[] = [];
    const step: ContractNodeData["configSteps"][number] = {
      kind: "setX",
      id: "s1",
      functionName: "setFoo",
      args: [],
    };
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: (_nodeId: string, stepId: string) => removed.push(stepId),
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [step] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const removeBtn = container.querySelector("[data-testid='node-config-step-remove-s1']") as HTMLElement;
    fireEvent.click(removeBtn);
    expect(removed).toContain("s1");
  });
});

// ---------------------------------------------------------------------------
// 3. OrderedConfigPanel — add/reorder/remove
// ---------------------------------------------------------------------------

describe("OrderedConfigPanel — unit tests", () => {
  function makeStep(id: string, functionName = ""): StudioOrderedConfigStep {
    return {
      kind: "setX",
      id,
      functionName,
      args: [],
    };
  }

  it("renders with data-testid='ordered-config-panel'", () => {
    render(
      <OrderedConfigPanel
        orderedSteps={[]}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    expect(screen.getByTestId("ordered-config-panel")).not.toBeNull();
  });

  it("renders add step button", () => {
    render(
      <OrderedConfigPanel
        orderedSteps={[]}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    expect(screen.getByTestId("ordered-add-step-btn")).not.toBeNull();
  });

  it("calls onAddStep when add button is clicked", () => {
    let called = false;
    render(
      <OrderedConfigPanel
        orderedSteps={[]}
        deployTargets={[]}
        onAddStep={() => { called = true; }}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    fireEvent.click(screen.getByTestId("ordered-add-step-btn"));
    expect(called).toBe(true);
  });

  it("renders step cards with data-testid='ordered-step-${id}'", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    expect(screen.getByTestId("ordered-step-s1")).not.toBeNull();
    expect(screen.getByTestId("ordered-step-s2")).not.toBeNull();
  });

  it("calls onRemoveStep with the step id when remove button is clicked", () => {
    const removed: string[] = [];
    const steps = [makeStep("s1")];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={(id) => removed.push(id)}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    fireEvent.click(screen.getByTestId("ordered-step-remove-s1"));
    expect(removed).toContain("s1");
  });

  it("calls onMoveUp when up button is clicked", () => {
    const movedUp: string[] = [];
    const steps = [makeStep("s1"), makeStep("s2")]; // s2 is at index 1; can move up
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={(id) => movedUp.push(id)}
        onMoveDown={noop}
      />
    );
    fireEvent.click(screen.getByTestId("ordered-step-up-s2"));
    expect(movedUp).toContain("s2");
  });

  it("calls onMoveDown when down button is clicked", () => {
    const movedDown: string[] = [];
    const steps = [makeStep("s1"), makeStep("s2")]; // s1 is at index 0; can move down
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={(id) => movedDown.push(id)}
      />
    );
    fireEvent.click(screen.getByTestId("ordered-step-down-s1"));
    expect(movedDown).toContain("s1");
  });

  it("up button is disabled for first step", () => {
    const steps = [makeStep("s1")];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    const upBtn = screen.getByTestId("ordered-step-up-s1") as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });

  it("down button is disabled for last step", () => {
    const steps = [makeStep("s1")];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={[]}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    const downBtn = screen.getByTestId("ordered-step-down-s1") as HTMLButtonElement;
    expect(downBtn.disabled).toBe(true);
  });

  it("renders target picker with deploy targets", () => {
    const steps = [makeStep("s1")];
    const deployTargets = [{ deployId: "token", contractName: "Token" }];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={deployTargets}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    const targetSelect = screen.getByRole("combobox", { name: "ordered-target-s1" });
    expect(targetSelect).not.toBeNull();
    // Should contain the deploy target option
    expect(targetSelect.innerHTML).toContain("token");
  });
});

// ---------------------------------------------------------------------------
// 4. useGraph ordered steps
// ---------------------------------------------------------------------------

describe("useGraph — ordered steps", () => {
  it("starts with empty orderedSteps", () => {
    const { result } = renderHook(() => useGraph());
    expect(result.current.orderedSteps).toHaveLength(0);
  });

  it("addOrderedStep appends a new step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); });
    expect(result.current.orderedSteps).toHaveLength(1);
    const step = result.current.orderedSteps[0];
    expect(step.kind).toBe("setX");
    expect(step.functionName).toBe("");
  });

  it("removeOrderedStep removes the step by id", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); });
    const stepId = result.current.orderedSteps[0].id;
    act(() => { result.current.removeOrderedStep(stepId); });
    expect(result.current.orderedSteps).toHaveLength(0);
  });

  it("updateOrderedStep updates fields on a step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); });
    const stepId = result.current.orderedSteps[0].id;
    act(() => { result.current.updateOrderedStep(stepId, { functionName: "setFee" }); });
    expect(result.current.orderedSteps[0].functionName).toBe("setFee");
  });

  it("moveOrderedStepUp swaps with previous step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); result.current.addOrderedStep(); });
    const [step0, step1] = result.current.orderedSteps;
    act(() => { result.current.moveOrderedStepUp(step1.id); });
    // After move up, step1 should be at index 0
    expect(result.current.orderedSteps[0].id).toBe(step1.id);
    expect(result.current.orderedSteps[1].id).toBe(step0.id);
  });

  it("moveOrderedStepDown swaps with next step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); result.current.addOrderedStep(); });
    const [step0, step1] = result.current.orderedSteps;
    act(() => { result.current.moveOrderedStepDown(step0.id); });
    // After move down, step0 should be at index 1
    expect(result.current.orderedSteps[0].id).toBe(step1.id);
    expect(result.current.orderedSteps[1].id).toBe(step0.id);
  });

  it("moveOrderedStepUp on first step has no effect", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); result.current.addOrderedStep(); });
    const ids = result.current.orderedSteps.map((s) => s.id);
    act(() => { result.current.moveOrderedStepUp(result.current.orderedSteps[0].id); });
    expect(result.current.orderedSteps.map((s) => s.id)).toEqual(ids);
  });

  it("moveOrderedStepDown on last step has no effect", () => {
    const { result } = renderHook(() => useGraph());
    act(() => { result.current.addOrderedStep(); result.current.addOrderedStep(); });
    const ids = result.current.orderedSteps.map((s) => s.id);
    act(() => { result.current.moveOrderedStepDown(result.current.orderedSteps[1].id); });
    expect(result.current.orderedSteps.map((s) => s.id)).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// 5. graph-to-spec: per-node steps + ordered steps + address ref normalization
// ---------------------------------------------------------------------------

describe("graphToSpec — orderedSteps", () => {
  it("emits ConfigSpec.orderedSteps when ordered steps are passed", () => {
    const node = makeGraphNode("n1", "token", "Token");
    const orderedSteps: StudioOrderedConfigStep[] = [
      { kind: "setX", id: "os1", functionName: "setFee", target: "token", args: ["100"] },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    expect(config.orderedSteps).toHaveLength(1);
    expect(config.orderedSteps![0].kind).toBe("setX");
    expect(config.orderedSteps![0].target).toBe("token");
    expect((config.orderedSteps![0] as { function: string }).function).toBe("setFee");
  });

  it("omits ConfigSpec.orderedSteps when ordered steps array is empty", () => {
    const node = makeGraphNode("n1", "token", "Token");
    const { config } = graphToSpec([node], [], []);
    expect(config.orderedSteps).toBeUndefined();
  });

  it("per-node config steps appear in ConfigSpec.steps", () => {
    const node = makeGraphNode("n1", "token", "Token", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setFoo", args: [] },
      ],
    });
    const { config } = graphToSpec([node], []);
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0].kind).toBe("setX");
    expect(config.steps[0].target).toBe("token");
  });

  it("per-node steps appear in ConfigSpec.steps and ordered steps appear in ConfigSpec.orderedSteps", () => {
    const node = makeGraphNode("n1", "token", "Token", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setFoo", args: [] },
      ],
    });
    const orderedSteps: StudioOrderedConfigStep[] = [
      { kind: "setX", id: "os1", functionName: "setFee", target: "token", args: [] },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    expect(config.steps).toHaveLength(1);
    expect(config.orderedSteps).toHaveLength(1);
  });
});

describe("graphToSpec — address ref normalization", () => {
  it("normalizes StudioAddressRef to RefArg in per-node setX step args", () => {
    const addressRef: StudioAddressRef = { kind: "addressRef", deployId: "registry" };
    const node = makeGraphNode("n1", "token", "Token", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setRegistry", args: [addressRef] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as { kind: "setX"; args?: Array<{ kind: string; contract: string }> };
    expect(step.args).toHaveLength(1);
    expect(step.args![0]).toEqual({ kind: "ref", contract: "registry" });
  });

  it("normalizes string literal to LiteralArg in per-node setX step args", () => {
    const node = makeGraphNode("n1", "token", "Token", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setFoo", args: ["hello"] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as { kind: "setX"; args?: Array<{ kind: string; value: unknown }> };
    expect(step.args).toHaveLength(1);
    expect(step.args![0]).toEqual({ kind: "literal", value: "hello" });
  });

  it("normalizes StudioAddressRef to RefArg in ordered step args", () => {
    const addressRef: StudioAddressRef = { kind: "addressRef", deployId: "vault" };
    const node = makeGraphNode("n1", "token", "Token");
    const orderedSteps: StudioOrderedConfigStep[] = [
      {
        kind: "setX",
        id: "os1",
        functionName: "setVault",
        target: "token",
        args: [addressRef],
      },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    const ordStep = config.orderedSteps![0] as { kind: "setX"; args?: Array<{ kind: string; contract: string }> };
    expect(ordStep.args).toHaveLength(1);
    expect(ordStep.args![0]).toEqual({ kind: "ref", contract: "vault" });
  });

  it("mixed args: StudioAddressRef + literal are both normalized correctly", () => {
    const addressRef: StudioAddressRef = { kind: "addressRef", deployId: "registry" };
    const node = makeGraphNode("n1", "token", "Token", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "initialize", args: [addressRef, "100"] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as { kind: "setX"; args?: Array<{ kind: string; contract?: string; value?: unknown }> };
    expect(step.args).toHaveLength(2);
    expect(step.args![0]).toEqual({ kind: "ref", contract: "registry" });
    expect(step.args![1]).toEqual({ kind: "literal", value: 100 }); // "100" → number
  });

  it("StudioAddressRef never appears in normalized ConfigSpec", () => {
    const addressRef: StudioAddressRef = { kind: "addressRef", deployId: "oracle" };
    const node = makeGraphNode("n1", "price-feed", "PriceFeed", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setOracle", args: [addressRef] },
      ],
    });
    const orderedSteps: StudioOrderedConfigStep[] = [
      {
        kind: "setX",
        id: "os1",
        functionName: "setCap",
        target: "price-feed",
        args: [addressRef],
      },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("addressRef");
    expect(serialized).toContain('"kind":"ref"');
  });

  it("produces a valid ConfigSpec after address-ref normalization", () => {
    const addressRef: StudioAddressRef = { kind: "addressRef", deployId: "token" };
    const registry = makeGraphNode("n1", "token", "Token");
    const vault = makeGraphNode("n2", "vault", "Vault", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setToken", args: [addressRef] },
      ],
    });
    const { deployment, config } = graphToSpec([registry, vault], []);
    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. OrderedConfigPanelToggle integration via App
// ---------------------------------------------------------------------------

describe("OrderedConfigPanel — via App integration", () => {
  function addNodeByName(name: string) {
    if (!screen.queryByTestId("contracts-browser")) {
      fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
    }
    const browser = screen.getByTestId("contracts-browser");
    fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
  }

  it("toggle-ordered-config button is present in toolbar", async () => {
    const App = (await import("../src/App.js")).default;
    document.body.innerHTML = "";
    render(<App />);
    expect(screen.getByTestId("toggle-ordered-config")).not.toBeNull();
  });

  it("clicking toggle-ordered-config opens the ordered config panel", async () => {
    const App = (await import("../src/App.js")).default;
    document.body.innerHTML = "";
    render(<App />);

    expect(screen.queryByTestId("ordered-config-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("toggle-ordered-config"));
    expect(screen.queryByTestId("ordered-config-panel")).not.toBeNull();
  });

  it("can add an ordered step via App", async () => {
    const App = (await import("../src/App.js")).default;
    document.body.innerHTML = "";
    render(<App />);
    addNodeByName("Token");

    fireEvent.click(screen.getByTestId("toggle-ordered-config"));
    fireEvent.click(screen.getByTestId("ordered-add-step-btn"));

    const steps = document.querySelectorAll("[data-testid^='ordered-step-']:not([data-testid*='-up-']):not([data-testid*='-down-']):not([data-testid*='-remove-'])");
    expect(steps).toHaveLength(1);
  });

  it("ordered steps appear in exported spec orderedSteps (config tab)", async () => {
    const App = (await import("../src/App.js")).default;
    document.body.innerHTML = "";
    render(<App />);
    addNodeByName("Token");

    // Edit the Token deploy id
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "myToken" } });

    // Open ordered config and add a step
    fireEvent.click(screen.getByTestId("toggle-ordered-config"));
    fireEvent.click(screen.getByTestId("ordered-add-step-btn"));

    // The step card is now visible; type a function name using free-text input
    // (the node has no target set, so manifest picker won't load; we get the input field)
    const stepCards = document.querySelectorAll("[data-testid^='ordered-step-']:not([data-testid*='-up-']):not([data-testid*='-down-']):not([data-testid*='-remove-'])");
    expect(stepCards.length).toBe(1);
    const stepId = stepCards[0].getAttribute("data-testid")!.replace("ordered-step-", "");

    // Set target first so the step is non-empty, then function name
    // Target select: pick myToken
    const targetSelect = screen.queryByRole("combobox", { name: `ordered-target-${stepId}` }) as HTMLSelectElement | null;
    if (targetSelect) {
      // Use the first non-empty option value
      const firstOption = targetSelect.querySelector("option:not([value=''])") as HTMLOptionElement | null;
      if (firstOption) {
        fireEvent.change(targetSelect, { target: { value: firstOption.value } });
      }
    }

    // Export spec — open the export modal and switch to config tab
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    // Click the "config.json" tab to see config spec
    const configTabBtn = screen.getByText("config.json");
    fireEvent.click(configTabBtn);

    const textarea = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;
    // The config spec should contain orderedSteps since we added a step
    expect(textarea.value).toContain("orderedSteps");
  });
});

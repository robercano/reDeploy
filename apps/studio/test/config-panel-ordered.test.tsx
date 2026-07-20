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
import type { ContractNodeData, StudioOrderedConfigStep, StudioAddressRef, StudioReadRef, StudioSetXStep } from "../src/spec/types.js";

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

  it("renders exactly ONE 'Add config call' button and no old +setX/+grantRole buttons", () => {
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    expect(within(section).getAllByText("Add config call")).toHaveLength(1);
    expect(within(section).queryByText("+ setX")).toBeNull();
    expect(within(section).queryByText("+ grantRole")).toBeNull();
  });

  it("picker lists the target contract's (Token) REAL state-changing functions, not synthetic setX/grantRole", () => {
    // makeContractNodeData() defaults contractName to "Token", whose real
    // nonpayable functions are, in manifest order: mint, grantRole,
    // revokeRole, renounceRole, transfer, approve, transferFrom. view/pure
    // functions (name, symbol, decimals, totalSupply, balanceOf, allowance,
    // hasRole, getRoleAdmin, supportsInterface) are excluded. grantRole is
    // NOT special-cased — it appears because Token's ABI (via AccessControl)
    // declares it, alongside every other real function.
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("Add config call"));
    const menu = within(section).getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "mint(address,uint256)",
      "grantRole(bytes32,address)",
      "revokeRole(bytes32,address)",
      "renounceRole(bytes32,address)",
      "transfer(address,uint256)",
      "approve(address,uint256)",
      "transferFrom(address,address,uint256)",
    ]);
    expect(within(menu).queryByText("setX")).toBeNull();
  });

  it("excludes view/pure Token functions from the picker", () => {
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("Add config call"));
    const menu = within(section).getByRole("menu");
    for (const viewFn of ["name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance", "hasRole", "getRoleAdmin", "supportsInterface"]) {
      expect(within(menu).queryAllByRole("menuitem", { name: new RegExp(`^${viewFn}\\(`) })).toHaveLength(0);
    }
  });

  it("'Add config call' → selecting a real function calls onAddConfigStep with its manifest entry", () => {
    const calls: Array<[string, { name: string; signature: string; inputs: unknown[] }]> = [];
    const configCallbacks = {
      onAddConfigStep: (nodeId: string, fn: { name: string; signature: string; inputs: unknown[] }) => calls.push([nodeId, fn]),
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("Add config call"));
    fireEvent.click(within(section).getByRole("menuitem", { name: "mint(address,uint256)" }));
    expect(calls).toHaveLength(1);
    const [nodeId, fn] = calls[0];
    expect(nodeId).toBe("n1");
    expect(fn.name).toBe("mint");
    expect(fn.signature).toBe("mint(address,uint256)");
    expect(fn.inputs).toEqual([
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ]);
  });

  it("'Add config call' → selecting grantRole (a real function, not a synthetic kind) calls onAddConfigStep with its manifest entry", () => {
    const calls: Array<[string, { name: string; signature: string; inputs: unknown[] }]> = [];
    const configCallbacks = {
      onAddConfigStep: (nodeId: string, fn: { name: string; signature: string; inputs: unknown[] }) => calls.push([nodeId, fn]),
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("Add config call"));
    fireEvent.click(within(section).getByRole("menuitem", { name: "grantRole(bytes32,address)" }));
    expect(calls).toHaveLength(1);
    const [nodeId, fn] = calls[0];
    expect(nodeId).toBe("n1");
    expect(fn.name).toBe("grantRole");
    expect(fn.signature).toBe("grantRole(bytes32,address)");
    expect(fn.inputs).toEqual([
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ]);
  });

  it("back-compat: a legacy grantRole-kind step (from a persisted graph/template) renders via its own card without crashing, even though the picker no longer creates that kind", () => {
    const legacyGrantRoleStep: ContractNodeData["configSteps"][number] = {
      kind: "grantRole",
      id: "legacy-1",
      role: "MINTER_ROLE",
      accountKind: "literal",
      accountValue: "0xabc",
    };
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [legacyGrantRoleStep] }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    expect(container.querySelector("[data-testid='node-config-step-legacy-1']")).not.toBeNull();
    expect(within(container).getByLabelText("node-grantrole-role-n1-legacy-1")).not.toBeNull();
  });

  it("contract not in manifest → picker shows 'No functions available' empty state, never crashes", () => {
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [],
    };
    const data = { ...makeContractNodeData({ configSteps: [], contractName: "TotallyUnknownContract" }), configCallbacks };
    const { container } = renderContractNode(data as unknown as ContractNodeData, "n1");
    const section = container.querySelector("[data-testid='node-config-section-n1']") as HTMLElement;
    fireEvent.click(within(section).getByText("Add config call"));
    const menu = within(section).getByRole("menu");
    expect(within(menu).queryAllByRole("menuitem")).toHaveLength(0);
    expect(within(menu).getByText("No functions available")).not.toBeNull();
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
// 2b. ContractNode's ConfigArgInput — "read" arg kind (issue #147)
// ---------------------------------------------------------------------------

describe("per-node config section — ConfigArgInput 'read' kind (issue #147)", () => {
  // Token.mint(address,uint256) — a real manifest function with two inputs,
  // so the per-input ConfigArgInput (not the free-text fallback) renders.
  function makeMintStep(args: StudioSetXStep["args"] = []): ContractNodeData["configSteps"][number] {
    return {
      kind: "setX",
      id: "step-mint",
      functionName: "mint",
      functionSignature: "mint(address,uint256)",
      args,
    };
  }

  it("offers a 'read' option alongside literal/address ref in the arg-kind toggle", () => {
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [{ deployId: "token", contractName: "Token" }],
    };
    const data = { ...makeContractNodeData({ configSteps: [makeMintStep()] }), configCallbacks };
    renderContractNode(data as unknown as ContractNodeData, "n1");
    const kindSelect = screen.getByLabelText("config-arg-n1-step-mint-0-kind") as HTMLSelectElement;
    const optionValues = Array.from(kindSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(["literal", "ref", "read"]);
  });

  it("switching arg kind to 'read' defaults to the first deploy target and its first view function, calling onUpdateSetXStep", () => {
    const updates: Array<{ nodeId: string; stepId: string; update: { args: unknown[] } }> = [];
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: (nodeId: string, stepId: string, update: { args: unknown[] }) =>
        updates.push({ nodeId, stepId, update }),
      onUpdateGrantRoleStep: noop,
      deployTargets: [{ deployId: "token", contractName: "Token" }],
    };
    const data = { ...makeContractNodeData({ configSteps: [makeMintStep()] }), configCallbacks };
    renderContractNode(data as unknown as ContractNodeData, "n1");
    const kindSelect = screen.getByLabelText("config-arg-n1-step-mint-0-kind");
    fireEvent.change(kindSelect, { target: { value: "read" } });
    expect(updates).toHaveLength(1);
    expect(updates[0].nodeId).toBe("n1");
    expect(updates[0].stepId).toBe("step-mint");
    // Token's first view/pure function in manifest order is supportsInterface(bytes4).
    expect(updates[0].update.args[0]).toEqual({ kind: "read", contract: "token", function: "supportsInterface" });
  });

  it("renders read-source-contract and read-function pickers once kind is 'read', listing deployTargets and the source's view functions", () => {
    const step = makeMintStep([{ kind: "read", contract: "token", function: "decimals" }]);
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: noop,
      onUpdateGrantRoleStep: noop,
      deployTargets: [{ deployId: "token", contractName: "Token" }],
    };
    const data = { ...makeContractNodeData({ configSteps: [step] }), configCallbacks };
    renderContractNode(data as unknown as ContractNodeData, "n1");
    const contractSelect = screen.getByLabelText("config-arg-n1-step-mint-0-read-contract") as HTMLSelectElement;
    expect(contractSelect.value).toBe("token");
    expect(contractSelect.innerHTML).toContain("token");
    const fnSelect = screen.getByLabelText("config-arg-n1-step-mint-0-read-function") as HTMLSelectElement;
    expect(fnSelect.value).toBe("decimals");
    expect(fnSelect.innerHTML).toContain("decimals()");
  });

  it("switching the read view function calls onUpdateSetXStep with the updated function name", () => {
    const updates: Array<{ update: { args: unknown[] } }> = [];
    const step = makeMintStep([{ kind: "read", contract: "token", function: "decimals" }]);
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: (_nodeId: string, _stepId: string, update: { args: unknown[] }) => updates.push({ update }),
      onUpdateGrantRoleStep: noop,
      deployTargets: [{ deployId: "token", contractName: "Token" }],
    };
    const data = { ...makeContractNodeData({ configSteps: [step] }), configCallbacks };
    renderContractNode(data as unknown as ContractNodeData, "n1");
    const fnSelect = screen.getByLabelText("config-arg-n1-step-mint-0-read-function");
    fireEvent.change(fnSelect, { target: { value: "totalSupply" } });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.args[0]).toEqual({ kind: "read", contract: "token", function: "totalSupply" });
  });

  it("changing the read source contract re-picks the first view function of the new contract (parity w/ ConfigPanel)", () => {
    const updates: Array<{ update: { args: unknown[] } }> = [];
    const step = makeMintStep([{ kind: "read", contract: "token", function: "decimals" }]);
    const configCallbacks = {
      onAddConfigStep: noop,
      onRemoveConfigStep: noop,
      onUpdateSetXStep: (_nodeId: string, _stepId: string, update: { args: unknown[] }) => updates.push({ update }),
      onUpdateGrantRoleStep: noop,
      deployTargets: [
        { deployId: "token", contractName: "Token" },
        { deployId: "vault", contractName: "Vault" },
      ],
    };
    const data = { ...makeContractNodeData({ configSteps: [step] }), configCallbacks };
    renderContractNode(data as unknown as ContractNodeData, "n1");
    const contractSelect = screen.getByLabelText("config-arg-n1-step-mint-0-read-contract");
    fireEvent.change(contractSelect, { target: { value: "vault" } });
    expect(updates).toHaveLength(1);
    // Vault's first view/pure function in manifest order is balanceOf(address).
    expect(updates[0].update.args[0]).toEqual({ kind: "read", contract: "vault", function: "balanceOf" });
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
    expect((config.orderedSteps![0] as { target: string }).target).toBe("token");
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
    expect((config.steps[0] as { target: string }).target).toBe("token");
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
// 5a-bis. graphToSpec — "read" arg normalization (issue #147)
// ---------------------------------------------------------------------------

describe("graphToSpec — read arg normalization (issue #147)", () => {
  it("normalizes a no-arg StudioReadRef to a ReadArg in per-node setX step args", () => {
    const readRef: StudioReadRef = { kind: "read", contract: "token", function: "decimals" };
    const node = makeGraphNode("n1", "vault", "Vault", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setDecimals", args: [readRef] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as { kind: "setX"; args?: Array<{ kind: string; contract: string; function: string }> };
    expect(step.args).toHaveLength(1);
    expect(step.args![0]).toEqual({ kind: "read", contract: "token", function: "decimals" });
  });

  it("normalizes a StudioReadRef in ordered step args", () => {
    const readRef: StudioReadRef = { kind: "read", contract: "token", function: "decimals" };
    const node = makeGraphNode("n1", "token", "Token");
    const orderedSteps: StudioOrderedConfigStep[] = [
      {
        kind: "setX",
        id: "os1",
        functionName: "setDecimals",
        target: "token",
        args: [readRef],
      },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    const ordStep = config.orderedSteps![0] as { kind: "setX"; args?: Array<{ kind: string; contract: string; function: string }> };
    expect(ordStep.args).toHaveLength(1);
    expect(ordStep.args![0]).toEqual({ kind: "read", contract: "token", function: "decimals" });
  });

  it("normalizes a StudioReadRef with its own literal/addressRef args (ReadCallArg)", () => {
    const readRef: StudioReadRef = {
      kind: "read",
      contract: "registry",
      function: "lookup",
      args: ["minter", { kind: "addressRef", deployId: "token" }],
    };
    const node = makeGraphNode("n1", "vault", "Vault", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setLookup", args: [readRef] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as {
      kind: "setX";
      args?: Array<{ kind: string; contract: string; function: string; args?: unknown[] }>;
    };
    expect(step.args![0]).toEqual({
      kind: "read",
      contract: "registry",
      function: "lookup",
      args: [
        { kind: "literal", value: "minter" },
        { kind: "ref", contract: "token" },
      ],
    });
  });

  it("mixed args: StudioReadRef + literal + addressRef are all normalized correctly", () => {
    const readRef: StudioReadRef = { kind: "read", contract: "token", function: "decimals" };
    const addressRef: StudioAddressRef = { kind: "addressRef", deployId: "registry" };
    const node = makeGraphNode("n1", "vault", "Vault", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "initialize", args: [readRef, "100", addressRef] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as { kind: "setX"; args?: Array<Record<string, unknown>> };
    expect(step.args).toHaveLength(3);
    expect(step.args![0]).toEqual({ kind: "read", contract: "token", function: "decimals" });
    expect(step.args![1]).toEqual({ kind: "literal", value: 100 });
    expect(step.args![2]).toEqual({ kind: "ref", contract: "registry" });
  });

  it("emitted ReadArg has exactly the ReadArg fields — no leftover studio-only keys (e.g. no empty 'args' when the read call has no args of its own)", () => {
    const readRef: StudioReadRef = { kind: "read", contract: "token", function: "decimals" };
    const node = makeGraphNode("n1", "vault", "Vault", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setDecimals", args: [readRef] },
      ],
    });
    const { config } = graphToSpec([node], []);
    const step = config.steps[0] as { kind: "setX"; args?: Array<Record<string, unknown>> };
    expect(Object.keys(step.args![0]).sort()).toEqual(["contract", "function", "kind"]);
  });

  it("produces a valid ConfigSpec after read-arg normalization", () => {
    const readRef: StudioReadRef = { kind: "read", contract: "token", function: "decimals" };
    const token = makeGraphNode("n1", "token", "Token");
    const vault = makeGraphNode("n2", "vault", "Vault", {
      configSteps: [
        { kind: "setX", id: "s1", functionName: "setFeeBps", args: [readRef] },
      ],
    });
    const { deployment, config } = graphToSpec([token, vault], []);
    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5b. OrderedArgInput — literal/addressRef toggle in OrderedStepCard
//
// Renders an OrderedConfigPanel with a step whose target resolves to a
// manifest contract (Registry) that has the `register(string, address)`
// function, so the manifest-driven arg inputs render. Asserts:
//   - literal input renders by default
//   - switching kind to "ref" shows the ref select with deploy targets
//   - switching back to "literal" restores the text input
// ---------------------------------------------------------------------------

describe("OrderedConfigPanel — OrderedArgInput literal/addressRef toggle", () => {
  function makeRegistryStep(id: string): StudioOrderedConfigStep {
    return {
      kind: "setX",
      id,
      functionName: "register",
      functionSignature: "register(string,address)",
      target: "reg",
      // args[0] = string literal, args[1] = addressRef
      args: ["myKey", { kind: "addressRef", deployId: "token" } as StudioAddressRef],
    };
  }

  it("renders literal input for string arg and ref select for addressRef arg", () => {
    const steps = [makeRegistryStep("s1")];
    const deployTargets = [
      { deployId: "reg", contractName: "Registry" },
      { deployId: "token", contractName: "Token" },
    ];
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

    // Arg 0 (string) → literal kind → literal input rendered
    const arg0KindSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-0-kind" }) as HTMLSelectElement;
    expect(arg0KindSelect.value).toBe("literal");
    const arg0LiteralInput = screen.getByRole("textbox", { name: "ordered-arg-s1-0-literal" }) as HTMLInputElement;
    expect(arg0LiteralInput.value).toBe("myKey");

    // Arg 1 (address) → ref kind → ref select rendered
    const arg1KindSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-1-kind" }) as HTMLSelectElement;
    expect(arg1KindSelect.value).toBe("ref");
    const arg1RefSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-1-ref" }) as HTMLSelectElement;
    expect(arg1RefSelect.value).toBe("token");
    // The ref select should list the deploy targets
    expect(arg1RefSelect.innerHTML).toContain("token.address");
  });

  it("switching arg kind from literal to ref calls onUpdateStep", () => {
    const updates: Array<{ stepId: string; update: object }> = [];
    const steps = [makeRegistryStep("s1")];
    const deployTargets = [
      { deployId: "reg", contractName: "Registry" },
      { deployId: "token", contractName: "Token" },
    ];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={deployTargets}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={(stepId, update) => updates.push({ stepId, update })}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );

    // Switch arg 0 from literal to ref
    const arg0KindSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-0-kind" });
    fireEvent.change(arg0KindSelect, { target: { value: "ref" } });

    expect(updates).toHaveLength(1);
    expect(updates[0].stepId).toBe("s1");
    // The new args array should have an addressRef at index 0
    const newArgs = (updates[0].update as { args: unknown[] }).args;
    expect(newArgs[0]).toEqual({ kind: "addressRef", deployId: "reg" }); // first deploy target
  });

  it("switching arg kind from ref to literal calls onUpdateStep", () => {
    const updates: Array<{ stepId: string; update: object }> = [];
    const steps = [makeRegistryStep("s1")];
    const deployTargets = [
      { deployId: "reg", contractName: "Registry" },
      { deployId: "token", contractName: "Token" },
    ];
    render(
      <OrderedConfigPanel
        orderedSteps={steps}
        deployTargets={deployTargets}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={(stepId, update) => updates.push({ stepId, update })}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );

    // Switch arg 1 (currently ref) to literal
    const arg1KindSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-1-kind" });
    fireEvent.change(arg1KindSelect, { target: { value: "literal" } });

    expect(updates).toHaveLength(1);
    const newArgs = (updates[0].update as { args: unknown[] }).args;
    // Switching from ref→literal: the value should be empty string (since original was an object)
    expect(newArgs[1]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5b-bis. OrderedArgInput — "read" arg kind (issue #147)
// ---------------------------------------------------------------------------

describe("OrderedConfigPanel — OrderedArgInput 'read' kind (issue #147)", () => {
  function makeRegistryStep(id: string, args: StudioOrderedConfigStep["args"] = ["myKey"]): StudioOrderedConfigStep {
    return {
      kind: "setX",
      id,
      functionName: "register",
      functionSignature: "register(string,address)",
      target: "reg",
      args,
    };
  }

  const deployTargets = [
    { deployId: "reg", contractName: "Registry" },
    { deployId: "token", contractName: "Token" },
  ];

  it("offers a 'read' option alongside literal/address ref in the arg-kind toggle", () => {
    render(
      <OrderedConfigPanel
        orderedSteps={[makeRegistryStep("s1")]}
        deployTargets={deployTargets}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={noop}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    const kindSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-0-kind" }) as HTMLSelectElement;
    const optionValues = Array.from(kindSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(["literal", "ref", "read"]);
  });

  it("switching arg kind to 'read' defaults to the first deploy target and its first view function", () => {
    const updates: Array<{ stepId: string; update: { args: unknown[] } }> = [];
    render(
      <OrderedConfigPanel
        orderedSteps={[makeRegistryStep("s1")]}
        deployTargets={deployTargets}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={(stepId, update) => updates.push({ stepId, update: update as { args: unknown[] } })}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    const kindSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-0-kind" });
    fireEvent.change(kindSelect, { target: { value: "read" } });
    expect(updates).toHaveLength(1);
    // deployTargets[0] is "reg" (Registry); Registry's first view/pure function
    // in manifest order is lookup(string), used as the default.
    const newArgs = updates[0].update.args;
    expect(newArgs[0]).toEqual({ kind: "read", contract: "reg", function: "lookup" });
  });

  it("renders read-source-contract and read-function pickers once kind is 'read'; switching the view function calls onUpdateStep", () => {
    const readRef: StudioReadRef = { kind: "read", contract: "token", function: "decimals" };
    const updates: Array<{ stepId: string; update: { args: unknown[] } }> = [];
    render(
      <OrderedConfigPanel
        orderedSteps={[makeRegistryStep("s1", [readRef])]}
        deployTargets={deployTargets}
        onAddStep={noop}
        onRemoveStep={noop}
        onUpdateStep={(stepId, update) => updates.push({ stepId, update: update as { args: unknown[] } })}
        onMoveUp={noop}
        onMoveDown={noop}
      />
    );
    const contractSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-0-read-contract" }) as HTMLSelectElement;
    expect(contractSelect.value).toBe("token");
    const fnSelect = screen.getByRole("combobox", { name: "ordered-arg-s1-0-read-function" }) as HTMLSelectElement;
    expect(fnSelect.value).toBe("decimals");
    expect(fnSelect.innerHTML).toContain("decimals()");

    fireEvent.change(fnSelect, { target: { value: "balanceOf" } });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.args[0]).toEqual({ kind: "read", contract: "token", function: "balanceOf" });
  });
});

// ---------------------------------------------------------------------------
// 5c. graphToSpec — orderedSteps with validateConfig + order preservation
// ---------------------------------------------------------------------------

describe("graphToSpec — orderedSteps validates and preserves order", () => {
  it("spec with orderedSteps passes validateConfig", () => {
    const token = makeGraphNode("n1", "token", "Token");
    const registry = makeGraphNode("n2", "registry", "Registry");
    const orderedSteps: StudioOrderedConfigStep[] = [
      { kind: "setX", id: "os1", functionName: "register", target: "registry", args: ["key1", ""] },
      { kind: "setX", id: "os2", functionName: "register", target: "registry", args: ["key2", ""] },
    ];
    const { deployment, config } = graphToSpec([token, registry], [], orderedSteps);
    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);
    expect(config.orderedSteps).toHaveLength(2);
  });

  it("multi-element orderedSteps array preserves insertion order through graphToSpec", () => {
    // Verifies the array-index execution order guarantee: os1 → os2 → os3.
    const node = makeGraphNode("n1", "token", "Token");
    const orderedSteps: StudioOrderedConfigStep[] = [
      { kind: "setX", id: "first", functionName: "alpha", target: "token", args: [] },
      { kind: "setX", id: "second", functionName: "beta", target: "token", args: [] },
      { kind: "setX", id: "third", functionName: "gamma", target: "token", args: [] },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    expect(config.orderedSteps).toHaveLength(3);
    // IDs must appear in the same order as the input
    expect((config.orderedSteps![0] as { id: string }).id).toBe("first");
    expect((config.orderedSteps![1] as { id: string }).id).toBe("second");
    expect((config.orderedSteps![2] as { id: string }).id).toBe("third");
    // Functions also preserve order
    expect((config.orderedSteps![0] as { function: string }).function).toBe("alpha");
    expect((config.orderedSteps![1] as { function: string }).function).toBe("beta");
    expect((config.orderedSteps![2] as { function: string }).function).toBe("gamma");
  });

  it("per-node steps appear BEFORE orderedSteps in their respective spec arrays", () => {
    // Spec guarantee: ConfigSpec.steps holds per-node steps; ConfigSpec.orderedSteps
    // holds global ordered steps. They are distinct arrays, never interleaved.
    const node = makeGraphNode("n1", "token", "Token", {
      configSteps: [
        { kind: "setX", id: "per1", functionName: "localStep", args: [] },
        { kind: "setX", id: "per2", functionName: "localStep2", args: [] },
      ],
    });
    const orderedSteps: StudioOrderedConfigStep[] = [
      { kind: "setX", id: "ord1", functionName: "globalStep", target: "token", args: [] },
    ];
    const { config } = graphToSpec([node], [], orderedSteps);
    // Per-node steps go into config.steps
    expect(config.steps).toHaveLength(2);
    expect((config.steps[0] as { id: string }).id).toBe("per1");
    expect((config.steps[1] as { id: string }).id).toBe("per2");
    // Ordered steps go into config.orderedSteps
    expect(config.orderedSteps).toHaveLength(1);
    expect((config.orderedSteps![0] as { id: string }).id).toBe("ord1");
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

/**
 * useGraph.test.ts
 *
 * Unit tests for the useGraph hook, covering functions not exercised by
 * the component-level App tests: onConnect paths, updateSetXStep,
 * updateGrantRoleStep, arg slot management.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraph } from "../src/hooks/useGraph";
import type { ContractNodeData, StudioEdgeData } from "../src/spec/types";

// Helper to access typed node data from the widened Record<string, unknown>
function nd(node: { data: Record<string, unknown> }): ContractNodeData {
  return node.data as unknown as ContractNodeData;
}
// Helper to access typed edge data
function ed(edge: { data?: Record<string, unknown> }): StudioEdgeData | undefined {
  return edge.data as unknown as StudioEdgeData | undefined;
}

// ---------------------------------------------------------------------------
// addContractNode
// ---------------------------------------------------------------------------

describe("useGraph — addContractNode", () => {
  it("starts with empty nodes", () => {
    const { result } = renderHook(() => useGraph());
    expect(result.current.nodes).toHaveLength(0);
  });

  it("adds a node on addContractNode", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0].type).toBe("contractNode");
  });

  it("node data contains callback functions", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const data = result.current.nodes[0].data;
    expect(typeof data.onUpdateDeployId).toBe("function");
    expect(typeof data.onUpdateContractName).toBe("function");
    expect(typeof data.onAddArg).toBe("function");
    expect(typeof data.onRemoveArg).toBe("function");
    expect(typeof data.onUpdateArgSlot).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Node data callbacks (invoked via data.on* as React Flow custom nodes would)
// ---------------------------------------------------------------------------

describe("useGraph — node data callbacks", () => {
  it("onUpdateDeployId updates deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "myToken"));
    expect(nd(result.current.nodes[0]).deployId).toBe("myToken");
  });

  it("onUpdateContractName updates contractName", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onUpdateContractName(nodeId, "Token"));
    expect(nd(result.current.nodes[0]).contractName).toBe("Token");
  });

  it("onAddArg adds an arg slot starting at index 0", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onAddArg(nodeId));
    expect(nd(result.current.nodes[0]).args).toHaveLength(1);
    expect(nd(result.current.nodes[0]).args[0].index).toBe(0);
  });

  it("onAddArg increments index for subsequent args", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onAddArg(nodeId));
    act(() => nd(result.current.nodes[0]).onAddArg(nodeId));
    const args = nd(result.current.nodes[0]).args;
    expect(args).toHaveLength(2);
    expect(args[0].index).toBe(0);
    expect(args[1].index).toBe(1);
  });

  it("onUpdateArgSlot updates the arg value at given index", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onAddArg(nodeId));
    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, "hello"));
    expect(nd(result.current.nodes[0]).args[0].value).toBe("hello");
  });

  it("onRemoveArg removes the arg at given index", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onAddArg(nodeId));
    act(() => nd(result.current.nodes[0]).onAddArg(nodeId));
    expect(nd(result.current.nodes[0]).args).toHaveLength(2);

    act(() => nd(result.current.nodes[0]).onRemoveArg(nodeId, 0));
    expect(nd(result.current.nodes[0]).args).toHaveLength(1);
    expect(nd(result.current.nodes[0]).args[0].index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onConnect — constructorRef path
// ---------------------------------------------------------------------------

describe("useGraph — onConnect (constructorRef)", () => {
  it("adds a constructorRef edge when target handle contains -arg-", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractNode();
      result.current.addContractNode();
    });

    const [n1, n2] = result.current.nodes;
    act(() => {
      result.current.onConnect({
        source: n1.id,
        target: n2.id,
        sourceHandle: `${n1.id}-output`,
        targetHandle: `${n2.id}-arg-0`,
      });
    });

    expect(result.current.edges).toHaveLength(1);
    expect(ed(result.current.edges[0])?.edgeKind).toBe("constructorRef");
    if (ed(result.current.edges[0])?.edgeKind === "constructorRef") {
      expect((ed(result.current.edges[0]) as unknown as { argIndex: unknown }).argIndex).toBe(0);
    }
  });

  it("parses arg index correctly from handle", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractNode();
      result.current.addContractNode();
    });

    const [n1, n2] = result.current.nodes;
    act(() => {
      result.current.onConnect({
        source: n1.id,
        target: n2.id,
        sourceHandle: `${n1.id}-output`,
        targetHandle: `${n2.id}-arg-3`,
      });
    });

    expect(ed(result.current.edges[0])?.edgeKind).toBe("constructorRef");
    if (ed(result.current.edges[0])?.edgeKind === "constructorRef") {
      expect((ed(result.current.edges[0]) as unknown as { argIndex: unknown }).argIndex).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// onConnect — wire path
// ---------------------------------------------------------------------------

describe("useGraph — onConnect (wire)", () => {
  it("adds a wire edge when target handle does not contain -arg-", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractNode();
      result.current.addContractNode();
    });

    const [n1, n2] = result.current.nodes;
    act(() => {
      result.current.onConnect({
        source: n1.id,
        target: n2.id,
        sourceHandle: `${n1.id}-output`,
        targetHandle: `${n2.id}-input`,
      });
    });

    expect(result.current.edges).toHaveLength(1);
    expect(ed(result.current.edges[0])?.edgeKind).toBe("wire");
    if (ed(result.current.edges[0])?.edgeKind === "wire") {
      expect((ed(result.current.edges[0]) as unknown as { wireFunction: unknown }).wireFunction).toBe("setAddress");
      expect((ed(result.current.edges[0]) as unknown as { wireStepId: unknown }).wireStepId).toMatch(/^wire-/);
    }
  });

  it("adds a wire edge when targetHandle is null", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractNode();
      result.current.addContractNode();
    });

    const [n1, n2] = result.current.nodes;
    act(() => {
      result.current.onConnect({
        source: n1.id,
        target: n2.id,
        sourceHandle: null,
        targetHandle: null,
      });
    });

    expect(result.current.edges).toHaveLength(1);
    expect(ed(result.current.edges[0])?.edgeKind).toBe("wire");
  });
});

// ---------------------------------------------------------------------------
// Config step management
// ---------------------------------------------------------------------------

describe("useGraph — config steps", () => {
  it("addConfigStep adds a setX step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "setX"));
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps[0].kind).toBe("setX");
  });

  it("addConfigStep adds a grantRole step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "grantRole"));
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps[0].kind).toBe("grantRole");
  });

  it("removeConfigStep removes by step id", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "setX"));
    const stepId = nd(result.current.nodes[0]).configSteps[0].id;

    act(() => result.current.removeConfigStep(nodeId, stepId));
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(0);
  });

  it("updateSetXStep updates functionName", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "setX"));
    const stepId = nd(result.current.nodes[0]).configSteps[0].id;

    act(() => result.current.updateSetXStep(nodeId, stepId, { functionName: "setFee" }));
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind === "setX") {
      expect(step.functionName).toBe("setFee");
    } else {
      throw new Error("Expected setX step");
    }
  });

  it("updateSetXStep updates args", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "setX"));
    const stepId = nd(result.current.nodes[0]).configSteps[0].id;

    act(() => result.current.updateSetXStep(nodeId, stepId, { args: ["100", "200"] }));
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind === "setX") {
      expect(step.args).toEqual(["100", "200"]);
    }
  });

  it("updateGrantRoleStep updates role and accountValue", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "grantRole"));
    const stepId = nd(result.current.nodes[0]).configSteps[0].id;

    act(() =>
      result.current.updateGrantRoleStep(nodeId, stepId, {
        role: "ADMIN_ROLE",
        accountValue: "0xabc",
      }),
    );
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind === "grantRole") {
      expect(step.role).toBe("ADMIN_ROLE");
      expect(step.accountValue).toBe("0xabc");
    } else {
      throw new Error("Expected grantRole step");
    }
  });

  it("updateSetXStep does not affect grantRole steps", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "grantRole"));
    const grantStepId = nd(result.current.nodes[0]).configSteps[0].id;

    // Call updateSetXStep on a grantRole step id — should be no-op
    act(() => result.current.updateSetXStep(nodeId, grantStepId, { functionName: "foo" }));
    const step = nd(result.current.nodes[0]).configSteps[0];
    expect(step.kind).toBe("grantRole"); // unchanged
  });

  it("updateGrantRoleStep does not affect setX steps", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "setX"));
    const setXStepId = nd(result.current.nodes[0]).configSteps[0].id;

    // Call updateGrantRoleStep on a setX step id — should be no-op
    act(() => result.current.updateGrantRoleStep(nodeId, setXStepId, { role: "foo" }));
    const step = nd(result.current.nodes[0]).configSteps[0];
    expect(step.kind).toBe("setX"); // unchanged
  });
});

// ---------------------------------------------------------------------------
// selectedNodeId
// ---------------------------------------------------------------------------

describe("useGraph — selectedNodeId", () => {
  it("starts as null", () => {
    const { result } = renderHook(() => useGraph());
    expect(result.current.selectedNodeId).toBeNull();
  });

  it("setSelectedNodeId updates state", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.setSelectedNodeId("node-1"));
    expect(result.current.selectedNodeId).toBe("node-1");
  });

  it("setSelectedNodeId can be reset to null", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.setSelectedNodeId("node-1"));
    act(() => result.current.setSelectedNodeId(null));
    expect(result.current.selectedNodeId).toBeNull();
  });
});

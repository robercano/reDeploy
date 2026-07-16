/**
 * useGraph.test.ts
 *
 * Unit tests for the useGraph hook, covering functions not exercised by
 * the component-level App tests: onConnect paths, updateSetXStep,
 * updateGrantRoleStep, arg slot updates.
 *
 * Nodes are added exclusively via addContractFromManifest(manifest) — the only
 * public node-creation entry point. Synthetic ContractManifest fixtures supply
 * the constructor arg slots (one ArgSlot per constructorArgs entry).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraph, stepReferencesDeployId } from "../src/hooks/useGraph";
import type { ContractNodeData, StudioEdgeData } from "../src/spec/types";
import type { ContractManifest, ManifestFunction } from "../src/manifest/types";
import { graphToSpec } from "../src/spec/graph-to-spec";
import { toGraphNodes } from "../src/spec/project-nodes";
import type { GraphEdge } from "../src/spec/graph-to-spec";
import {
  AUTHORING_STORAGE_KEY,
  AUTHORING_STATE_VERSION,
  loadPersistedState,
} from "../src/hooks/authoring-persistence";

beforeEach(() => {
  window.localStorage.clear();
});

// Helper to access typed node data from the widened Record<string, unknown>
function nd(node: { data: Record<string, unknown> }): ContractNodeData {
  return node.data as unknown as ContractNodeData;
}
// Helper to access typed edge data
function ed(edge: { data?: Record<string, unknown> }): StudioEdgeData | undefined {
  return edge.data as unknown as StudioEdgeData | undefined;
}

/**
 * addConfigStep now takes a ManifestFunction (issue #85/#89: the picker
 * lists the target contract's REAL state-changing functions instead of a
 * synthetic "setX" kind — see AddConfigCallMenu / getStateChangingFunctions).
 * This fixture stands in for "some real function" wherever these hook-level
 * tests only care that a setX step gets created (functionName/args are
 * overwritten by updateSetXStep in most of these tests anyway).
 */
const A_WRITE_FN: ManifestFunction = {
  name: "setFoo",
  signature: "setFoo(uint256)",
  declaredIn: "Test",
  inputs: [{ name: "value", type: "uint256" }],
  stateMutability: "nonpayable",
};

// ---------------------------------------------------------------------------
// Synthetic manifest fixtures
// ---------------------------------------------------------------------------

/** A no-arg manifest — produces a node with zero arg slots. */
const REGISTRY_MANIFEST: ContractManifest = {
  name: "Registry",
  sourcePath: "src/Registry.sol",
  packageSegments: ["src"],
  constructorArgs: [],
  inheritance: ["Registry"],
  functions: [],
};

/** A single-arg manifest — produces a node with one arg slot at index 0. */
const ONE_ARG_MANIFEST: ContractManifest = {
  name: "Token",
  sourcePath: "src/Token.sol",
  packageSegments: ["src"],
  constructorArgs: [{ name: "name_", type: "string" }],
  inheritance: ["Token"],
  functions: [],
};

/** VaultERC4626-style fixture with four constructor args. */
const VAULT_MANIFEST: ContractManifest = {
  name: "VaultERC4626",
  sourcePath: "src/VaultERC4626.sol",
  packageSegments: ["src"],
  constructorArgs: [
    { name: "asset_", type: "contract IERC20" },
    { name: "oracle_", type: "contract IOracle" },
    { name: "name_", type: "string" },
    { name: "symbol_", type: "string" },
  ],
  inheritance: ["VaultERC4626", "ERC4626"],
  functions: [],
};

// ---------------------------------------------------------------------------
// addContractFromManifest — basics
// ---------------------------------------------------------------------------

describe("useGraph — addContractFromManifest basics", () => {
  it("starts with empty nodes", () => {
    const { result } = renderHook(() => useGraph());
    expect(result.current.nodes).toHaveLength(0);
  });

  it("adds a node on addContractFromManifest", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0].type).toBe("contractNode");
  });

  it("node data contains callback functions", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const data = result.current.nodes[0].data;
    expect(typeof data.onUpdateDeployId).toBe("function");
    expect(typeof data.onUpdateContractName).toBe("function");
    expect(typeof data.onUpdateArgSlot).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Node data callbacks (invoked via data.on* as React Flow custom nodes would)
// ---------------------------------------------------------------------------

describe("useGraph — node data callbacks", () => {
  it("onUpdateDeployId updates deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "myToken"));
    expect(nd(result.current.nodes[0]).deployId).toBe("myToken");
  });

  it("onUpdateContractName updates contractName", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onUpdateContractName(nodeId, "Token"));
    expect(nd(result.current.nodes[0]).contractName).toBe("Token");
  });

  it("onUpdateArgSlot updates the arg value at given index", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    expect(nd(result.current.nodes[0]).args).toHaveLength(1);
    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, "hello"));
    expect(nd(result.current.nodes[0]).args[0].value).toBe("hello");
  });

  // -------------------------------------------------------------------------
  // Scripting arg kinds (issue #137) — object-form ArgSlotUpdate
  // -------------------------------------------------------------------------

  it("onUpdateArgSlot accepts an ArgSlotUpdate object to switch kind + set a kind-specific field", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, { kind: "param" }));
    expect(nd(result.current.nodes[0]).args[0].kind).toBe("param");

    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, { paramName: "owner" }));
    expect(nd(result.current.nodes[0]).args[0].paramName).toBe("owner");
    // Switching kind does not clear the original literal `value` field.
    expect(nd(result.current.nodes[0]).args[0].value).toBe("");
  });

  it("onUpdateArgSlot preserves kind-specific fields across an unrelated update (merge, not replace)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, { kind: "resolver", resolverName: "computeSalt" }));
    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, { resolverArgs: ["v1", "42"] }));

    const slot = nd(result.current.nodes[0]).args[0];
    expect(slot.kind).toBe("resolver");
    expect(slot.resolverName).toBe("computeSalt");
    expect(slot.resolverArgs).toEqual(["v1", "42"]);
  });
});

// ---------------------------------------------------------------------------
// onConnect — constructorRef path
// ---------------------------------------------------------------------------

describe("useGraph — onConnect (constructorRef)", () => {
  it("adds a constructorRef edge when target handle contains -arg-", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(VAULT_MANIFEST);
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
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(VAULT_MANIFEST);
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

// Wire edges have been removed from the studio. Cross-contract wiring is now
// expressed as a config call step with an address-ref arg, not via edges.
describe("useGraph — onConnect (no wire, only constructorRef)", () => {
  it("does NOT add any edge when target handle does not contain -arg- (wire path removed)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });

    const [n1, n2] = result.current.nodes;
    act(() => {
      result.current.onConnect({
        source: n1.id,
        target: n2.id,
        sourceHandle: `${n1.id}-output`,
        // Connecting to an arbitrary non-arg handle (no wire edge created)
        targetHandle: `${n2.id}-something-else`,
      });
    });

    // No edge is created — only constructorRef edges are produced by onConnect now.
    expect(result.current.edges).toHaveLength(0);
  });

  it("does NOT add any edge when targetHandle is null (wire path removed)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
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

    // Null targetHandle doesn't match -arg- → no edge created.
    expect(result.current.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Config step management
// ---------------------------------------------------------------------------

describe("useGraph — config steps", () => {
  it("addConfigStep adds a setX step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, A_WRITE_FN));
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps[0].kind).toBe("setX");
  });

  it("addConfigStep(nodeId, ManifestFunction) sets functionName/functionSignature from the chosen function (issue #85/#89)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, A_WRITE_FN));
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind !== "setX") throw new Error("Expected setX step");
    expect(step.functionName).toBe(A_WRITE_FN.name);
    expect(step.functionSignature).toBe(A_WRITE_FN.signature);
  });

  it("addConfigStep pre-populates ONE empty arg slot per real ABI parameter (issue #85/#89)", () => {
    const twoArgFn: ManifestFunction = {
      name: "mint",
      signature: "mint(address,uint256)",
      declaredIn: "Token",
      inputs: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      stateMutability: "nonpayable",
    };
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, twoArgFn));
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind !== "setX") throw new Error("Expected setX step");
    expect(step.args).toEqual(["", ""]);
  });

  it("addConfigStep produces an empty args array for a zero-input function", () => {
    const noArgFn: ManifestFunction = {
      name: "pause",
      signature: "pause()",
      declaredIn: "Vault",
      inputs: [],
      stateMutability: "nonpayable",
    };
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, noArgFn));
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind !== "setX") throw new Error("Expected setX step");
    expect(step.args).toEqual([]);
  });

  it("addConfigStep adds a grantRole step", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, "grantRole"));
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps[0].kind).toBe("grantRole");
  });

  it("removeConfigStep removes by step id", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, A_WRITE_FN));
    const stepId = nd(result.current.nodes[0]).configSteps[0].id;

    act(() => result.current.removeConfigStep(nodeId, stepId));
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(0);
  });

  it("updateSetXStep updates functionName", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, A_WRITE_FN));
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
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, A_WRITE_FN));
    const stepId = nd(result.current.nodes[0]).configSteps[0].id;

    act(() => result.current.updateSetXStep(nodeId, stepId, { args: ["100", "200"] }));
    const step = nd(result.current.nodes[0]).configSteps[0];
    if (step.kind === "setX") {
      expect(step.args).toEqual(["100", "200"]);
    }
  });

  it("updateGrantRoleStep updates role and accountValue", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
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
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
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
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.addConfigStep(nodeId, A_WRITE_FN));
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

// ---------------------------------------------------------------------------
// addContractFromManifest — arg-slot derivation
// ---------------------------------------------------------------------------

describe("useGraph — addContractFromManifest", () => {
  it("creates one node with contractName set to manifest name", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    expect(result.current.nodes).toHaveLength(1);
    expect(nd(result.current.nodes[0]).contractName).toBe("VaultERC4626");
  });

  it("sets deployId to empty string (user fills it in)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    expect(nd(result.current.nodes[0]).deployId).toBe("");
  });

  it("creates node type contractNode", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    expect(result.current.nodes[0].type).toBe("contractNode");
  });

  it("creates args with length equal to constructorArgs count", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    expect(nd(result.current.nodes[0]).args).toHaveLength(4);
  });

  it("sets arg indices 0..3 in order", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const args = nd(result.current.nodes[0]).args;
    expect(args[0].index).toBe(0);
    expect(args[1].index).toBe(1);
    expect(args[2].index).toBe(2);
    expect(args[3].index).toBe(3);
  });

  it("sets every arg kind to literal", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const args = nd(result.current.nodes[0]).args;
    for (const arg of args) {
      expect(arg.kind).toBe("literal");
    }
  });

  it("sets every arg value to empty string", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const args = nd(result.current.nodes[0]).args;
    for (const arg of args) {
      expect(arg.value).toBe("");
    }
  });

  it("sets arg[0].name = 'asset_' and arg[0].type = 'contract IERC20'", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const arg0 = nd(result.current.nodes[0]).args[0];
    expect(arg0.name).toBe("asset_");
    expect(arg0.type).toBe("contract IERC20");
  });

  it("sets arg[1].name = 'oracle_' and arg[1].type = 'contract IOracle'", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const arg1 = nd(result.current.nodes[0]).args[1];
    expect(arg1.name).toBe("oracle_");
    expect(arg1.type).toBe("contract IOracle");
  });

  it("sets arg[2].name = 'name_' and arg[2].type = 'string'", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const arg2 = nd(result.current.nodes[0]).args[2];
    expect(arg2.name).toBe("name_");
    expect(arg2.type).toBe("string");
  });

  it("sets arg[3].name = 'symbol_' and arg[3].type = 'string'", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const arg3 = nd(result.current.nodes[0]).args[3];
    expect(arg3.name).toBe("symbol_");
    expect(arg3.type).toBe("string");
  });

  it("injects all expected callbacks into node data", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const data = result.current.nodes[0].data;
    expect(typeof data.onUpdateDeployId).toBe("function");
    expect(typeof data.onUpdateContractName).toBe("function");
    expect(typeof data.onUpdateArgSlot).toBe("function");
  });

  it("honors an explicit position when provided", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST, { x: 42, y: 99 }));

    expect(result.current.nodes[0].position).toEqual({ x: 42, y: 99 });
  });

  it("uses auto-offset position when no position is provided", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const pos = result.current.nodes[0].position;
    // Auto position formula: { x: 100 + (nodeCounter - 1) * 250, y: 100 }
    // nodeCounter increments each call so x >= 100, y === 100
    expect(pos.y).toBe(100);
    expect(pos.x).toBeGreaterThanOrEqual(100);
  });

  it("creates a node with empty after[] and configSteps[]", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(VAULT_MANIFEST));

    const d = nd(result.current.nodes[0]);
    expect(d.after).toEqual([]);
    expect(d.configSteps).toEqual([]);
  });

  it("handles a manifest with zero constructor args", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));

    expect(nd(result.current.nodes[0]).contractName).toBe("Registry");
    expect(nd(result.current.nodes[0]).args).toHaveLength(0);
  });

  it("sequential adds increment ids — two calls produce 2 nodes with distinct ids", () => {
    const { result } = renderHook(() => useGraph());

    act(() => {
      result.current.addContractFromManifest(VAULT_MANIFEST);
      result.current.addContractFromManifest(VAULT_MANIFEST);
    });

    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[0].id).not.toBe(result.current.nodes[1].id);
  });
});

// ---------------------------------------------------------------------------
// stepReferencesDeployId (pure helper, issue #80)
// ---------------------------------------------------------------------------

describe("stepReferencesDeployId", () => {
  it("matches a setX step whose explicit target equals the deployId", () => {
    const step = { kind: "setX" as const, id: "s1", target: "token", functionName: "setFee", args: [] };
    expect(stepReferencesDeployId(step, "token")).toBe(true);
    expect(stepReferencesDeployId(step, "other")).toBe(false);
  });

  it("matches a setX step with an addressRef arg pointing at the deployId", () => {
    const step = {
      kind: "setX" as const,
      id: "s1",
      functionName: "setOracle",
      args: [{ kind: "addressRef" as const, deployId: "oracle" }],
    };
    expect(stepReferencesDeployId(step, "oracle")).toBe(true);
    expect(stepReferencesDeployId(step, "token")).toBe(false);
  });

  it("does not match a setX step with only literal args", () => {
    const step = { kind: "setX" as const, id: "s1", functionName: "setFee", args: ["100"] };
    expect(stepReferencesDeployId(step, "token")).toBe(false);
  });

  it("matches a grantRole step with accountKind ref pointing at the deployId", () => {
    const step = {
      kind: "grantRole" as const,
      id: "g1",
      role: "ADMIN",
      accountKind: "ref" as const,
      accountValue: "token",
    };
    expect(stepReferencesDeployId(step, "token")).toBe(true);
  });

  it("does not match a grantRole step with accountKind literal even if the value equals the deployId", () => {
    const step = {
      kind: "grantRole" as const,
      id: "g1",
      role: "ADMIN",
      accountKind: "literal" as const,
      accountValue: "token",
    };
    expect(stepReferencesDeployId(step, "token")).toBe(false);
  });

  it("never matches an empty deployId (guards against unset nodes matching each other)", () => {
    const setXStep = { kind: "setX" as const, id: "s1", target: "", functionName: "setFee", args: [] };
    const grantRoleStep = {
      kind: "grantRole" as const,
      id: "g1",
      role: "ADMIN",
      accountKind: "ref" as const,
      accountValue: "",
    };
    expect(stepReferencesDeployId(setXStep, "")).toBe(false);
    expect(stepReferencesDeployId(grantRoleStep, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Node deletion — reference cleanup (issue #80)
// ---------------------------------------------------------------------------
//
// The delete UI affordance (ContractNode's "✕" button) and Delete/Backspace
// (deleteKeyCode) both go through React Flow's deleteElements(), which
// removes the node AND connected edges via onNodesChange/onEdgesChange. Here
// we exercise onNodesChange directly with a synthetic "remove" NodeChange —
// the same shape deleteElements/deleteKeyCode produce — to test the
// reference-cleanup logic in isolation (After/config-step/ordered-step
// pruning). End-to-end button-click coverage lives in
// App.delete-node.test.tsx.

describe("useGraph — node deletion (onNodesChange remove) cleans up dangling references", () => {
  it("removes the node from state", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => result.current.onNodesChange([{ id: nodeId, type: "remove" }]));

    expect(result.current.nodes).toHaveLength(0);
  });

  it("prunes an 'after' reference to the removed node id on a surviving node", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    const [n1, n2] = result.current.nodes;

    // Inject an "after" constraint on n2 referencing n1 (normally set via templates).
    act(() =>
      result.current.onNodesChange([
        {
          id: n2.id,
          type: "replace",
          item: { ...n2, data: { ...nd(n2), after: [n1.id] } as unknown as Record<string, unknown> },
        },
      ]),
    );
    expect(nd(result.current.nodes[1]).after).toEqual([n1.id]);

    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    expect(result.current.nodes).toHaveLength(1);
    expect(nd(result.current.nodes[0]).after).toEqual([]);
  });

  it("removes a per-node setX config step on a surviving node whose target is the deleted contract's deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    const [n1, n2] = result.current.nodes;

    act(() => nd(result.current.nodes[0]).onUpdateDeployId(n1.id, "registryA"));
    act(() => result.current.addConfigStep(n2.id, A_WRITE_FN));
    const stepId = nd(result.current.nodes[1]).configSteps[0].id;
    act(() => result.current.updateSetXStep(n2.id, stepId, { target: "registryA", functionName: "setOwner" }));

    expect(nd(result.current.nodes[1]).configSteps).toHaveLength(1);

    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    expect(result.current.nodes).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(0);
  });

  it("removes a per-node grantRole step on a surviving node whose ref account points at the deleted contract's deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    const [n1, n2] = result.current.nodes;

    act(() => nd(result.current.nodes[0]).onUpdateDeployId(n1.id, "registryA"));
    act(() => result.current.addConfigStep(n2.id, "grantRole"));
    const stepId = nd(result.current.nodes[1]).configSteps[0].id;
    act(() =>
      result.current.updateGrantRoleStep(n2.id, stepId, { accountKind: "ref", accountValue: "registryA" }),
    );

    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    expect(result.current.nodes).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(0);
  });

  it("removes an addressRef arg step (setX) on a surviving node referencing the deleted contract's deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    const [n1, n2] = result.current.nodes;

    act(() => nd(result.current.nodes[0]).onUpdateDeployId(n1.id, "registryA"));
    act(() => result.current.addConfigStep(n2.id, A_WRITE_FN));
    const stepId = nd(result.current.nodes[1]).configSteps[0].id;
    act(() =>
      result.current.updateSetXStep(n2.id, stepId, {
        functionName: "setRegistry",
        args: [{ kind: "addressRef", deployId: "registryA" }],
      }),
    );

    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    expect(result.current.nodes).toHaveLength(1);
    expect(nd(result.current.nodes[0]).configSteps).toHaveLength(0);
  });

  it("removes a global ordered step referencing the deleted contract's deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const n1 = result.current.nodes[0];
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(n1.id, "registryA"));

    act(() => result.current.addOrderedStep());
    const stepId = result.current.orderedSteps[0].id;
    act(() => result.current.updateOrderedStep(stepId, { target: "registryA", functionName: "setOwner" }));

    expect(result.current.orderedSteps).toHaveLength(1);

    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    expect(result.current.orderedSteps).toHaveLength(0);
  });

  it("does NOT prune config steps that reference a still-alive contract's deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    const [n1, n2, n3] = result.current.nodes;

    act(() => nd(result.current.nodes[1]).onUpdateDeployId(n2.id, "registryB"));
    act(() => result.current.addConfigStep(n3.id, A_WRITE_FN));
    const stepId = nd(result.current.nodes[2]).configSteps[0].id;
    act(() => result.current.updateSetXStep(n3.id, stepId, { target: "registryB", functionName: "setOwner" }));

    // Delete an UNRELATED node (n1, still has empty deployId) — n3's step
    // targeting n2 (registryB) must survive.
    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    expect(result.current.nodes).toHaveLength(2);
    const survivingN3 = result.current.nodes.find((n) => n.id === n3.id)!;
    expect(nd(survivingN3).configSteps).toHaveLength(1);
  });

  it("does not crash and leaves state consistent when deleting a node with no dangling references anywhere", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    const [n1] = result.current.nodes;

    expect(() =>
      act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }])),
    ).not.toThrow();
    expect(result.current.nodes).toHaveLength(1);
  });

  it("clears selectedNodeId when the selected node is removed via App-level cleanup (setSelectedNodeId still callable after removal)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const n1 = result.current.nodes[0];
    act(() => result.current.setSelectedNodeId(n1.id));
    expect(result.current.selectedNodeId).toBe(n1.id);

    act(() => result.current.onNodesChange([{ id: n1.id, type: "remove" }]));

    // useGraph itself doesn't own "deselect on delete" (App.tsx's onPaneClick/
    // onNodeClick manage selectedNodeId) — assert the hook stays crash-free
    // and callable, and the deleted node truly no longer exists.
    expect(result.current.nodes).toHaveLength(0);
    expect(() => act(() => result.current.setSelectedNodeId(null))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Persistence — restore on mount (issue #80)
// ---------------------------------------------------------------------------

describe("useGraph — persistence: restore on mount", () => {
  it("starts blank when nothing is persisted", () => {
    const { result } = renderHook(() => useGraph());
    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);
    expect(result.current.orderedSteps).toHaveLength(0);
  });

  it("restores nodes, edges, and orderedSteps from a valid saved state", () => {
    const saved = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        {
          id: "contract-901",
          position: { x: 5, y: 7 },
          data: {
            deployId: "token",
            contractName: "Token",
            args: [],
            after: [],
            configSteps: [],
          },
        },
        {
          id: "contract-902",
          position: { x: 50, y: 70 },
          data: {
            deployId: "vault",
            contractName: "Vault",
            args: [{ index: 0, kind: "literal", value: "" }],
            after: [],
            configSteps: [],
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "contract-901",
          target: "contract-902",
          sourceHandle: "contract-901-output",
          targetHandle: "contract-902-arg-0",
          data: { edgeKind: "constructorRef", argIndex: 0 },
        },
      ],
      orderedSteps: [
        { kind: "setX", id: "ordered-777", target: "token", functionName: "setFee", args: [] },
      ],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(saved));

    const { result } = renderHook(() => useGraph());

    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[0].id).toBe("contract-901");
    expect(result.current.nodes[0].position).toEqual({ x: 5, y: 7 });
    expect(nd(result.current.nodes[0]).deployId).toBe("token");
    expect(result.current.edges).toHaveLength(1);
    expect(result.current.edges[0].source).toBe("contract-901");
    expect(result.current.orderedSteps).toHaveLength(1);
    expect(result.current.orderedSteps[0].id).toBe("ordered-777");
  });

  it("restored nodes carry callable node callbacks (interactive after restore)", () => {
    const saved = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        {
          id: "contract-901",
          position: { x: 0, y: 0 },
          data: { deployId: "token", contractName: "Token", args: [], after: [], configSteps: [] },
        },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(saved));

    const { result } = renderHook(() => useGraph());
    expect(typeof nd(result.current.nodes[0]).onUpdateDeployId).toBe("function");

    act(() => nd(result.current.nodes[0]).onUpdateDeployId("contract-901", "renamed"));
    expect(nd(result.current.nodes[0]).deployId).toBe("renamed");
  });

  it("ignores corrupt saved JSON and starts blank instead of crashing", () => {
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, "NOT VALID JSON {{{");

    const { result } = renderHook(() => useGraph());

    expect(result.current.nodes).toHaveLength(0);
  });

  it("ignores a version mismatch and starts blank instead of crashing", () => {
    const stale = {
      version: AUTHORING_STATE_VERSION + 1,
      nodes: [{ id: "contract-1", position: { x: 0, y: 0 }, data: { deployId: "x", contractName: "X", args: [], after: [], configSteps: [] } }],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(stale));

    const { result } = renderHook(() => useGraph());

    expect(result.current.nodes).toHaveLength(0);
  });

  it("newly-added nodes after a restore never collide with restored node ids", () => {
    const saved = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        { id: "contract-999", position: { x: 0, y: 0 }, data: { deployId: "x", contractName: "X", args: [], after: [], configSteps: [] } },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(saved));

    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));

    const ids = result.current.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain("contract-999");
  });
});

// ---------------------------------------------------------------------------
// Persistence — debounced autosave (issue #80)
// ---------------------------------------------------------------------------

describe("useGraph — persistence: debounced autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not save immediately on a change (debounced)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));

    // Nothing written yet — the debounce window hasn't elapsed.
    expect(window.localStorage.getItem(AUTHORING_STORAGE_KEY)).toBeNull();

    vi.useRealTimers();
  });

  it("saves to localStorage once the debounce window elapses", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes).toHaveLength(1);

    vi.useRealTimers();
  });

  it("resets the debounce timer on rapid successive changes (only the final state is saved)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));
    const nodeId = result.current.nodes[0].id;

    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "renamed"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Still within the debounce window of the SECOND change — nothing saved yet.
    expect(window.localStorage.getItem(AUTHORING_STORAGE_KEY)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const loaded = loadPersistedState();
    expect(loaded!.nodes[0].data.deployId).toBe("renamed");

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// resetGraph — "New / Clear canvas" (issue #80)
// ---------------------------------------------------------------------------

describe("useGraph — resetGraph", () => {
  it("clears nodes, edges, orderedSteps, and selectedNodeId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
      result.current.addContractFromManifest(REGISTRY_MANIFEST);
    });
    act(() => result.current.setSelectedNodeId(result.current.nodes[0].id));
    act(() => result.current.addOrderedStep());

    act(() => result.current.resetGraph());

    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.edges).toHaveLength(0);
    expect(result.current.orderedSteps).toHaveLength(0);
    expect(result.current.selectedNodeId).toBeNull();
  });

  it("clears the persisted localStorage copy so a remount doesn't resurrect the cleared graph", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(REGISTRY_MANIFEST));

    act(() => result.current.resetGraph());

    expect(loadPersistedState()).toBeNull();
  });

  it("is safe to call on an already-empty graph", () => {
    const { result } = renderHook(() => useGraph());
    expect(() => act(() => result.current.resetGraph())).not.toThrow();
    expect(result.current.nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deployment-wide parameters (issue #137)
// ---------------------------------------------------------------------------

describe("useGraph — parameters CRUD", () => {
  it("addParameter appends a blank parameter with a stable id", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addParameter());
    expect(result.current.parameters).toHaveLength(1);
    expect(result.current.parameters[0]).toMatchObject({ name: "", defaultValue: "", networkOverrides: {} });
    expect(typeof result.current.parameters[0].id).toBe("string");
  });

  it("updateParameter updates name and defaultValue", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addParameter());
    const id = result.current.parameters[0].id;

    act(() => result.current.updateParameter(id, { name: "owner", defaultValue: "0xabc" }));
    expect(result.current.parameters[0]).toMatchObject({ name: "owner", defaultValue: "0xabc" });
  });

  it("removeParameter removes the parameter by id", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addParameter();
      result.current.addParameter();
    });
    const [first, second] = result.current.parameters;

    act(() => result.current.removeParameter(first.id));
    expect(result.current.parameters).toHaveLength(1);
    expect(result.current.parameters[0].id).toBe(second.id);
  });

  it("addNetwork declares a new network; is a no-op for blank or duplicate names", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addNetwork("mainnet"));
    expect(result.current.networks).toEqual(["mainnet"]);

    act(() => result.current.addNetwork("   "));
    expect(result.current.networks).toEqual(["mainnet"]);

    act(() => result.current.addNetwork("mainnet"));
    expect(result.current.networks).toEqual(["mainnet"]);
  });

  it("updateParameterOverride sets a per-network override value", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addParameter();
      result.current.addNetwork("mainnet");
    });
    const id = result.current.parameters[0].id;

    act(() => result.current.updateParameterOverride(id, "mainnet", "0xmain"));
    expect(result.current.parameters[0].networkOverrides).toEqual({ mainnet: "0xmain" });
  });

  it("removeNetwork prunes that network's override from every parameter", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addParameter();
      result.current.addNetwork("mainnet");
      result.current.addNetwork("sepolia");
    });
    const id = result.current.parameters[0].id;
    act(() => {
      result.current.updateParameterOverride(id, "mainnet", "0xmain");
      result.current.updateParameterOverride(id, "sepolia", "0xsep");
    });

    act(() => result.current.removeNetwork("mainnet"));
    expect(result.current.networks).toEqual(["sepolia"]);
    expect(result.current.parameters[0].networkOverrides).toEqual({ sepolia: "0xsep" });
  });

  it("removeNetwork clears selectedNetwork when the removed network was selected", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addNetwork("mainnet"));
    act(() => result.current.setSelectedNetwork("mainnet"));
    expect(result.current.selectedNetwork).toBe("mainnet");

    act(() => result.current.removeNetwork("mainnet"));
    expect(result.current.selectedNetwork).toBeNull();
  });

  it("removeNetwork leaves selectedNetwork untouched when a DIFFERENT network is removed", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addNetwork("mainnet");
      result.current.addNetwork("sepolia");
    });
    act(() => result.current.setSelectedNetwork("mainnet"));

    act(() => result.current.removeNetwork("sepolia"));
    expect(result.current.selectedNetwork).toBe("mainnet");
  });

  it("setSelectedNetwork selects/deselects a network", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addNetwork("mainnet"));
    act(() => result.current.setSelectedNetwork("mainnet"));
    expect(result.current.selectedNetwork).toBe("mainnet");
    act(() => result.current.setSelectedNetwork(null));
    expect(result.current.selectedNetwork).toBeNull();
  });

  it("resetGraph clears parameters, networks, and selectedNetwork", () => {
    const { result } = renderHook(() => useGraph());
    act(() => {
      result.current.addParameter();
      result.current.addNetwork("mainnet");
    });
    act(() => result.current.setSelectedNetwork("mainnet"));

    act(() => result.current.resetGraph());

    expect(result.current.parameters).toHaveLength(0);
    expect(result.current.networks).toHaveLength(0);
    expect(result.current.selectedNetwork).toBeNull();
  });
});

describe("useGraph — parameters persistence (round trip)", () => {
  it("restores parameters, networks, and selectedNetwork from a valid saved state", () => {
    const saved = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      parameters: [
        { id: "param-99", name: "owner", defaultValue: "0xdef", networkOverrides: { mainnet: "0xmain" } },
      ],
      networks: ["mainnet"],
      selectedNetwork: "mainnet",
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(saved));

    const { result } = renderHook(() => useGraph());
    expect(result.current.parameters).toEqual(saved.parameters);
    expect(result.current.networks).toEqual(["mainnet"]);
    expect(result.current.selectedNetwork).toBe("mainnet");
  });

  it("a freshly-added parameter after restoring persisted state never collides with a restored parameter id", () => {
    const saved = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      parameters: [{ id: "param-50", name: "owner", defaultValue: "", networkOverrides: {} }],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(saved));

    const { result } = renderHook(() => useGraph());
    act(() => result.current.addParameter());

    const ids = result.current.parameters.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults to empty parameters/networks and null selectedNetwork when nothing is persisted", () => {
    const { result } = renderHook(() => useGraph());
    expect(result.current.parameters).toEqual([]);
    expect(result.current.networks).toEqual([]);
    expect(result.current.selectedNetwork).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Full end-to-end round trip (issue #137): author with the new kinds +
  // declared parameters, autosave, remount (simulating a reload), and assert
  // graphToSpec's output is IDENTICAL before and after.
  // ---------------------------------------------------------------------------

  it("re-emits an identical DeploymentSpec after persist + restore for param/expr/resolver slots + declared parameters", () => {
    vi.useFakeTimers();

    const { result, unmount } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG_MANIFEST));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "token"));
    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, { kind: "param", paramName: "owner" }));
    act(() => result.current.addParameter());
    const paramId = result.current.parameters[0].id;
    act(() =>
      result.current.updateParameter(paramId, { name: "owner", defaultValue: "0xdefault" }),
    );
    act(() => result.current.addNetwork("mainnet"));
    act(() => result.current.updateParameterOverride(paramId, "mainnet", "0xmain"));
    act(() => result.current.setSelectedNetwork("mainnet"));

    // Compute the spec BEFORE reload.
    const graphNodesBefore = toGraphNodes(result.current.nodes);
    const graphEdgesBefore: GraphEdge[] = result.current.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));
    const specBefore = graphToSpec(
      graphNodesBefore,
      graphEdgesBefore,
      result.current.orderedSteps,
      result.current.parameters,
      result.current.selectedNetwork,
    );

    // Force the debounced autosave to flush, then unmount (simulating navigating away).
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    unmount();

    // Remount (simulating a page reload) — state is restored from localStorage.
    const { result: reloaded } = renderHook(() => useGraph());
    const graphNodesAfter = toGraphNodes(reloaded.current.nodes);
    const graphEdgesAfter: GraphEdge[] = reloaded.current.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));
    const specAfter = graphToSpec(
      graphNodesAfter,
      graphEdgesAfter,
      reloaded.current.orderedSteps,
      reloaded.current.parameters,
      reloaded.current.selectedNetwork,
    );

    expect(specAfter).toEqual(specBefore);
    // Sanity: the param arg + spec.parameters override actually made it through.
    expect(specBefore.deployment.contracts[0].args![0]).toEqual({ kind: "param", name: "owner" });
    expect(specBefore.deployment.parameters).toEqual({ owner: "0xmain" });

    vi.useRealTimers();
  });
});

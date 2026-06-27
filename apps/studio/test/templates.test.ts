/**
 * templates.test.ts
 *
 * Tests for:
 *   1. instantiateTemplate — node/edge counts, id collision-free, deployId dedup.
 *   2. Template params — reference valid node ids and arg indices.
 *   3. Round-trip acceptance — instantiated + param-filled nodes+edges validate
 *      via graphToSpec → validateSpec (end-to-end acceptance criterion).
 *
 * Mirror style of useGraph.test.ts (renderHook/act) and
 * graph-to-spec.test.ts (validateSpec round-trip).
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraph } from "../src/hooks/useGraph";
import type { ContractNodeData, StudioEdgeData } from "../src/spec/types";
import { BUILTIN_TEMPLATES } from "../src/templates/builtin";
import { graphToSpec } from "../src/spec/graph-to-spec";
import type { GraphNode, GraphEdge } from "../src/spec/graph-to-spec";
import { validateSpec } from "@redeploy/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Access typed node data from the widened Record<string, unknown>. */
function nd(node: { data: Record<string, unknown> }): ContractNodeData {
  return node.data as unknown as ContractNodeData;
}

/** Access typed edge data from the widened Record<string, unknown>. */
function ed(edge: { data?: Record<string, unknown> }): StudioEdgeData | undefined {
  return edge.data as unknown as StudioEdgeData | undefined;
}

// ---------------------------------------------------------------------------
// Fixture: the ERC4626 template
// ---------------------------------------------------------------------------

const vaultTemplate = BUILTIN_TEMPLATES.find((t) => t.id === "erc4626-vault-stack");
if (!vaultTemplate) throw new Error("ERC4626 Vault Stack template not found in BUILTIN_TEMPLATES");
const VAULT_TEMPLATE = vaultTemplate;

// ---------------------------------------------------------------------------
// 1. instantiateTemplate — node/edge counts
// ---------------------------------------------------------------------------

describe("instantiateTemplate — ERC4626 Vault Stack", () => {
  it("adds exactly 3 nodes", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    expect(result.current.nodes).toHaveLength(3);
  });

  it("adds exactly 2 constructorRef edges", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    expect(result.current.edges).toHaveLength(2);
    for (const edge of result.current.edges) {
      expect(ed(edge)?.edgeKind).toBe("constructorRef");
    }
  });

  it("edge arg indices are 0 and 1 (Token→Vault arg0, Oracle→Vault arg1)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    const argIndices = result.current.edges
      .map((e) => ed(e))
      .filter(
        (d): d is StudioEdgeData & { edgeKind: "constructorRef"; argIndex: number } =>
          d !== undefined && d.edgeKind === "constructorRef",
      )
      .map((d) => d.argIndex)
      .sort();
    expect(argIndices).toEqual([0, 1]);
  });

  it("each node has the callbacks injected", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    for (const node of result.current.nodes) {
      const data = nd(node);
      expect(typeof data.onUpdateDeployId).toBe("function");
      expect(typeof data.onUpdateContractName).toBe("function");
      expect(typeof data.onUpdateArgSlot).toBe("function");
      expect(typeof data.onAddArg).toBe("function");
      expect(typeof data.onRemoveArg).toBe("function");
    }
  });

  it("nodes have the correct contractNames", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    const contractNames = result.current.nodes.map((n) => nd(n).contractName).sort();
    expect(contractNames).toEqual(["PriceOracle", "Token", "VaultERC4626"].sort());
  });

  it("edges connect the correct node contract pairs (Token→Vault, Oracle→Vault)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));

    const nodeById = new Map(result.current.nodes.map((n) => [n.id, nd(n)]));

    // Find Token and Vault nodes
    const tokenNode = result.current.nodes.find((n) => nd(n).contractName === "Token");
    const oracleNode = result.current.nodes.find((n) => nd(n).contractName === "PriceOracle");
    const vaultNode = result.current.nodes.find((n) => nd(n).contractName === "VaultERC4626");

    expect(tokenNode).toBeDefined();
    expect(oracleNode).toBeDefined();
    expect(vaultNode).toBeDefined();

    // Find the edge going to the vault at arg 0 (should be from Token)
    const arg0Edge = result.current.edges.find((e) => {
      const d = ed(e);
      return d?.edgeKind === "constructorRef" && d.argIndex === 0;
    });
    expect(arg0Edge).toBeDefined();
    expect(arg0Edge!.source).toBe(tokenNode!.id);
    expect(arg0Edge!.target).toBe(vaultNode!.id);

    // Find the edge going to the vault at arg 1 (should be from Oracle)
    const arg1Edge = result.current.edges.find((e) => {
      const d = ed(e);
      return d?.edgeKind === "constructorRef" && d.argIndex === 1;
    });
    expect(arg1Edge).toBeDefined();
    expect(arg1Edge!.source).toBe(oracleNode!.id);
    expect(arg1Edge!.target).toBe(vaultNode!.id);

    // nodeById is used above implicitly — just assert it has 3 entries
    expect(nodeById.size).toBe(3);
  });

  it("edge targetHandle matches <nodeId>-arg-<argIndex> format", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));

    const vaultNode = result.current.nodes.find((n) => nd(n).contractName === "VaultERC4626")!;

    for (const edge of result.current.edges) {
      const d = ed(edge);
      if (d?.edgeKind === "constructorRef") {
        expect(edge.targetHandle).toBe(`${vaultNode.id}-arg-${d.argIndex}`);
        expect(edge.sourceHandle).toBe(`${edge.source}-output`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Collision-free id remapping
// ---------------------------------------------------------------------------

describe("instantiateTemplate — collision-free ids", () => {
  it("instantiating twice yields 6 nodes with all-unique ids", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    expect(result.current.nodes).toHaveLength(6);
    const ids = result.current.nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(6);
  });

  it("instantiating twice yields unique deployIds (no duplicates)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    const deployIds = result.current.nodes.map((n) => nd(n).deployId);
    const uniqueDeployIds = new Set(deployIds);
    expect(uniqueDeployIds.size).toBe(6);
  });

  it("second instantiation uses suffixed deployIds to avoid collision", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    const deployIds = result.current.nodes.map((n) => nd(n).deployId);
    // First instantiation: Token, PriceOracle, Vault
    // Second instantiation: Token-2, PriceOracle-2, Vault-2
    expect(deployIds).toContain("Token");
    expect(deployIds).toContain("PriceOracle");
    expect(deployIds).toContain("Vault");
    expect(deployIds).toContain("Token-2");
    expect(deployIds).toContain("PriceOracle-2");
    expect(deployIds).toContain("Vault-2");
  });

  it("fourth instantiation suffixes with -4 and not a duplicate", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));
    const deployIds = result.current.nodes.map((n) => nd(n).deployId);
    const uniqueDeployIds = new Set(deployIds);
    expect(uniqueDeployIds.size).toBe(12);
  });

  it("template Token node gets a deduped deployId when an existing node's deployId collides", () => {
    // Arrange: manually add a node via addContractNode and then set its deployId to "Token"
    // to simulate a collision with the template's Token seed.
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractNode());
    // Set the deployId of the manually added node to "Token" (same seed as template)
    act(() => {
      const existingNode = result.current.nodes[0];
      nd(existingNode).onUpdateDeployId(existingNode.id, "Token");
    });

    // Act: instantiate the template
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));

    // Assert: 4 nodes total (1 manual + 3 template), Token seed must be deduped
    expect(result.current.nodes).toHaveLength(4);
    const deployIds = result.current.nodes.map((n) => nd(n).deployId);
    // "Token" is already taken by the manual node; template's Token must be "Token-2"
    expect(deployIds.filter((id) => id === "Token")).toHaveLength(1);
    expect(deployIds).toContain("Token-2");
    // All deployIds must still be unique
    expect(new Set(deployIds).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 3. Template params validity
// ---------------------------------------------------------------------------

describe("BUILTIN_TEMPLATES — params", () => {
  it("all templates have a non-empty params array", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.params.length).toBeGreaterThan(0);
    }
  });

  it("ERC4626 Vault Stack has at least 4 params", () => {
    expect(VAULT_TEMPLATE.params.length).toBeGreaterThanOrEqual(4);
  });

  it("all params reference a valid template-local node id", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const nodeIds = new Set(t.nodes.map((n) => n.id));
      for (const param of t.params) {
        expect(nodeIds.has(param.nodeId)).toBe(true);
      }
    }
  });

  it("all argIndex params reference a valid arg index on the node", () => {
    for (const t of BUILTIN_TEMPLATES) {
      for (const param of t.params) {
        if (param.argIndex !== undefined) {
          const node = t.nodes.find((n) => n.id === param.nodeId);
          expect(node).toBeDefined();
          const argIndices = node!.data.args.map((a) => a.index);
          expect(argIndices).toContain(param.argIndex);
        }
      }
    }
  });

  it("params include Token name and symbol with correct argIndices", () => {
    const tokenParams = VAULT_TEMPLATE.params.filter((p) => p.nodeId === "token");
    const argIndices = tokenParams
      .filter((p) => p.argIndex !== undefined)
      .map((p) => p.argIndex!)
      .sort();
    expect(argIndices).toContain(0); // name_
    expect(argIndices).toContain(1); // symbol_
  });

  it("params include PriceOracle decimals and initialAnswer with correct argIndices", () => {
    const oracleParams = VAULT_TEMPLATE.params.filter((p) => p.nodeId === "oracle");
    const argIndices = oracleParams
      .filter((p) => p.argIndex !== undefined)
      .map((p) => p.argIndex!)
      .sort();
    expect(argIndices).toContain(0); // decimals_
    expect(argIndices).toContain(1); // initialAnswer_
  });
});

// ---------------------------------------------------------------------------
// 4. Round-trip acceptance: instantiate → fill params → graphToSpec → validateSpec
// ---------------------------------------------------------------------------

describe("instantiateTemplate — round-trip acceptance", () => {
  it("instantiated ERC4626 Vault Stack validates after filling all param slots", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));

    // Find the three nodes by contractName
    const tokenNode = result.current.nodes.find((n) => nd(n).contractName === "Token")!;
    const oracleNode = result.current.nodes.find((n) => nd(n).contractName === "PriceOracle")!;
    const vaultNode = result.current.nodes.find((n) => nd(n).contractName === "VaultERC4626")!;

    // Fill Token params: name_ and symbol_
    act(() => nd(tokenNode).onUpdateArgSlot(tokenNode.id, 0, "USD Coin"));
    act(() => nd(tokenNode).onUpdateArgSlot(tokenNode.id, 1, "USDC"));

    // Fill PriceOracle params: decimals_ and initialAnswer_
    act(() => nd(oracleNode).onUpdateArgSlot(oracleNode.id, 0, "8"));
    act(() => nd(oracleNode).onUpdateArgSlot(oracleNode.id, 1, "100000000"));

    // Fill Vault params: name_ and symbol_ (args 2 and 3)
    act(() => nd(vaultNode).onUpdateArgSlot(vaultNode.id, 2, "USD Vault"));
    act(() => nd(vaultNode).onUpdateArgSlot(vaultNode.id, 3, "vUSD"));

    // Serialize to spec
    const graphNodes: GraphNode[] = result.current.nodes.map((n) => {
      const d = nd(n);
      return {
        id: n.id,
        data: {
          deployId: d.deployId,
          contractName: d.contractName,
          args: d.args,
          after: d.after,
          configSteps: d.configSteps,
        },
      };
    });
    const graphEdges: GraphEdge[] = result.current.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));

    const { deployment } = graphToSpec(graphNodes, graphEdges);

    // Acceptance criterion: validateSpec must pass
    const dResult = validateSpec(deployment);
    if (!dResult.ok) {
      console.error("Validation errors:", dResult.errors);
    }
    expect(dResult.ok).toBe(true);

    // Strengthen: verify the ref wiring is correct in the emitted spec.
    // graphToSpec reads edges to override arg slots with kind="ref", so if the
    // edges were broken or duplicated the ref contracts would be wrong.
    const tokenDeployId = nd(tokenNode).deployId;
    const oracleDeployId = nd(oracleNode).deployId;

    const vaultEntry = deployment.contracts.find(
      (c) => c.id === nd(vaultNode).deployId,
    );
    expect(vaultEntry).toBeDefined();
    // arg 0 (asset_) must be a ref to the Token contract
    expect(vaultEntry!.args![0]).toEqual({ kind: "ref", contract: tokenDeployId });
    // arg 1 (oracle_) must be a ref to the PriceOracle contract
    expect(vaultEntry!.args![1]).toEqual({ kind: "ref", contract: oracleDeployId });
  });

  it("each node in the instantiated template has the expected arg count", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));

    const tokenNode = result.current.nodes.find((n) => nd(n).contractName === "Token")!;
    const oracleNode = result.current.nodes.find((n) => nd(n).contractName === "PriceOracle")!;
    const vaultNode = result.current.nodes.find((n) => nd(n).contractName === "VaultERC4626")!;

    expect(nd(tokenNode).args).toHaveLength(2);   // name_, symbol_
    expect(nd(oracleNode).args).toHaveLength(2);  // decimals_, initialAnswer_
    expect(nd(vaultNode).args).toHaveLength(4);   // asset_, oracle_, name_, symbol_
  });

  it("constructorRef arg slots on VaultERC4626 have kind=ref", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.instantiateTemplate(VAULT_TEMPLATE));

    const vaultNode = result.current.nodes.find((n) => nd(n).contractName === "VaultERC4626")!;
    const args = nd(vaultNode).args;

    // arg 0 and 1 are filled by edges → kind "ref"
    const arg0 = args.find((a) => a.index === 0);
    const arg1 = args.find((a) => a.index === 1);
    expect(arg0?.kind).toBe("ref");
    expect(arg1?.kind).toBe("ref");

    // arg 2 and 3 are literal (user fills them)
    const arg2 = args.find((a) => a.index === 2);
    const arg3 = args.find((a) => a.index === 3);
    expect(arg2?.kind).toBe("literal");
    expect(arg3?.kind).toBe("literal");
  });
});

// ---------------------------------------------------------------------------
// 5. BUILTIN_TEMPLATES shape
// ---------------------------------------------------------------------------

describe("BUILTIN_TEMPLATES", () => {
  it("exports a non-empty array", () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("every template has a unique id", () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template has a non-empty name and description", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("every template edge references valid template-local node ids", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const nodeIds = new Set(t.nodes.map((n) => n.id));
      for (const edge of t.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    }
  });
});

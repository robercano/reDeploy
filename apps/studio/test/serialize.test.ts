/**
 * serialize.test.ts
 *
 * Tests for graphToTemplate (serialize.ts):
 *   1. Template-local ids are stable, collision-free, and callback-stripped.
 *   2. Edges are remapped to local ids, only constructorRef edges captured.
 *   3. Positions are relative to top-left node.
 *   4. Params are built from the user's selection.
 *   5. Round-trip acceptance: build graph → serialize → instantiate → graphToSpec
 *      → validateSpec passes.
 *
 * Nodes are created via addContractFromManifest(manifest); the manifest's
 * constructorArgs determine the fixed arg slots. Arg VALUES are then edited via
 * onUpdateArgSlot. There is no add/remove-slot callback any more.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGraph } from "../src/hooks/useGraph";
import type { ContractNodeData } from "../src/spec/types";
import type { ContractManifest } from "../src/manifest/types";
import { graphToTemplate } from "../src/templates/serialize";
import type { ParamSelection } from "../src/templates/serialize";
import { graphToSpec } from "../src/spec/graph-to-spec";
import type { GraphNode, GraphEdge } from "../src/spec/graph-to-spec";
import { validateSpec } from "@redeploy/core/spec";
import { validateConfig } from "@redeploy/config/steps";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nd(node: { data: Record<string, unknown> }): ContractNodeData {
  return node.data as unknown as ContractNodeData;
}

/** Build a minimal manifest with `argCount` literal constructor args. */
function manifest(name: string, argCount: number): ContractManifest {
  return {
    name,
    sourcePath: `src/${name}.sol`,
    packageSegments: ["src"],
    constructorArgs: Array.from({ length: argCount }, (_, i) => ({
      name: `arg${i}`,
      type: "string",
    })),
    inheritance: [name],
    functions: [],
  };
}

/** A no-arg manifest. */
const NO_ARG = manifest("Registry", 0);
/** A 1-arg manifest. */
const ONE_ARG = manifest("Token", 1);

// ---------------------------------------------------------------------------
// 1. Basic serialization
// ---------------------------------------------------------------------------

describe("graphToTemplate — basic serialization", () => {
  it("returns a template with the provided id, name, description", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(result.current.nodes[0].id, "MyToken"));
    act(() => nd(result.current.nodes[0]).onUpdateContractName(result.current.nodes[0].id, "Token"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "My Template", "A test template", []);
    expect(tmpl.id).toBe("user-1");
    expect(tmpl.name).toBe("My Template");
    expect(tmpl.description).toBe("A test template");
  });

  it("node count equals graph node count", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.nodes).toHaveLength(3);
  });

  it("local ids are derived from deployId slugs", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "MyToken"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.nodes[0].id).toBe("mytoken");
  });

  it("local ids fall back to node-N when deployId is empty", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.nodes[0].id).toBe("node-1");
  });

  it("local ids are collision-free when deployIds produce the same slug", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));
    const [node1, node2] = result.current.nodes;
    act(() => nd(node1).onUpdateDeployId(node1.id, "Token"));
    act(() => nd(node2).onUpdateDeployId(node2.id, "Token")); // same slug → collision

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    const localIds = tmpl.nodes.map((n) => n.id);
    expect(new Set(localIds).size).toBe(2);
    expect(localIds).toContain("token");
    expect(localIds).toContain("token-2");
  });

  it("node data strips callbacks (no onUpdateDeployId etc.)", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "Token"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    const nodeData = tmpl.nodes[0].data as unknown as Record<string, unknown>;
    expect(nodeData["onUpdateDeployId"]).toBeUndefined();
    expect(nodeData["onUpdateContractName"]).toBeUndefined();
    expect(nodeData["onUpdateArgSlot"]).toBeUndefined();
  });

  it("deployIdSeed is set from node deployId", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "VaultContract"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.nodes[0].data.deployIdSeed).toBe("VaultContract");
  });

  it("contractName is preserved", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateContractName(nodeId, "ERC20Token"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.nodes[0].data.contractName).toBe("ERC20Token");
  });
});

// ---------------------------------------------------------------------------
// 2. Position normalization
// ---------------------------------------------------------------------------

describe("graphToTemplate — position normalization", () => {
  it("top-left-most node has position (0, 0) in the template", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));
    // Nodes are positioned by the hook at (100 + (n-1)*250, 100); let's use those defaults

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    // Minimum x is 100 (first node), so it becomes 0; minimum y is 100 → 0
    const minX = Math.min(...tmpl.nodes.map((n) => n.data.position.x));
    const minY = Math.min(...tmpl.nodes.map((n) => n.data.position.y));
    expect(minX).toBe(0);
    expect(minY).toBe(0);
  });

  it("relative positions are preserved", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    // Original positions: node0 at x=100, node1 at x=350 (100 + 250)
    // Normalized: node0 at x=0, node1 at x=250
    const sortedByX = [...tmpl.nodes].sort((a, b) => a.data.position.x - b.data.position.x);
    expect(sortedByX[0].data.position.x).toBe(0);
    expect(sortedByX[1].data.position.x).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge serialization
// ---------------------------------------------------------------------------

describe("graphToTemplate — edges", () => {
  it("constructorRef edges are included with remapped local ids", () => {
    const { result } = renderHook(() => useGraph());
    // Set up two nodes with a constructorRef edge via onConnect
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(ONE_ARG));
    const [source, target] = result.current.nodes;
    act(() => nd(source).onUpdateDeployId(source.id, "Token"));
    act(() => nd(target).onUpdateDeployId(target.id, "Vault"));

    // Simulate a constructorRef connection
    act(() => result.current.onConnect({
      source: source.id,
      target: target.id,
      sourceHandle: `${source.id}-output`,
      targetHandle: `${target.id}-arg-0`,
    }));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.edges).toHaveLength(1);
    expect(tmpl.edges[0].source).toBe("token");
    expect(tmpl.edges[0].target).toBe("vault");
    expect(tmpl.edges[0].argIndex).toBe(0);
  });

  it("wire edges are NOT included in the template", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));
    const [source, target] = result.current.nodes;
    act(() => nd(source).onUpdateDeployId(source.id, "Token"));
    act(() => nd(target).onUpdateDeployId(target.id, "Vault"));

    // Simulate a wire connection (no arg handle → triggers wire edge)
    act(() => result.current.onConnect({
      source: source.id,
      target: target.id,
      sourceHandle: `${source.id}-output`,
      targetHandle: `${target.id}-input`,
    }));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.edges).toHaveLength(0);
  });

  it("template with no edges has empty edges array", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.edges).toHaveLength(0);
  });

  it("constructorRef edge referencing a node not in the provided nodes list is dropped", () => {
    // Build two real nodes and an edge between them
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(ONE_ARG));
    const [source, target] = result.current.nodes;
    act(() => nd(source).onUpdateDeployId(source.id, "Token"));
    act(() => nd(target).onUpdateDeployId(target.id, "Vault"));

    act(() => result.current.onConnect({
      source: source.id,
      target: target.id,
      sourceHandle: `${source.id}-output`,
      targetHandle: `${target.id}-arg-0`,
    }));

    // Only pass the source node — target is missing, so the edge should be dropped
    const tmpl = graphToTemplate([source], result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Params
// ---------------------------------------------------------------------------

describe("graphToTemplate — params", () => {
  it("empty paramSelections produces empty params array", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.params).toHaveLength(0);
  });

  it("selected params are mapped to template-local node ids", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "Token"));

    const paramSelections: ParamSelection[] = [
      { nodeId, argIndex: 0, label: "Token name", hint: 'e.g. "USD Coin"' },
    ];

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", paramSelections);
    expect(tmpl.params).toHaveLength(1);
    expect(tmpl.params[0].nodeId).toBe("token"); // remapped to local id
    expect(tmpl.params[0].argIndex).toBe(0);
    expect(tmpl.params[0].label).toBe("Token name");
    expect(tmpl.params[0].hint).toBe('e.g. "USD Coin"');
  });

  it("params without hint do not include hint field", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "Token"));

    const paramSelections: ParamSelection[] = [
      { nodeId, argIndex: 0, label: "Token name" },
    ];

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", paramSelections);
    expect(tmpl.params[0].hint).toBeUndefined();
  });

  it("params referencing a non-existent nodeId are dropped", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));

    const paramSelections: ParamSelection[] = [
      { nodeId: "does-not-exist", argIndex: 0, label: "Orphan param" },
    ];

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", paramSelections);
    expect(tmpl.params).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Round-trip acceptance
// ---------------------------------------------------------------------------

describe("graphToTemplate → instantiateTemplate round-trip", () => {
  it("serialize then instantiate then validate passes for a 2-node graph with a ref edge", () => {
    // Build a graph with Token + Vault + constructorRef edge.
    // Vault is created from a 1-arg manifest so it has an arg slot 0 to bind.
    const { result: graphResult } = renderHook(() => useGraph());
    act(() => graphResult.current.addContractFromManifest(NO_ARG));
    act(() => graphResult.current.addContractFromManifest(manifest("VaultERC4626", 1)));
    const [srcNode, tgtNode] = graphResult.current.nodes;

    act(() => nd(srcNode).onUpdateDeployId(srcNode.id, "Token"));
    act(() => nd(srcNode).onUpdateContractName(srcNode.id, "Token"));
    act(() => nd(tgtNode).onUpdateDeployId(tgtNode.id, "Vault"));
    act(() => nd(tgtNode).onUpdateContractName(tgtNode.id, "VaultERC4626"));

    act(() => graphResult.current.onConnect({
      source: srcNode.id,
      target: tgtNode.id,
      sourceHandle: `${srcNode.id}-output`,
      targetHandle: `${tgtNode.id}-arg-0`,
    }));

    // Serialize
    const tmpl = graphToTemplate(
      graphResult.current.nodes,
      graphResult.current.edges,
      "user-rt-1",
      "Round-trip Test",
      "",
      [],
    );
    expect(tmpl.nodes).toHaveLength(2);
    expect(tmpl.edges).toHaveLength(1);

    // Instantiate into a fresh graph
    const { result: freshResult } = renderHook(() => useGraph());
    act(() => freshResult.current.instantiateTemplate(tmpl));
    expect(freshResult.current.nodes).toHaveLength(2);
    expect(freshResult.current.edges).toHaveLength(1);

    // Validate round-trip via graphToSpec → validateSpec
    const graphNodes: GraphNode[] = freshResult.current.nodes.map((n) => {
      const d = nd(n);
      return { id: n.id, data: { deployId: d.deployId, contractName: d.contractName, args: d.args, after: d.after, configSteps: d.configSteps } };
    });
    const graphEdges: GraphEdge[] = freshResult.current.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));

    const { deployment } = graphToSpec(graphNodes, graphEdges);
    const dResult = validateSpec(deployment);
    expect(dResult.ok).toBe(true);

    // Verify edge wiring survived the round-trip
    const tokenEntry = deployment.contracts.find((c) => c.id === "Token");
    const vaultEntry = deployment.contracts.find((c) => c.id === "Vault");
    expect(tokenEntry).toBeDefined();
    expect(vaultEntry).toBeDefined();
    expect(vaultEntry!.args![0]).toEqual({ kind: "ref", contract: "Token" });
  });

  it("serialize then instantiate then validate passes for a 3-node ERC4626 graph with config steps", () => {
    // Build graph that mirrors the ERC4626 Vault Stack template.
    // Each node is created from a manifest with the right arg count.
    const { result: graphResult } = renderHook(() => useGraph());
    act(() => graphResult.current.addContractFromManifest(manifest("Token", 2)));
    act(() => graphResult.current.addContractFromManifest(manifest("PriceOracle", 2)));
    act(() => graphResult.current.addContractFromManifest(manifest("VaultERC4626", 4)));
    const [tokenNode, oracleNode, vaultNode] = graphResult.current.nodes;

    // Set up Token
    act(() => nd(tokenNode).onUpdateDeployId(tokenNode.id, "Token"));
    act(() => nd(tokenNode).onUpdateContractName(tokenNode.id, "Token"));
    act(() => nd(tokenNode).onUpdateArgSlot(tokenNode.id, 0, "USD Coin"));
    act(() => nd(tokenNode).onUpdateArgSlot(tokenNode.id, 1, "USDC"));

    // Set up PriceOracle
    act(() => nd(oracleNode).onUpdateDeployId(oracleNode.id, "PriceOracle"));
    act(() => nd(oracleNode).onUpdateContractName(oracleNode.id, "PriceOracle"));
    act(() => nd(oracleNode).onUpdateArgSlot(oracleNode.id, 0, "8"));
    act(() => nd(oracleNode).onUpdateArgSlot(oracleNode.id, 1, "100000000"));

    // Set up VaultERC4626 (4 args; first 2 will be refs)
    act(() => nd(vaultNode).onUpdateDeployId(vaultNode.id, "Vault"));
    act(() => nd(vaultNode).onUpdateContractName(vaultNode.id, "VaultERC4626"));
    act(() => nd(vaultNode).onUpdateArgSlot(vaultNode.id, 2, "USD Vault"));
    act(() => nd(vaultNode).onUpdateArgSlot(vaultNode.id, 3, "vUSD"));

    // Ref edges
    act(() => graphResult.current.onConnect({
      source: tokenNode.id,
      target: vaultNode.id,
      sourceHandle: `${tokenNode.id}-output`,
      targetHandle: `${vaultNode.id}-arg-0`,
    }));
    act(() => graphResult.current.onConnect({
      source: oracleNode.id,
      target: vaultNode.id,
      sourceHandle: `${oracleNode.id}-output`,
      targetHandle: `${vaultNode.id}-arg-1`,
    }));

    // Add a valid grantRole config step to vaultNode with non-empty role and account
    act(() => graphResult.current.addConfigStep(vaultNode.id, "grantRole"));
    // Get the step id from the freshly-added step
    const vaultData = nd(graphResult.current.nodes.find((n) => n.id === vaultNode.id)!);
    const grantStep = vaultData.configSteps[0];
    act(() => graphResult.current.updateGrantRoleStep(vaultNode.id, grantStep.id, {
      role: "MINTER_ROLE",
      accountKind: "ref",
      accountValue: "Token",
    }));

    // Serialize
    const paramSelections: ParamSelection[] = [
      { nodeId: tokenNode.id, argIndex: 0, label: "Token name" },
      { nodeId: tokenNode.id, argIndex: 1, label: "Token symbol" },
    ];
    const tmpl = graphToTemplate(
      graphResult.current.nodes,
      graphResult.current.edges,
      "user-rt-2",
      "ERC4626 Clone",
      "A cloned ERC4626 graph",
      paramSelections,
    );

    expect(tmpl.nodes).toHaveLength(3);
    expect(tmpl.edges).toHaveLength(2);
    expect(tmpl.params).toHaveLength(2);

    // Instantiate into a fresh graph
    const { result: freshResult } = renderHook(() => useGraph());
    act(() => freshResult.current.instantiateTemplate(tmpl));

    const freshNodes: GraphNode[] = freshResult.current.nodes.map((n) => {
      const d = nd(n);
      return { id: n.id, data: { deployId: d.deployId, contractName: d.contractName, args: d.args, after: d.after, configSteps: d.configSteps } };
    });
    const freshEdges: GraphEdge[] = freshResult.current.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));

    const { deployment, config } = graphToSpec(freshNodes, freshEdges);
    const dResult = validateSpec(deployment);
    const cResult = validateConfig(config, deployment);

    expect(dResult.ok).toBe(true);
    expect(cResult.ok).toBe(true);
  });

  it("after/ordering constraints are remapped from real ids to template-local ids", () => {
    // Graph: nodeA and nodeB; nodeB.data.after references nodeA's real id.
    // Since there is no public graph API to add to 'after' directly (it is set
    // only during instantiateTemplate from template data), we unit-test
    // graphToTemplate directly by constructing nodes with a hand-crafted 'after'.
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    act(() => result.current.addContractFromManifest(NO_ARG));
    const [nodeA, nodeB] = result.current.nodes;

    act(() => nd(nodeA).onUpdateDeployId(nodeA.id, "ContractA"));
    act(() => nd(nodeA).onUpdateContractName(nodeA.id, "Token"));
    act(() => nd(nodeB).onUpdateDeployId(nodeB.id, "ContractB"));
    act(() => nd(nodeB).onUpdateContractName(nodeB.id, "Vault"));

    // Manually inject 'after' referencing nodeA's real id into nodeB's data
    // by constructing the node objects with the correct after values directly.
    // This exercises the remap branch in graphToTemplate (~line 132-134).
    const nodeAFake = {
      ...nodeA,
      data: { ...nodeA.data, deployId: "ContractA", contractName: "Token", args: [], after: [], configSteps: [] },
    };
    const nodeBFake = {
      ...nodeB,
      data: { ...nodeB.data, deployId: "ContractB", contractName: "Vault", args: [], after: [nodeA.id], configSteps: [] },
    };

    const tmpl = graphToTemplate(
      [nodeAFake, nodeBFake] as typeof result.current.nodes,
      [],
      "user-rt-3",
      "Test",
      "",
      [],
    );

    const nodeALocal = tmpl.nodes.find((n) => n.data.deployIdSeed === "ContractA");
    const nodeBLocal = tmpl.nodes.find((n) => n.data.deployIdSeed === "ContractB");
    expect(nodeALocal).toBeDefined();
    expect(nodeBLocal).toBeDefined();

    // The key assertion: nodeB's 'after' should contain nodeA's TEMPLATE-LOCAL id,
    // not nodeA's real graph id. This exercises the id-remap branch in graphToTemplate.
    expect(nodeBLocal!.data.after).toHaveLength(1);
    expect(nodeBLocal!.data.after[0]).toBe(nodeALocal!.id);
    // nodeA's local id should be "contracta" (slug of "ContractA")
    expect(nodeALocal!.id).toBe("contracta");
    expect(nodeBLocal!.data.after[0]).toBe("contracta");
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe("graphToTemplate — edge cases", () => {
  it("empty graph produces a valid (empty) template", () => {
    const { result } = renderHook(() => useGraph());
    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-empty", "Empty", "", []);
    expect(tmpl.nodes).toHaveLength(0);
    expect(tmpl.edges).toHaveLength(0);
    expect(tmpl.params).toHaveLength(0);
  });

  it("args are deep-copied so mutating graph does not affect the template", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(ONE_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, "originalValue"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    const originalArgValue = tmpl.nodes[0].data.args[0].value;

    // Mutate the graph arg
    act(() => nd(result.current.nodes[0]).onUpdateArgSlot(nodeId, 0, "newValue"));
    // Template should be unaffected (deep copy)
    expect(tmpl.nodes[0].data.args[0].value).toBe(originalArgValue);
    expect(tmpl.nodes[0].data.args[0].value).toBe("originalValue");
  });

  it("configSteps are deep-copied into the template", () => {
    const { result } = renderHook(() => useGraph());
    act(() => result.current.addContractFromManifest(NO_ARG));
    const nodeId = result.current.nodes[0].id;
    act(() => nd(result.current.nodes[0]).onUpdateDeployId(nodeId, "Token"));
    act(() => result.current.addConfigStep(nodeId, "setX"));

    const tmpl = graphToTemplate(result.current.nodes, result.current.edges, "user-1", "Test", "", []);
    expect(tmpl.nodes[0].data.configSteps).toHaveLength(1);
    expect(tmpl.nodes[0].data.configSteps[0].kind).toBe("setX");
  });
});

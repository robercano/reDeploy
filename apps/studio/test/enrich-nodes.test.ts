/**
 * enrich-nodes.test.ts
 *
 * Unit tests for enrichNodesWithRefSources — the pure helper that derives
 * display-only refSourceDeployIds maps from constructorRef edges.
 *
 * These tests cover the three acceptance criteria from issue #54:
 *
 * 1. When a constructorRef edge connects source → target arg slot, the target
 *    node's refSourceDeployIds map contains the source node's deployId at the
 *    correct argIndex (so ContractNode renders "{deployId}.address" for that slot).
 *
 * 2. When the source node's deployId changes, re-running the helper with updated
 *    nodes produces an updated refSourceDeployIds map — i.e. the live-update path
 *    is covered.
 *
 * 3. When the constructorRef edge is removed, re-running the helper with an empty
 *    edges array produces no refSourceDeployIds entry for the formerly-bound slot
 *    (so ContractNode reverts to rendering an editable literal input for that slot).
 */

import { describe, it, expect } from "vitest";
import { enrichNodesWithRefSources } from "../src/spec/enrich-nodes.js";
import type { EnrichableNode, EnrichableEdge } from "../src/spec/enrich-nodes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal node fixture with the given id and deployId.
 * The data field uses the Record<string, unknown> widened type, matching
 * how App.tsx / useGraph.ts store node data at the React Flow boundary.
 */
function makeNode(id: string, deployId: string): EnrichableNode {
  return {
    id,
    data: { deployId } as Record<string, unknown>,
  };
}

/**
 * Build a constructorRef edge fixture (the edge kind that binds arg slots).
 * Mirrors how useGraph.ts / onConnect builds these edges.
 */
function makeConstructorRefEdge(
  source: string,
  target: string,
  argIndex: number,
): EnrichableEdge {
  return {
    source,
    target,
    data: { edgeKind: "constructorRef", argIndex } as Record<string, unknown>,
  };
}

/** Read the refSourceDeployIds map from an enriched node's data (if present). */
function refIds(node: EnrichableNode): Map<number, string> | undefined {
  return (node.data as Record<string, unknown>).refSourceDeployIds as
    | Map<number, string>
    | undefined;
}

// ---------------------------------------------------------------------------
// (1) Basic enrichment: edge binds source deployId into target arg slot
// ---------------------------------------------------------------------------

describe("enrichNodesWithRefSources — basic enrichment", () => {
  it("enriches target node with the source deployId at the correct argIndex", () => {
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    const edges = [makeConstructorRefEdge("n1", "n2", 0)];

    const enriched = enrichNodesWithRefSources(nodes, edges);

    // n1 (source) should have no refSourceDeployIds
    expect(refIds(enriched[0])).toBeUndefined();

    // n2 (target) should have argIndex 0 → "token"
    const n2Refs = refIds(enriched[1]);
    expect(n2Refs).not.toBeUndefined();
    expect(n2Refs!.get(0)).toBe("token");
  });

  it("places the ref at the correct argIndex (index 2)", () => {
    const nodes = [makeNode("n1", "oracle"), makeNode("n2", "registry")];
    const edges = [makeConstructorRefEdge("n1", "n2", 2)];

    const enriched = enrichNodesWithRefSources(nodes, edges);
    const n2Refs = refIds(enriched[1])!;

    expect(n2Refs.has(0)).toBe(false);
    expect(n2Refs.has(1)).toBe(false);
    expect(n2Refs.get(2)).toBe("oracle");
  });

  it("handles multiple edges to different arg slots on the same target", () => {
    const nodes = [
      makeNode("n1", "asset"),
      makeNode("n2", "oracle"),
      makeNode("n3", "vault"),
    ];
    const edges = [
      makeConstructorRefEdge("n1", "n3", 0),
      makeConstructorRefEdge("n2", "n3", 1),
    ];

    const enriched = enrichNodesWithRefSources(nodes, edges);
    const n3Refs = refIds(enriched[2])!;

    expect(n3Refs.get(0)).toBe("asset");
    expect(n3Refs.get(1)).toBe("oracle");
  });

  it("nodes with no incoming edges are returned as-is (same reference)", () => {
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    // No edges
    const enriched = enrichNodesWithRefSources(nodes, []);

    // No refSourceDeployIds on either node
    expect(refIds(enriched[0])).toBeUndefined();
    expect(refIds(enriched[1])).toBeUndefined();

    // n1 and n2 are returned as the same object references (no-op path)
    expect(enriched[0]).toBe(nodes[0]);
    expect(enriched[1]).toBe(nodes[1]);
  });

  it("emits the raw source node id as fallback when source node is not in nodes list", () => {
    // Ghost source node (exists as edge.source but not in nodes array)
    const nodes = [makeNode("n2", "vault")];
    const edges = [makeConstructorRefEdge("ghost-node", "n2", 0)];

    const enriched = enrichNodesWithRefSources(nodes, edges);
    const n2Refs = refIds(enriched[0])!;

    // Fallback: use the raw edge.source id when the node is not found
    expect(n2Refs.get(0)).toBe("ghost-node");
  });

  it("ignores wire edges (only constructorRef edges enrich arg slots)", () => {
    const nodes = [makeNode("n1", "oracle"), makeNode("n2", "vault")];
    const wireEdge: EnrichableEdge = {
      source: "n1",
      target: "n2",
      data: { edgeKind: "wire", wireStepId: "wire-1", wireFunction: "setOracle" },
    };

    const enriched = enrichNodesWithRefSources(nodes, [wireEdge]);

    // Wire edges must NOT create a refSourceDeployIds entry
    expect(refIds(enriched[0])).toBeUndefined();
    expect(refIds(enriched[1])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (2) Live-update: source deployId change re-derives the ref display value
// ---------------------------------------------------------------------------

describe("enrichNodesWithRefSources — live update when source deployId changes", () => {
  it("returns updated source deployId after the source node's deployId changes", () => {
    // Initial state: source deployId = "token"
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    const edges = [makeConstructorRefEdge("n1", "n2", 0)];

    const first = enrichNodesWithRefSources(nodes, edges);
    expect(refIds(first[1])!.get(0)).toBe("token");

    // Source node's deployId is updated to "myToken"
    const updatedNodes = [makeNode("n1", "myToken"), makeNode("n2", "vault")];
    const second = enrichNodesWithRefSources(updatedNodes, edges);
    expect(refIds(second[1])!.get(0)).toBe("myToken");
  });

  it("reflects empty deployId when source node's deployId is cleared", () => {
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    const edges = [makeConstructorRefEdge("n1", "n2", 0)];

    const first = enrichNodesWithRefSources(nodes, edges);
    expect(refIds(first[1])!.get(0)).toBe("token");

    // Source deployId cleared (user erased the field)
    const updatedNodes = [makeNode("n1", ""), makeNode("n2", "vault")];
    const second = enrichNodesWithRefSources(updatedNodes, edges);
    expect(refIds(second[1])!.get(0)).toBe("");
  });

  it("independently tracks two source nodes whose deployIds change separately", () => {
    const nodes = [makeNode("n1", "assetA"), makeNode("n2", "assetB"), makeNode("n3", "vault")];
    const edges = [
      makeConstructorRefEdge("n1", "n3", 0),
      makeConstructorRefEdge("n2", "n3", 1),
    ];

    const first = enrichNodesWithRefSources(nodes, edges);
    const n3Refs1 = refIds(first[2])!;
    expect(n3Refs1.get(0)).toBe("assetA");
    expect(n3Refs1.get(1)).toBe("assetB");

    // Only n1's deployId changes
    const updatedNodes = [makeNode("n1", "newAsset"), makeNode("n2", "assetB"), makeNode("n3", "vault")];
    const second = enrichNodesWithRefSources(updatedNodes, edges);
    const n3Refs2 = refIds(second[2])!;
    expect(n3Refs2.get(0)).toBe("newAsset"); // updated
    expect(n3Refs2.get(1)).toBe("assetB");   // unchanged
  });
});

// ---------------------------------------------------------------------------
// (3) Revert on edge removal: slot reverts to no enrichment (literal input)
// ---------------------------------------------------------------------------

describe("enrichNodesWithRefSources — revert when edge is removed", () => {
  it("target node has no refSourceDeployIds after its incoming edge is removed", () => {
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    const edges = [makeConstructorRefEdge("n1", "n2", 0)];

    // With edge: slot is bound
    const withEdge = enrichNodesWithRefSources(nodes, edges);
    expect(refIds(withEdge[1])!.get(0)).toBe("token");

    // Without edge: slot reverts (no refSourceDeployIds)
    const withoutEdge = enrichNodesWithRefSources(nodes, []);
    expect(refIds(withoutEdge[1])).toBeUndefined();

    // n2 should be returned as the same object reference (no-op path)
    expect(withoutEdge[1]).toBe(nodes[1]);
  });

  it("removing one edge out of two leaves the other slot still bound", () => {
    const nodes = [makeNode("n1", "assetA"), makeNode("n2", "assetB"), makeNode("n3", "vault")];
    const edge0 = makeConstructorRefEdge("n1", "n3", 0);
    const edge1 = makeConstructorRefEdge("n2", "n3", 1);

    // Both edges present
    const both = enrichNodesWithRefSources(nodes, [edge0, edge1]);
    expect(refIds(both[2])!.get(0)).toBe("assetA");
    expect(refIds(both[2])!.get(1)).toBe("assetB");

    // Remove edge for argIndex 0 — only edge1 remains
    const oneRemoved = enrichNodesWithRefSources(nodes, [edge1]);
    const n3Refs = refIds(oneRemoved[2])!;
    expect(n3Refs.has(0)).toBe(false);  // reverted to literal
    expect(n3Refs.get(1)).toBe("assetB");  // still bound
  });

  it("removing all edges from a target node returns it as-is (same reference)", () => {
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    const edges = [makeConstructorRefEdge("n1", "n2", 0)];

    // With edge: n2 is enriched (new object)
    const withEdge = enrichNodesWithRefSources(nodes, edges);
    expect(withEdge[1]).not.toBe(nodes[1]);

    // After edge removal: n2 is returned as original reference (same object)
    const withoutEdge = enrichNodesWithRefSources(nodes, []);
    expect(withoutEdge[1]).toBe(nodes[1]);
  });
});

// ---------------------------------------------------------------------------
// (4) Edge cases
// ---------------------------------------------------------------------------

describe("enrichNodesWithRefSources — edge cases", () => {
  it("returns an empty array for an empty nodes list", () => {
    expect(enrichNodesWithRefSources([], [])).toEqual([]);
    expect(enrichNodesWithRefSources([], [makeConstructorRefEdge("n1", "n2", 0)])).toEqual([]);
  });

  it("handles an edge with no data field (treated as constructorRef, argIndex=0)", () => {
    // When edge.data is absent the helper treats it as a constructorRef edge
    // at argIndex 0 — same as the graph-to-spec.ts behavior.
    const nodes = [makeNode("n1", "token"), makeNode("n2", "vault")];
    const edgeNoData: EnrichableEdge = { source: "n1", target: "n2" };

    const enriched = enrichNodesWithRefSources(nodes, [edgeNoData]);
    const n2Refs = refIds(enriched[1])!;
    expect(n2Refs.get(0)).toBe("token");
  });

  it("handles multiple constructorRef edges from different sources to different targets", () => {
    // n1→n3[0], n2→n4[0] — cross-product, no overlap
    const nodes = [
      makeNode("n1", "oracleA"),
      makeNode("n2", "oracleB"),
      makeNode("n3", "vaultA"),
      makeNode("n4", "vaultB"),
    ];
    const edges = [
      makeConstructorRefEdge("n1", "n3", 0),
      makeConstructorRefEdge("n2", "n4", 0),
    ];

    const enriched = enrichNodesWithRefSources(nodes, edges);

    // Sources are unchanged
    expect(refIds(enriched[0])).toBeUndefined();
    expect(refIds(enriched[1])).toBeUndefined();

    // Targets get their own maps
    expect(refIds(enriched[2])!.get(0)).toBe("oracleA");
    expect(refIds(enriched[3])!.get(0)).toBe("oracleB");
  });
});

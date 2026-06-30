/**
 * enrich-nodes.ts
 *
 * Pure helper: enriches React Flow node data with display-only
 * refSourceDeployIds maps derived from constructorRef edges.
 *
 * This logic is extracted from App.tsx's useMemo so it can be unit-tested
 * independently of React rendering — see test/enrich-nodes.test.ts.
 *
 * The function is pure: no React, no DOM, no side effects.
 */

import type { ContractNodeData } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal shape accepted by enrichNodesWithRefSources
// ---------------------------------------------------------------------------

/**
 * The slice of a React Flow Node that this helper needs.
 * We use the widened data type (Record<string, unknown>) at the boundary —
 * same pattern as App.tsx / useGraph.ts.
 */
export interface EnrichableNode {
  id: string;
  data: Record<string, unknown>;
}

/**
 * The slice of a React Flow Edge that this helper needs.
 * The edge data may be absent or carry { edgeKind, argIndex }.
 */
export interface EnrichableEdge {
  source: string;
  target: string;
  data?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enrich a set of React Flow nodes with display-only refSourceDeployIds maps.
 *
 * For each constructorRef edge (edgeKind === "constructorRef" or absent),
 * the target node's data is augmented with a `refSourceDeployIds` Map that
 * maps argIndex → the source node's current deployId.
 *
 * Nodes that have no incoming constructorRef edges are returned unchanged
 * (same reference — callers can rely on this for stable identity).
 *
 * Nodes with one or more incoming constructorRef edges get a new object
 * with a fresh `data` spread that includes the refSourceDeployIds Map.
 * This is DISPLAY-ONLY — it is never read by graphToSpec/serialization.
 *
 * @param nodes  - The current React Flow nodes (from useGraph).
 * @param edges  - The current React Flow edges (from useGraph).
 * @returns      - A new array of nodes enriched with refSourceDeployIds.
 */
export function enrichNodesWithRefSources<N extends EnrichableNode>(
  nodes: N[],
  edges: EnrichableEdge[],
): N[] {
  // Build a lookup: nodeId → deployId (for source node resolution)
  const deployIdByNodeId = new Map<string, string>(
    nodes.map((n) => {
      const d = n.data as unknown as ContractNodeData;
      return [n.id, d.deployId ?? n.id];
    }),
  );

  // Build per-target-node map: targetNodeId → (argIndex → sourceDeployId)
  const refMap = new Map<string, Map<number, string>>();
  for (const edge of edges) {
    const edgeData = edge.data as { edgeKind?: string; argIndex?: number } | undefined;
    if (!edgeData || edgeData.edgeKind === "constructorRef") {
      const argIndex = edgeData?.argIndex ?? 0;
      const sourceDeployId = deployIdByNodeId.get(edge.source) ?? edge.source;
      if (!refMap.has(edge.target)) {
        refMap.set(edge.target, new Map());
      }
      refMap.get(edge.target)!.set(argIndex, sourceDeployId);
    }
  }

  // Return nodes enriched with refSourceDeployIds in their data.
  // Nodes with no incoming constructorRef edges are returned as-is (same ref).
  return nodes.map((n) => {
    const refSourceDeployIds = refMap.get(n.id);
    if (!refSourceDeployIds) return n;
    return {
      ...n,
      data: {
        ...n.data,
        refSourceDeployIds,
      },
    };
  });
}

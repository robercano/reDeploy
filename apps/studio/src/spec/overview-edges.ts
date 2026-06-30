/**
 * overview-edges.ts
 *
 * Pure helper: collapses React Flow edge state into one display edge per
 * (source-node, target-node) pair for OVERVIEW mode rendering.
 *
 * ## Problem solved
 * In authoring mode each constructorRef edge anchors to a collapsed, opacity:0
 * arg handle (`${nodeId}-arg-N`). Because those handles are height:0 in overview,
 * the edge line appears to float away from the node body. Additionally, multiple
 * edges between the same node pair (several arg refs) each render as a separate
 * line, creating visual noise in the compact overview.
 *
 * ## Fix
 * In overview mode we replace the real edge list with one "indicator" edge per
 * (source, target) pair. The collapsed overview edge anchors to the source
 * node's output handle (`${sourceId}-output`) and the target node's input handle
 * (`${targetId}-input`). The input handle exists on every ContractNode solely
 * as an anchor point for overview edges — it does NOT accept wire-edge
 * connections (those were removed; onConnect silently drops non-arg-handle
 * connections).
 *
 * The generated edge carries no per-arg data — it is purely a visual indicator
 * of "there is at least one connection between these two nodes".
 *
 * ## Guarantees
 * - Pure function: no React, no DOM, no side effects.
 * - Deterministic: stable edge id `overview-${source}-${target}`.
 * - Idempotent: calling twice with the same input returns the same output.
 * - Non-destructive: the real `edges` state is never mutated; graphToSpec /
 *   enrichNodesWithRefSources still receive the original edges.
 *
 * The function is exported so it can be unit-tested in isolation (jsdom does not
 * render SVG edge elements, so helper-level tests are the only reliable gate).
 */

import type { StudioFlowEdge } from "../hooks/useGraph.js";

/**
 * Collapse a real edge list into one display edge per (source, target) node pair.
 *
 * @param edges  - The full React Flow edge state from useGraph (may be empty).
 * @returns      - A deduplicated list of display-only edges anchored to the
 *                 source output handle, safe to pass to ReactFlow as the `edges`
 *                 prop in overview mode.
 */
export function overviewEdges(edges: StudioFlowEdge[]): StudioFlowEdge[] {
  const seen = new Set<string>();
  const result: StudioFlowEdge[] = [];

  for (const edge of edges) {
    const pairKey = `${edge.source}__${edge.target}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    result.push({
      id: `overview-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: `${edge.source}-output`,
      // Anchor to the node-level input handle (present on every ContractNode
      // for this exact purpose). The input handle is NOT a wire-edge target —
      // onConnect silently ignores non-arg-handle connections.
      targetHandle: `${edge.target}-input`,
      // No per-arg data: this is a display-only connection indicator.
      data: {},
    });
  }

  return result;
}

/**
 * view-to-flow.ts
 *
 * Pure, UI-agnostic adapter: converts a DeploymentView (from @redeploy/reader)
 * into React Flow nodes and edges for the read-only Inspector canvas.
 *
 * ## Layout
 *
 * Nodes are placed in a deterministic grid layout by insertion order:
 *   - up to GRID_COLS columns per row
 *   - GRID_SPACING_X horizontal spacing between nodes
 *   - GRID_SPACING_Y vertical spacing between rows
 *
 * This is intentionally static because the inspector canvas is read-only —
 * users cannot drag nodes.
 *
 * ## Edge direction
 *
 * Dependency edges: source = the depended-upon contract, target = the
 * dependent contract (mirrors data-flow direction: the dependency must exist
 * before the dependent is deployed).
 *
 * Library edges: source = the library contract (only emitted when the library
 * value is a known contract id in the deployment), target = the contract that
 * uses the library. Edges for library values that are raw addresses or unknown
 * spec ids are skipped to avoid dangling references.
 *
 * Dangling dependency edges (where the dep id does not match any contract id in
 * the deployment) are also silently skipped.
 *
 * ## Purity
 *
 * This module has no React, no DOM, and no side effects — it is fully
 * unit-testable without rendering.
 */

import type { DeploymentView } from "@redeploy/reader";
import type {
  InspectorFlowNode,
  InspectorFlowEdge,
  InspectorNodeData,
} from "./types.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const GRID_COLS = 3;
const GRID_SPACING_X = 280;
const GRID_SPACING_Y = 180;

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/**
 * Convert a DeploymentView into React Flow nodes and edges for the inspector.
 *
 * @param view - The DeploymentView returned by readDeployment().
 * @returns An object with `nodes` and `edges` arrays ready for React Flow.
 */
export function deploymentViewToFlow(view: DeploymentView): {
  nodes: InspectorFlowNode[];
  edges: InspectorFlowEdge[];
} {
  // Build a set of known contract ids for fast lookup (used to skip dangling edges).
  const knownIds = new Set(view.contracts.map((c) => c.id));

  // Build nodes — one per contract, deterministic grid position.
  const nodes: InspectorFlowNode[] = view.contracts.map((contract, index) => {
    const col = index % GRID_COLS;
    const row = Math.floor(index / GRID_COLS);

    const data: InspectorNodeData = {
      id: contract.id,
      contractName: contract.contractName,
      address: contract.address,
      args: contract.args,
      dependencies: contract.links.dependencies,
      libraries: contract.links.libraries,
    };

    return {
      id: contract.id,
      type: "inspectorNode",
      position: {
        x: col * GRID_SPACING_X,
        y: row * GRID_SPACING_Y,
      },
      data: data as unknown as Record<string, unknown>,
    };
  });

  // Build edges — dependency edges + library edges.
  const edges: InspectorFlowEdge[] = [];

  for (const contract of view.contracts) {
    // Dependency edges: source = dep, target = this contract.
    for (const depId of contract.links.dependencies) {
      if (!knownIds.has(depId)) {
        // Dangling dependency — skip.
        continue;
      }
      const edgeId = `dep:${depId}->${contract.id}`;
      edges.push({
        id: edgeId,
        source: depId,
        target: contract.id,
        data: { edgeKind: "dependency" },
      });
    }

    // Library edges: source = library contract, target = this contract.
    // Only emit when the library reference resolves to a known contract id.
    for (const [, libRef] of Object.entries(contract.links.libraries)) {
      if (!knownIds.has(libRef)) {
        // Raw address or unknown spec id — skip.
        continue;
      }
      const edgeId = `lib:${libRef}->${contract.id}`;
      // Avoid duplicate edges (same library referenced twice).
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          source: libRef,
          target: contract.id,
          data: { edgeKind: "library" },
        });
      }
    }
  }

  return { nodes, edges };
}

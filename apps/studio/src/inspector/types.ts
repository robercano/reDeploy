/**
 * Inspector-local node and edge data types for the read-only React Flow canvas.
 *
 * These types describe the in-memory graph that the Inspector canvas renders
 * from a DeploymentView. The graph is read-only — no callbacks or editing.
 *
 * ## Node types
 *
 * - InspectorNodeData: represents a single deployed (or partially deployed)
 *   contract. It carries the contract id, Solidity artifact name, deployed
 *   address (null if not yet deployed), constructor args, and link information
 *   (inter-contract dependencies and library links).
 *
 * ## Edge types
 *
 * Two logical kinds of inspector edges:
 *
 * 1. InspectorDependencyEdge (edgeKind = "dependency")
 *    source: the contract that is depended upon
 *    target: the contract that declares the dependency
 *    Derived from ContractView.links.dependencies.
 *
 * 2. InspectorLibraryEdge (edgeKind = "library")
 *    source: the library contract (only emitted when the library ref matches
 *            a known contract id in the deployment)
 *    target: the contract that uses the library
 *    Derived from ContractView.links.libraries where the lib value matches a
 *    known contract id.
 */

import type { Node, Edge } from "@xyflow/react";
import type { ArgValue } from "@redeploy/reader";

/** Data stored on each inspector contract node. */
export interface InspectorNodeData {
  /** Spec id (e.g. "token", "registry"). */
  id: string;
  /** Solidity contract name (e.g. "ERC20Token"). */
  contractName: string;
  /** Deployed address, or null if not yet deployed. */
  address: string | null;
  /** Constructor arguments (normalized, bigints as BigIntValue). */
  args: ReadonlyArray<ArgValue>;
  /** Spec ids of other contracts this contract depends on. */
  dependencies: ReadonlyArray<string>;
  /** Library name → address or spec id. */
  libraries: Readonly<Record<string, string>>;
}

/** Kind discriminant for inspector edges. */
export type InspectorEdgeKind = "dependency" | "library";

/** Data stored on each inspector edge. */
export interface InspectorEdgeData extends Record<string, unknown> {
  /** Whether this edge represents a dependency or a library link. */
  edgeKind: InspectorEdgeKind;
}

/**
 * A React Flow node in the inspector canvas.
 * Uses `Record<string, unknown>` to satisfy React Flow's constraint, with the
 * actual payload accessible via InspectorNodeData.
 */
export type InspectorFlowNode = Node<Record<string, unknown>>;

/**
 * A React Flow edge in the inspector canvas.
 */
export type InspectorFlowEdge = Edge<InspectorEdgeData>;

/**
 * project-nodes.ts
 *
 * Pure helper: projects React Flow node state into the minimal ContractNodePayload
 * shape consumed by graphToSpec, stripping all display-only and callback fields.
 *
 * Fields stripped (DISPLAY-ONLY — must never reach serialized spec):
 *   - onUpdateDeployId, onUpdateContractName, onUpdateArgSlot (callbacks)
 *   - refSourceDeployIds  (#54 display field)
 *   - viewMode            (#55 display field)
 *
 * This helper is extracted from App.tsx's useMemo so it can be unit-tested
 * independently, making spec-strip regressions detectable: if someone adds a
 * new display-only field to ContractNodeData and forgets to strip it here, the
 * unit test for this function will catch it before any graphToSpec call happens.
 *
 * The function is pure: no React, no DOM, no side effects.
 */

import type { ContractNodeData } from "./types.js";
import type { GraphNode } from "./graph-to-spec.js";

/**
 * Minimal React Flow Node shape that this helper accepts.
 * Mirrors the widened data type used at the React Flow API boundary in App.tsx.
 */
export interface ProjectableNode {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Project an array of React Flow nodes (with wide data) into GraphNode[]
 * for graphToSpec, keeping ONLY the five serializable payload fields:
 *   deployId / contractName / args / after / configSteps.
 *
 * All display-only fields (viewMode, refSourceDeployIds) and all callbacks
 * (onUpdateDeployId, onUpdateContractName, onUpdateArgSlot) are stripped.
 */
export function toGraphNodes(nodes: ProjectableNode[]): GraphNode[] {
  return nodes.map((n) => {
    const d = n.data as unknown as ContractNodeData;
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
}

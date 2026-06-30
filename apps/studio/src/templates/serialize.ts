/**
 * templates/serialize.ts
 *
 * Pure function that converts the current authoring canvas (nodes + edges) into
 * a Template that can be saved and later re-instantiated via instantiateTemplate.
 *
 * This is the clean inverse of instantiateTemplate in useGraph.ts:
 *
 *   instantiateTemplate(template)
 *     maps template-local ids → real graph ids, injects callbacks, remaps edges.
 *
 *   graphToTemplate(nodes, edges, meta)
 *     maps real graph ids → template-local ids, strips callbacks, remaps edges.
 *
 * ## Template-local id strategy
 * Local ids are derived from the node's deployId (slugified to [a-z0-9-]) so
 * they are meaningful. When the deployId is empty or produces a collision, we
 * fall back to "node-1", "node-2", … in node order.
 *
 * ## Position strategy
 * Positions are stored relative to the top-left-most node so that templates
 * re-instantiate near the canvas origin regardless of where the user authored them.
 *
 * ## Params
 * Only the slots the user explicitly checked in the save modal become params.
 * Each checked slot carries the user-supplied label (and optional hint).
 */

import type { ContractNodeData } from "../spec/types.js";
import type { ContractFlowNode, StudioFlowEdge } from "../hooks/useGraph.js";
import type { StudioEdgeData } from "../spec/types.js";
import type { Template, TemplateNode, TemplateEdge, TemplateParam } from "./types.js";

// ---------------------------------------------------------------------------
// Public param-selection descriptor
// ---------------------------------------------------------------------------

/**
 * Describes a single constructor-arg slot that the user has chosen to make into
 * a template param. Used as input to graphToTemplate.
 */
export interface ParamSelection {
  /** Real graph node id. */
  nodeId: string;
  /** Index into that node's args array. */
  argIndex: number;
  /** Human-readable label shown in the param checklist. */
  label: string;
  /** Optional hint shown beside the label. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Serialize the current canvas into a storable Template.
 *
 * @param nodes        - React Flow nodes from useGraph (ContractFlowNode[]).
 * @param edges        - React Flow edges from useGraph (StudioFlowEdge[]).
 * @param id           - Unique template id (e.g. `user-${Date.now()}`).
 * @param name         - Human-readable template name (from save modal).
 * @param description  - Short description (from save modal).
 * @param paramSelections - Param slots the user chose to surface (from save modal).
 *
 * @returns A complete Template ready to be persisted and later instantiated.
 */
export function graphToTemplate(
  nodes: ContractFlowNode[],
  edges: StudioFlowEdge[],
  id: string,
  name: string,
  description: string,
  paramSelections: ParamSelection[],
): Template {
  // ---- 1. Build the real-id → template-local-id map -------------------------

  const idMap = new Map<string, string>(); // realId → localId
  const usedLocalIds = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const data = node.data as unknown as ContractNodeData;

    // Derive a slug from the deployId: lowercase, replace non-alphanumeric with -
    let baseSlug = data.deployId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    // Fall back to positional id if deployId is empty or produces an empty slug
    if (!baseSlug) {
      baseSlug = `node-${i + 1}`;
    }

    // Deduplicate (shouldn't normally be needed, but be safe)
    let localId = baseSlug;
    let counter = 2;
    while (usedLocalIds.has(localId)) {
      localId = `${baseSlug}-${counter++}`;
    }
    usedLocalIds.add(localId);
    idMap.set(node.id, localId);
  }

  // ---- 2. Find the top-left origin for position normalization ---------------

  let minX = Infinity;
  let minY = Infinity;
  for (const node of nodes) {
    if (node.position.x < minX) minX = node.position.x;
    if (node.position.y < minY) minY = node.position.y;
  }
  if (!isFinite(minX)) { minX = 0; }
  if (!isFinite(minY)) { minY = 0; }

  // ---- 3. Build TemplateNode[] (strip callbacks) ----------------------------

  const templateNodes: TemplateNode[] = nodes.map((node) => {
    const data = node.data as unknown as ContractNodeData;
    const localId = idMap.get(node.id)!;

    return {
      id: localId,
      data: {
        deployIdSeed: data.deployId || localId,
        contractName: data.contractName,
        // Deep-copy args so the template is self-contained
        args: data.args.map((slot) => ({ ...slot })),
        // Remap "after" real ids → local ids (unknown ids are dropped)
        after: data.after
          .map((realId) => idMap.get(realId))
          .filter((lid): lid is string => lid !== undefined),
        configSteps: data.configSteps.map((s) => ({ ...s })),
        position: {
          x: node.position.x - minX,
          y: node.position.y - minY,
        },
      },
    };
  });

  // ---- 4. Build TemplateEdge[] from constructorRef edges only ---------------

  const templateEdges: TemplateEdge[] = [];

  for (const edge of edges) {
    const data = edge.data as unknown as StudioEdgeData | undefined;
    if (!data || data.edgeKind !== "constructorRef") {
      // Wire edges are not captured in templates
      continue;
    }

    const localSource = idMap.get(edge.source);
    const localTarget = idMap.get(edge.target);
    if (!localSource || !localTarget) {
      // Edge references a node not in the current graph — skip
      continue;
    }

    templateEdges.push({
      source: localSource,
      target: localTarget,
      argIndex: data.argIndex,
    });
  }

  // ---- 5. Build TemplateParam[] from the user-selected slots ----------------

  const templateParams: TemplateParam[] = paramSelections
    .map((sel): TemplateParam | null => {
      const localId = idMap.get(sel.nodeId);
      if (!localId) return null;
      return {
        nodeId: localId,
        argIndex: sel.argIndex,
        label: sel.label,
        ...(sel.hint ? { hint: sel.hint } : {}),
      };
    })
    .filter((p): p is TemplateParam => p !== null);

  // ---- 6. Assemble and return -----------------------------------------------

  return {
    id,
    name,
    description,
    nodes: templateNodes,
    edges: templateEdges,
    params: templateParams,
  };
}

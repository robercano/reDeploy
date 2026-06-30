/**
 * graph-to-spec.ts
 *
 * Pure, UI-agnostic serializer: converts the studio canvas graph into a
 * { deployment: DeploymentSpec; config: ConfigSpec } pair ready for validation
 * and export.
 *
 * ## Edge → spec mapping
 *
 * ### ConstructorRefEdge (edgeKind = "constructorRef")
 *   - source: a contract node (source id = deployment id of the referenced contract)
 *   - target: a contract node + handle "<nodeId>-arg-<index>"
 *   - output: RefArg { kind: "ref", contract: <source node's deployId> }
 *     placed into target ContractEntry.args at position argIndex.
 *     Overrides any literal value the user may have typed for that slot.
 *
 * ### WireEdge (edgeKind = "wire")
 *   - source: any contract node (the contract whose address will be passed)
 *   - target: any contract node (the contract that receives the wiring call)
 *   - output: WireStep { kind: "wire", id: wireStepId, source: <source deployId>,
 *             into: <target deployId>, function: <wireFunction> }
 *
 * ## Invalid-graph behavior
 *
 * The serializer is permissive by design: it emits whatever the current graph
 * state describes, even if that state is logically invalid (e.g. a ref edge
 * pointing to a node id that doesn't exist in the nodes list, duplicate
 * deployIds, empty deployId/contractName). The downstream validators
 * (validateSpec / validateConfig) surface those errors to the UI. This gives
 * users early, specific feedback without blocking graph exploration.
 *
 * The one normalization the serializer performs: if a constructor arg slot has
 * kind="ref" but has no incoming edge, it falls back to emitting a literal with
 * the slot's current value string (or null if the value is empty).
 */

import type {
  DeploymentSpec,
  ContractEntry,
  ContractArg,
  LiteralValue,
} from "@redeploy/core/spec";
import type {
  ConfigSpec,
  ConfigStep,
  ConfigArg,
} from "@redeploy/config/steps";
import type {
  StudioEdgeData,
  ArgSlot,
  StudioConfigStep,
} from "./types";
import { getContract } from "../manifest/index.js";

// ---------------------------------------------------------------------------
// Input types accepted by graphToSpec
// ---------------------------------------------------------------------------

/**
 * The serializable portion of ContractNodeData (no callbacks).
 * graphToSpec only reads these fields — it never invokes callbacks.
 */
export interface ContractNodePayload {
  deployId: string;
  contractName: string;
  args: ArgSlot[];
  after: string[];
  configSteps: StudioConfigStep[];
}

/** Minimal React Flow Node shape that graphToSpec needs. */
export interface GraphNode {
  id: string;
  data: ContractNodePayload;
}

/** Minimal React Flow Edge shape that graphToSpec needs. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** May be absent on edges without custom data (treated as constructorRef). */
  data?: StudioEdgeData;
}

/** Output of graphToSpec. */
export interface SpecPair {
  deployment: DeploymentSpec;
  config: ConfigSpec;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a user-entered string into a LiteralValue.
 * - "true" / "false" → boolean
 * - decimal numeric strings → number ONLY when the conversion round-trips
 *   losslessly (i.e. String(Number(s)) === s). Large integers such as uint256
 *   values lose precision in JS Number, so they are preserved as strings.
 *   Hex/octal strings are also kept as strings.
 * - "null"           → null
 * - anything else    → string
 * - empty string     → null
 */
function parseLiteralValue(raw: string): LiteralValue {
  if (raw === "") return null;
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Only convert purely decimal (no leading 0x, 0o, 0b) numeric strings to
  // numbers when the conversion is lossless (round-trips back to the same string).
  // This prevents silent precision loss for large integers (e.g. uint256 token
  // amounts, role bitmasks) which must be preserved as strings for correct
  // on-chain deployment.
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n) && String(n) === trimmed) return n;
    // Lossless round-trip failed: preserve the original string so the value
    // is deployed correctly (a string is a valid LiteralScalar).
    return raw;
  }
  return raw;
}

/**
 * Build the args array for a ContractEntry.
 *
 * @param slots   - The arg slots defined on the node.
 * @param refMap  - Map from slot index → source deployId (from incoming edges).
 */
function buildContractArgs(
  slots: ArgSlot[],
  refMap: Map<number, string>,
): ContractArg[] | undefined {
  if (slots.length === 0) return undefined;
  const args: ContractArg[] = slots.map((slot) => {
    const refId = refMap.get(slot.index);
    if (refId !== undefined) {
      return { kind: "ref", contract: refId };
    }
    return { kind: "literal", value: parseLiteralValue(slot.value) };
  });
  return args;
}

/**
 * Build a ConfigArg from a studio "accountKind" / "accountValue" pair.
 */
function buildConfigArg(kind: "literal" | "ref", value: string): ConfigArg {
  if (kind === "ref") {
    return { kind: "ref", contract: value };
  }
  return { kind: "literal", value: parseLiteralValue(value) };
}

/**
 * Resolve the `function` field value for a setX config step.
 *
 * Rules:
 * - If `step.functionSignature` is set AND the function name is overloaded on the
 *   TARGET contract (multiple manifest entries share the same bare name), emit the
 *   full canonical signature (e.g. `"setLimit(uint256,address)"`).
 * - Otherwise emit the bare name (e.g. `"setLimit"`). This keeps backward
 *   compatibility: existing non-overloaded specs continue to emit bare names.
 * - If the contract is not in the manifest (free-text fallback), always emit the
 *   bare `functionName`.
 *
 * IMPORTANT: `targetContractName` must be the Solidity artifact name of the step's
 * TARGET contract (resolved from step.target's node, not the attached node). The
 * ConfigPanel picker already resolves the manifest from the target deployId when
 * storing functionSignature, so the serializer must mirror that resolution here.
 *
 * @param step               - The studio setX step.
 * @param targetContractName - The Solidity artifact name of the TARGET contract
 *                             (i.e. the contract that owns the function being called).
 */
function resolveSetXFunctionField(step: { functionName: string; functionSignature?: string }, targetContractName: string): string {
  // No signature stored — free-text path, always bare name.
  if (!step.functionSignature) return step.functionName;

  // Look up the manifest for the TARGET contract.
  const manifest = getContract(targetContractName);
  if (!manifest) return step.functionName;

  // Count how many manifest entries share the same bare function name on the TARGET.
  const sameNameCount = manifest.functions.filter((f) => f.name === step.functionName).length;

  // Overloaded on target: emit the full canonical signature.
  if (sameNameCount > 1) return step.functionSignature;

  // Unique name on target: emit the bare name for backward compatibility.
  return step.functionName;
}

/**
 * Convert StudioConfigStep[] for a single node into ConfigStep[].
 * The node's deployId is used as the target for setX / grantRole steps.
 *
 * @param steps              - The config steps attached to the node.
 * @param attachedTargetId   - The deploy-id of the attached node (used as fallback target).
 * @param deployIdToContract - Map from deployId → contractName for ALL nodes, used to
 *                             resolve the TARGET contract name for cross-node setX steps.
 *                             Mirrors what ConfigPanel.tsx does when storing functionSignature.
 * @param attachedContractName - The Solidity artifact name of the attached node's contract
 *                               (used as fallback when target is the attached node itself).
 */
function buildConfigSteps(
  steps: StudioConfigStep[],
  attachedTargetId: string,
  deployIdToContract: Map<string, string>,
  attachedContractName: string,
): ConfigStep[] {
  return steps.map((step): ConfigStep => {
    if (step.kind === "setX") {
      const args: ConfigArg[] = step.args.map((raw) => ({
        kind: "literal" as const,
        value: parseLiteralValue(raw),
      }));
      // Determine the explicit target deploy-id for cross-node setX steps.
      const effectiveTargetId = step.target ?? attachedTargetId;
      // Resolve the TARGET contract name from the deployId→contractName map.
      // This is the contract whose manifest determines whether the function name
      // is overloaded — matching the resolution ConfigPanel.tsx uses at pick time.
      const targetContractName = deployIdToContract.get(effectiveTargetId) ?? attachedContractName;
      const functionField = resolveSetXFunctionField(step, targetContractName);
      return {
        kind: "setX",
        id: step.id,
        target: effectiveTargetId,
        function: functionField,
        ...(args.length > 0 ? { args } : {}),
      };
    }
    // grantRole
    return {
      kind: "grantRole",
      id: step.id,
      target: attachedTargetId,
      role: step.role,
      account: buildConfigArg(step.accountKind, step.accountValue),
    };
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Serialize a React Flow graph into a (deployment, config) spec pair.
 *
 * The function is pure: no React, no DOM, no side effects.
 * Call validateSpec(deployment) and validateConfig(config, deployment) to
 * check the result before presenting it to the user.
 *
 * @param nodes  - Array of contract nodes from the React Flow state.
 * @param edges  - Array of edges from the React Flow state.
 */
export function graphToSpec(nodes: GraphNode[], edges: GraphEdge[]): SpecPair {
  // Step 1: Index constructor-ref edges by target node id.
  // refEdges[targetNodeId][argIndex] = sourceDeployId
  const refEdges = new Map<string, Map<number, string>>();

  // Collect wire edges separately
  const wireSteps: ConfigStep[] = [];

  // Build a lookup map for O(1) node access inside the edge loop (O(N+E) total).
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const edge of edges) {
    const data = edge.data;
    if (!data || data.edgeKind === "constructorRef") {
      // Constructor ref edge: determine argIndex from data or target handle
      const argIndex =
        data && data.edgeKind === "constructorRef" ? data.argIndex : 0;
      const sourceNode = nodeById.get(edge.source);
      const sourceDeployId = sourceNode ? sourceNode.data.deployId : edge.source;
      if (!refEdges.has(edge.target)) {
        refEdges.set(edge.target, new Map());
      }
      refEdges.get(edge.target)!.set(argIndex, sourceDeployId);
    } else if (data.edgeKind === "wire") {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      const sourceId = sourceNode ? sourceNode.data.deployId : edge.source;
      const intoId = targetNode ? targetNode.data.deployId : edge.target;
      wireSteps.push({
        kind: "wire",
        id: data.wireStepId,
        source: sourceId,
        into: intoId,
        function: data.wireFunction,
      });
    }
  }

  // Step 2: Build ContractEntry[] from nodes
  const contracts: ContractEntry[] = nodes.map((node): ContractEntry => {
    const d = node.data;
    const refMap = refEdges.get(node.id) ?? new Map<number, string>();
    const args = buildContractArgs(d.args, refMap);
    const after = d.after.length > 0 ? d.after : undefined;
    return {
      id: d.deployId,
      contract: d.contractName,
      ...(args !== undefined ? { args } : {}),
      ...(after !== undefined ? { after } : {}),
    };
  });

  const deployment: DeploymentSpec = {
    version: 1,
    contracts,
  };

  // Step 3: Build a deployId → contractName map for ALL nodes.
  // This is used by buildConfigSteps to resolve the TARGET contract name
  // for cross-node setX steps, mirroring what ConfigPanel.tsx does at pick time.
  const deployIdToContract = new Map<string, string>(
    nodes.map((n) => [n.data.deployId, n.data.contractName]),
  );

  // Step 4: Build ConfigStep[] from node-attached steps + wire edges
  const nodeConfigSteps: ConfigStep[] = nodes.flatMap((node) =>
    buildConfigSteps(node.data.configSteps, node.data.deployId, deployIdToContract, node.data.contractName),
  );

  const allSteps: ConfigStep[] = [...nodeConfigSteps, ...wireSteps];

  const config: ConfigSpec = {
    version: 1,
    steps: allSteps,
  };

  return { deployment, config };
}

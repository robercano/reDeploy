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
 * Wire edges have been removed. Cross-contract wiring is expressed as a config
 * call step with an address-ref arg (StudioAddressRef), which is normalized to
 * RefArg here before being placed in the ConfigSpec.
 *
 * ## Address-ref normalization
 *
 * Per-node config step args and ordered step args may contain StudioAddressRef
 * values ({ kind: "addressRef", deployId }). These are studio-internal ONLY and
 * MUST NOT reach a validated ConfigSpec. normalizeStudioArg() converts each:
 *   - StudioAddressRef → { kind: "ref", contract: deployId }  (RefArg)
 *   - string literal   → { kind: "literal", value: parseLiteralValue(raw) }
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
  StudioOrderedConfigStep,
  StudioConfigArg,
  StudioAddressRef,
  StudioParameter,
} from "./types.js";
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
 * Normalize a studio config arg (StudioConfigArg) to a validated ConfigArg.
 *
 * - StudioAddressRef { kind: "addressRef", deployId }
 *     → RefArg { kind: "ref", contract: deployId }
 * - string (literal value)
 *     → LiteralArg { kind: "literal", value: parseLiteralValue(raw) }
 */
function normalizeStudioArg(arg: StudioConfigArg): ConfigArg {
  if (typeof arg === "object" && (arg as StudioAddressRef).kind === "addressRef") {
    return { kind: "ref", contract: (arg as StudioAddressRef).deployId };
  }
  return { kind: "literal", value: parseLiteralValue(arg as string) };
}

/**
 * Build the args array for a ContractEntry.
 *
 * A constructorRef edge (refMap entry) ALWAYS wins regardless of the slot's
 * own `kind` — this mirrors the pre-existing "ref edge overrides literal"
 * behavior, now extended to also override param/expr/resolver slots.
 *
 * When no edge is bound, the slot's own `kind` decides the emitted
 * ContractArg:
 *   - "literal"  → LiteralArg { kind: "literal", value: parseLiteralValue(slot.value) }
 *   - "ref"      → (no edge bound — fallback) same as "literal", using slot.value.
 *   - "param"    → ParamArg { kind: "param", name: slot.paramName ?? "" }
 *   - "expr"     → ExprArg { kind: "expr", expression: slot.expression ?? "" }
 *   - "resolver" → ResolverArg { kind: "resolver", name: slot.resolverName ?? "",
 *                  args?: slot.resolverArgs (each parsed via parseLiteralValue) }
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
    switch (slot.kind) {
      case "param":
        return { kind: "param", name: slot.paramName ?? "" };
      case "expr":
        return { kind: "expr", expression: slot.expression ?? "" };
      case "resolver": {
        const resolverArgs = slot.resolverArgs ?? [];
        return {
          kind: "resolver",
          name: slot.resolverName ?? "",
          ...(resolverArgs.length > 0
            ? { args: resolverArgs.map((raw) => parseLiteralValue(raw)) }
            : {}),
        };
      }
      case "literal":
      case "ref":
      default:
        // "ref" with no bound edge falls back to a literal (see module doc).
        return { kind: "literal", value: parseLiteralValue(slot.value) };
    }
  });
  return args;
}

/**
 * Build `DeploymentSpec.parameters` (a flat map of DEFAULT values) from the
 * studio's declared StudioParameter[] list.
 *
 * Core's `DeploymentSpec.parameters` has no notion of "network" — it is
 * purely a name → default-value map (see spec/types.ts's StudioParameter
 * doc). The Parameters panel additionally lets the author record
 * per-network override values (StudioParameter.networkOverrides), purely as
 * studio-authoring state. When `selectedNetwork` is non-null AND the
 * parameter has a non-empty override recorded for it, THAT override value is
 * emitted here in place of `defaultValue` — the emitted spec still only ever
 * carries a single value per parameter name; "switching networks" in the
 * studio just changes WHICH value gets baked into the next
 * export/simulate/deploy. There is no per-network structure in the output.
 *
 * Parameters with an empty `name` are skipped (nothing meaningful to declare).
 *
 * @param parameters      - The declared parameters (Parameters panel state).
 * @param selectedNetwork - The currently-selected network name, or null for
 *                          "no network selected" (always use defaultValue).
 */
function buildParameters(
  parameters: StudioParameter[],
  selectedNetwork: string | null,
): Record<string, LiteralValue> | undefined {
  if (parameters.length === 0) return undefined;
  const result: Record<string, LiteralValue> = {};
  for (const p of parameters) {
    if (p.name === "") continue;
    const override = selectedNetwork !== null ? p.networkOverrides[selectedNetwork] : undefined;
    const raw = override !== undefined && override !== "" ? override : p.defaultValue;
    result[p.name] = parseLiteralValue(raw);
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
 * Args are normalized: StudioAddressRef → RefArg, string literals → LiteralArg.
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
      const args: ConfigArg[] = step.args.map((raw) => normalizeStudioArg(raw));
      // Determine the explicit target deploy-id for cross-node setX steps.
      const effectiveTargetId = step.target ?? attachedTargetId;
      // Resolve the TARGET contract name from the deployId→contractName map.
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

/**
 * Convert StudioOrderedConfigStep[] into ConfigStep[] (for ConfigSpec.orderedSteps).
 * These steps must have an explicit target (no attached-node fallback).
 * Args are normalized: StudioAddressRef → RefArg, string literals → LiteralArg.
 *
 * @param steps              - The global ordered steps.
 * @param deployIdToContract - Map from deployId → contractName for ALL nodes.
 */
function buildOrderedSteps(
  steps: StudioOrderedConfigStep[],
  deployIdToContract: Map<string, string>,
): ConfigStep[] {
  return steps.map((step): ConfigStep => {
    // step.kind is always "setX" for ordered steps.
    const args: ConfigArg[] = step.args.map((raw) => normalizeStudioArg(raw));
    const effectiveTargetId = step.target ?? "";
    const targetContractName = deployIdToContract.get(effectiveTargetId) ?? "";
    const functionField = resolveSetXFunctionField(step, targetContractName);
    return {
      kind: "setX",
      id: step.id,
      target: effectiveTargetId,
      function: functionField,
      ...(args.length > 0 ? { args } : {}),
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
 * @param nodes           - Array of contract nodes from the React Flow state.
 * @param edges           - Array of edges from the React Flow state.
 * @param orderedSteps    - Global ordered config steps (optional, defaults to []).
 * @param parameters      - Declared deployment-wide parameters (optional, defaults to []).
 *                          Emitted as `DeploymentSpec.parameters` (defaults only — see
 *                          buildParameters()'s doc for how `selectedNetwork` affects this).
 * @param selectedNetwork - The currently-selected network name in the Parameters panel,
 *                          or null (optional, defaults to null — always uses defaultValue).
 */
export function graphToSpec(
  nodes: GraphNode[],
  edges: GraphEdge[],
  orderedSteps: StudioOrderedConfigStep[] = [],
  parameters: StudioParameter[] = [],
  selectedNetwork: string | null = null,
): SpecPair {
  // Step 1: Index constructor-ref edges by target node id.
  // refEdges[targetNodeId][argIndex] = sourceDeployId
  const refEdges = new Map<string, Map<number, string>>();

  // Build a lookup map for O(1) node access inside the edge loop (O(N+E) total).
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const edge of edges) {
    const data = edge.data;
    // Only constructorRef edges remain (wire edges have been removed).
    if (!data || data.edgeKind === "constructorRef") {
      const argIndex =
        data && data.edgeKind === "constructorRef" ? data.argIndex : 0;
      const sourceNode = nodeById.get(edge.source);
      const sourceDeployId = sourceNode ? sourceNode.data.deployId : edge.source;
      if (!refEdges.has(edge.target)) {
        refEdges.set(edge.target, new Map());
      }
      refEdges.get(edge.target)!.set(argIndex, sourceDeployId);
    }
    // Unknown edge kinds (e.g. stale wire edges in old data) are silently ignored.
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

  const paramDefaults = buildParameters(parameters, selectedNetwork);

  const deployment: DeploymentSpec = {
    version: 1,
    contracts,
    ...(paramDefaults !== undefined ? { parameters: paramDefaults } : {}),
  };

  // Step 3: Build a deployId → contractName map for ALL nodes.
  const deployIdToContract = new Map<string, string>(
    nodes.map((n) => [n.data.deployId, n.data.contractName]),
  );

  // Step 4: Build ConfigStep[] from node-attached steps (→ ConfigSpec.steps).
  const nodeConfigSteps: ConfigStep[] = nodes.flatMap((node) =>
    buildConfigSteps(node.data.configSteps, node.data.deployId, deployIdToContract, node.data.contractName),
  );

  // Step 5: Build ConfigStep[] from global ordered steps (→ ConfigSpec.orderedSteps).
  const builtOrderedSteps: ConfigStep[] = buildOrderedSteps(orderedSteps, deployIdToContract);

  const config: ConfigSpec = {
    version: 1,
    steps: nodeConfigSteps,
    ...(builtOrderedSteps.length > 0 ? { orderedSteps: builtOrderedSteps } : {}),
  };

  return { deployment, config };
}

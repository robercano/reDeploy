/**
 * useGraph.ts
 *
 * React state management for the authoring canvas graph.
 * Provides callbacks for adding/updating/removing nodes and for managing
 * config steps attached to nodes, plus the global ordered config steps list.
 *
 * Callbacks are injected into node data so that React Flow custom nodes
 * can call them directly (React Flow only passes `data` to custom nodes).
 *
 * ## Type note
 * React Flow requires `Node<T>` where `T extends Record<string, unknown>`.
 * Our `ContractNodeData` interface does not declare an index signature so it
 * technically does not satisfy that constraint. We therefore use
 * `Node<Record<string, unknown>>` at the React Flow API boundary and cast
 * `node.data` to `ContractNodeData` wherever we access it internally.
 *
 * ## Wire edges (removed)
 * The wire-edge path has been removed from onConnect. Cross-contract wiring is
 * now expressed as a config call step with an address-ref arg. Only
 * constructorRef edges are created by onConnect now.
 *
 * ## Persistence (issue #80)
 * On mount, any valid saved authoring state (nodes/edges/orderedSteps) is
 * restored from localStorage via authoring-persistence.ts's
 * loadPersistedState(). Every subsequent change is autosaved back, debounced
 * by AUTOSAVE_DEBOUNCE_MS. resetGraph() clears both the in-memory state and
 * the persisted copy for the "New / Clear canvas" affordance in App.tsx.
 *
 * ## Node deletion (issue #80)
 * Deleting a node (via ContractNode's delete button → useReactFlow().deleteElements,
 * or via Delete/Backspace → React Flow's deleteKeyCode) always removes the
 * node and any edges connected to it (React Flow computes connectedEdges
 * internally and routes the removal through both onNodesChange and
 * onEdgesChange). onNodesChange additionally prunes any *dangling references*
 * to the deleted contract left behind on OTHER nodes: "after" ordering
 * constraints, per-node config steps targeting/referencing its deployId, and
 * global ordered steps referencing it — see stepReferencesDeployId().
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  Node,
  Edge,
  Connection,
  OnNodesChange,
  OnEdgesChange,
  NodeChange,
} from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges, addEdge } from "@xyflow/react";
import type {
  ContractNodeData,
  StudioAddressRef,
  StudioConfigStep,
  StudioEdgeData,
  StudioSetXStep,
  StudioGrantRoleStep,
  StudioOrderedConfigStep,
  StudioParameter,
  StudioReadRef,
  ArgSlotUpdate,
} from "../spec/types.js";
import type { ContractManifest, ManifestFunction } from "../manifest/index.js";
import type { Template } from "../templates/types.js";
import {
  loadPersistedState,
  savePersistedState,
  clearPersistedState,
} from "./authoring-persistence.js";
import type { PersistedNode, PersistedEdge, PersistedState } from "./authoring-persistence.js";

// ---------------------------------------------------------------------------
// Typed React Flow node / edge aliases
// ---------------------------------------------------------------------------

// React Flow requires data to extend Record<string, unknown>. We use the
// widened base types at the React Flow API boundary and cast to our precise
// internal types at every access site.
export type ContractFlowNode = Node<Record<string, unknown>>;
export type StudioFlowEdge = Edge<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Counters (module-level for stable ids within a session)
// ---------------------------------------------------------------------------

let nodeCounter = 0;
let stepCounter = 0;

function makeNodeId(): string {
  return `contract-${++nodeCounter}`;
}

function makeStepId(prefix: string): string {
  return `${prefix}-${++stepCounter}`;
}

/**
 * Bump nodeCounter/stepCounter past any ids found in restored persisted
 * state so freshly-created nodes/steps after a reload can never collide with
 * restored ones. Node ids look like "contract-N"; step ids look like
 * "<prefix>-N" for any prefix (setX/grantRole/ordered all share ONE counter
 * — see makeStepId above) — so we scan for the trailing "-N" on every step id
 * regardless of its prefix.
 */
function bumpCountersForPersistedState(state: PersistedState): void {
  let maxNode = 0;
  for (const n of state.nodes) {
    const m = /^contract-(\d+)$/.exec(n.id);
    if (m) maxNode = Math.max(maxNode, parseInt(m[1], 10));
  }
  if (maxNode > nodeCounter) nodeCounter = maxNode;

  let maxStep = 0;
  const scanStepId = (id: string) => {
    const m = /-(\d+)$/.exec(id);
    if (m) maxStep = Math.max(maxStep, parseInt(m[1], 10));
  };
  for (const n of state.nodes) {
    for (const s of n.data.configSteps) scanStepId(s.id);
  }
  for (const s of state.orderedSteps) scanStepId(s.id);
  // Parameter ids (issue #137) share the same "-N" suffix convention and the
  // same stepCounter — see makeStepId/makeParamId.
  for (const p of state.parameters ?? []) scanStepId(p.id);
  if (maxStep > stepCounter) stepCounter = maxStep;
}

// ---------------------------------------------------------------------------
// Reference-cleanup helpers (issue #80 — delete-node dangling references)
// ---------------------------------------------------------------------------

/**
 * True when a config step (per-node or ordered) references the given
 * deployId — either as its explicit `target`, as an address-ref in one of
 * its setX args, as a `read`-kind arg sourcing FROM that deployId (or one
 * of the read's own nested addressRef call-args), or as a `ref`-kind
 * grantRole account.
 *
 * An empty deployId never counts as a match: freshly-added, not-yet-named
 * nodes all start with deployId === "", and an incomplete step referencing
 * "" (e.g. an unset grantRole account) must not be pruned just because some
 * OTHER not-yet-named node was deleted.
 */
export function stepReferencesDeployId(
  step: StudioConfigStep | StudioOrderedConfigStep,
  deployId: string,
): boolean {
  if (deployId === "") return false;
  if (step.kind === "setX") {
    if (step.target === deployId) return true;
    return step.args.some((a) => {
      if (typeof a !== "object" || a === null) return false;
      if ((a as StudioAddressRef).kind === "addressRef") {
        return (a as StudioAddressRef).deployId === deployId;
      }
      if ((a as StudioReadRef).kind === "read") {
        const r = a as StudioReadRef;
        if (r.contract === deployId) return true;
        return (r.args ?? []).some(
          (ra) =>
            typeof ra === "object" &&
            ra !== null &&
            (ra as StudioAddressRef).kind === "addressRef" &&
            (ra as StudioAddressRef).deployId === deployId,
        );
      }
      return false;
    });
  }
  return step.accountKind === "ref" && step.accountValue === deployId;
}

/** True when `step` references ANY deployId in `deployIds`. */
function stepReferencesAny(
  step: StudioConfigStep | StudioOrderedConfigStep,
  deployIds: ReadonlySet<string>,
): boolean {
  for (const dep of deployIds) {
    if (stepReferencesDeployId(step, dep)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Persisted-state ↔ flow-node/edge conversion (issue #80)
// ---------------------------------------------------------------------------

function persistedNodeToFlowNode(
  n: PersistedNode,
  onUpdateDeployId: ContractNodeData["onUpdateDeployId"],
  onUpdateContractName: ContractNodeData["onUpdateContractName"],
  onUpdateArgSlot: ContractNodeData["onUpdateArgSlot"],
): ContractFlowNode {
  const data: ContractNodeData = {
    deployId: n.data.deployId,
    contractName: n.data.contractName,
    args: n.data.args,
    after: n.data.after,
    configSteps: n.data.configSteps,
    onUpdateDeployId,
    onUpdateContractName,
    onUpdateArgSlot,
  };
  return {
    id: n.id,
    type: "contractNode",
    position: n.position,
    data: data as unknown as Record<string, unknown>,
  };
}

function persistedEdgeToFlowEdge(e: PersistedEdge): StudioFlowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    ...(e.data ? { data: e.data as unknown as Record<string, unknown> } : {}),
  };
}

/** Debounce window (ms) for the autosave effect. */
const AUTOSAVE_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

interface UseGraphReturn {
  nodes: ContractFlowNode[];
  edges: StudioFlowEdge[];
  selectedNodeId: string | null;
  /** Global ordered config steps (serialized to ConfigSpec.orderedSteps). */
  orderedSteps: StudioOrderedConfigStep[];
  onNodesChange: OnNodesChange<ContractFlowNode>;
  onEdgesChange: OnEdgesChange<StudioFlowEdge>;
  onConnect: (connection: Connection) => void;
  /**
   * Add a pre-filled contract node from a ContractManifest entry.
   *
   * This is the single entry point for adding contracts to the canvas: nodes
   * are always created from the Contracts Browser manifest, so their
   * constructor arg slots are derived from the real ABI (one ArgSlot per
   * constructor parameter) and are fixed for the node's lifetime.
   *
   * Sets contractName = manifest.name, deployId = "" (user fills it),
   * and creates one ArgSlot per constructorArg with the param name and type
   * stored for display purposes only (not serialized to the spec).
   *
   * @param manifest  - The ContractManifest to pre-fill from.
   * @param position  - Optional canvas position. When omitted, uses an
   *                    auto-offset based on the node counter.
   */
  addContractFromManifest: (
    manifest: ContractManifest,
    position?: { x: number; y: number },
  ) => void;
  setSelectedNodeId: (id: string | null) => void;
  /**
   * Add a config-call step to a node.
   *
   * - Pass a `ManifestFunction` (the normal path, driven by AddConfigCallMenu
   *   listing the target contract's REAL state-changing functions — issue
   *   #85/#89) to add a setX step pre-populated with `functionName` /
   *   `functionSignature` and one empty arg slot per real parameter
   *   (`fn.inputs`).
   * - Pass the literal `"grantRole"` to add a blank legacy grantRole-kind
   *   step. The picker itself no longer offers this (grantRole now appears
   *   as a normal setX-shaped function when a contract's ABI declares it),
   *   but the capability is kept on the hook for back-compat: existing
   *   grantRole steps (loaded from persisted graphs / templates) must
   *   remain fully editable via updateGrantRoleStep, and this keeps that
   *   step kind creatable at the hook level for tests / programmatic use.
   */
  addConfigStep: (nodeId: string, choice: ManifestFunction | "grantRole") => void;
  removeConfigStep: (nodeId: string, stepId: string) => void;
  updateSetXStep: (
    nodeId: string,
    stepId: string,
    update: Partial<Omit<StudioSetXStep, "kind" | "id">>,
  ) => void;
  updateGrantRoleStep: (
    nodeId: string,
    stepId: string,
    update: Partial<Omit<StudioGrantRoleStep, "kind" | "id">>,
  ) => void;
  // ---- Global ordered steps ------------------------------------------------
  /** Add a new ordered setX step at the end of the ordered list. */
  addOrderedStep: () => void;
  /** Remove a step from the ordered list by id. */
  removeOrderedStep: (stepId: string) => void;
  /** Update fields of an ordered setX step. */
  updateOrderedStep: (
    stepId: string,
    update: Partial<Omit<StudioSetXStep, "kind" | "id">>,
  ) => void;
  /** Move a step up (toward index 0) in the ordered list. */
  moveOrderedStepUp: (stepId: string) => void;
  /** Move a step down (toward last index) in the ordered list. */
  moveOrderedStepDown: (stepId: string) => void;
  /**
   * Instantiate a template onto the current canvas.
   *
   * - Remaps template-local node ids to fresh, collision-free real graph ids
   *   using the existing module-level nodeCounter / makeNodeId() convention.
   * - De-duplicates deployId seeds against existing node deployIds (suffix -2,
   *   -3, … until unique).
   * - Injects the standard node callbacks (onUpdateDeployId, etc.).
   * - Positions nodes using the template's position offsets, shifted by the
   *   current node count so they don't stack on existing nodes.
   * - Adds constructorRef edges with the correct handle ids and edge data.
   */
  instantiateTemplate: (template: Template) => void;
  /**
   * "New / Clear canvas" (issue #80): resets nodes, edges, orderedSteps, and
   * selectedNodeId to empty/null, and removes the persisted localStorage
   * copy so a reload doesn't resurrect the cleared graph. Also clears
   * parameters/networks/selectedNetwork (issue #137).
   */
  resetGraph: () => void;
  // ---- Deployment-wide parameters (issue #137) -----------------------------
  /** Declared parameters (Parameters panel state), serialized to DeploymentSpec.parameters. */
  parameters: StudioParameter[];
  /** Declared network names for the Parameters panel's per-network override columns. */
  networks: string[];
  /** The currently-selected network, or null. Affects which override value graphToSpec emits. */
  selectedNetwork: string | null;
  /** Add a new (blank) parameter declaration. */
  addParameter: () => void;
  /** Remove a parameter declaration by id. */
  removeParameter: (id: string) => void;
  /** Update a parameter's name and/or defaultValue. */
  updateParameter: (id: string, update: Partial<Omit<StudioParameter, "id" | "networkOverrides">>) => void;
  /** Set a parameter's override value for a specific declared network. */
  updateParameterOverride: (id: string, network: string, value: string) => void;
  /** Declare a new network name (no-op if blank or already declared). */
  addNetwork: (name: string) => void;
  /** Remove a declared network, pruning its override from every parameter and clearing selectedNetwork if it was selected. */
  removeNetwork: (name: string) => void;
  /** Select the network whose override values graphToSpec should emit as defaults (null = use each parameter's defaultValue). */
  setSelectedNetwork: (name: string | null) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGraph(): UseGraphReturn {
  // ---- One-time load of any persisted authoring state (issue #80) -----------
  // Computed once per mount via useMemo so localStorage is parsed exactly
  // once, not on every render. The nodes/edges/orderedSteps useState calls
  // below consume this synchronously in their lazy initializers.
  const persisted = useMemo(() => {
    const state = loadPersistedState();
    if (state) bumpCountersForPersistedState(state);
    return state;
  }, []);

  // Stable ref to setNodes so embedded node-data callbacks can call it. It
  // must exist BEFORE updateNodeData is defined below (which is in turn
  // needed by the nodes useState lazy initializer to embed callbacks into
  // restored node data) — so it starts as a no-op and is assigned its real
  // value immediately after the nodes useState call.
  const setNodesRef = useRef<Dispatch<SetStateAction<ContractFlowNode[]>>>(() => {});

  // ---- Core node data updater -----------------------------------------------
  // Casts node.data to ContractNodeData internally; stores result as Record<string, unknown>

  const updateNodeData = useCallback(
    (nodeId: string, updater: (data: ContractNodeData) => ContractNodeData) => {
      setNodesRef.current((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: updater(
                  n.data as unknown as ContractNodeData,
                ) as unknown as Record<string, unknown>,
              }
            : n,
        ),
      );
    },
    [],
  );

  // ---- Stable callbacks embedded in node data --------------------------------

  const updateDeployId = useCallback(
    (nodeId: string, value: string) =>
      updateNodeData(nodeId, (d) => ({ ...d, deployId: value })),
    [updateNodeData],
  );

  const updateContractName = useCallback(
    (nodeId: string, value: string) =>
      updateNodeData(nodeId, (d) => ({ ...d, contractName: value })),
    [updateNodeData],
  );

  const updateArgSlot = useCallback(
    (nodeId: string, slotIndex: number, update: ArgSlotUpdate) =>
      updateNodeData(nodeId, (d) => ({
        ...d,
        args: d.args.map((slot) =>
          slot.index === slotIndex
            ? { ...slot, ...(typeof update === "string" ? { value: update } : update) }
            : slot,
        ),
      })),
    [updateNodeData],
  );

  const [nodes, setNodes] = useState<ContractFlowNode[]>(() =>
    persisted
      ? persisted.nodes.map((n) =>
          persistedNodeToFlowNode(n, updateDeployId, updateContractName, updateArgSlot),
        )
      : [],
  );
  setNodesRef.current = setNodes;

  const [edges, setEdges] = useState<StudioFlowEdge[]>(() =>
    persisted ? persisted.edges.map(persistedEdgeToFlowEdge) : [],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [orderedSteps, setOrderedSteps] = useState<StudioOrderedConfigStep[]>(
    () => (persisted ? persisted.orderedSteps : []),
  );

  // ---- Deployment-wide parameters (issue #137) -------------------------------
  const [parameters, setParameters] = useState<StudioParameter[]>(
    () => (persisted?.parameters ?? []),
  );
  const [networks, setNetworks] = useState<string[]>(() => persisted?.networks ?? []);
  const [selectedNetwork, setSelectedNetworkState] = useState<string | null>(
    () => persisted?.selectedNetwork ?? null,
  );

  // ---- React Flow change handlers -------------------------------------------

  /**
   * onNodesChange: applies changes as usual, but ALSO detects "remove"
   * changes (from Delete/Backspace via deleteKeyCode, or from
   * useReactFlow().deleteElements triggered by ContractNode's delete button)
   * and prunes any dangling references to the removed contract(s) left on
   * the SURVIVING nodes/ordered-steps — "after" ordering constraints,
   * per-node config steps, and global ordered steps (issue #80). Connected
   * edges are NOT handled here: deleteElements/deleteKeyCode already remove
   * them via onEdgesChange.
   */
  const onNodesChange: OnNodesChange<ContractFlowNode> = useCallback(
    (changes) => {
      const removedIds = changes
        .filter(
          (c): c is Extract<NodeChange<ContractFlowNode>, { type: "remove" }> =>
            c.type === "remove",
        )
        .map((c) => c.id);

      if (removedIds.length === 0) {
        setNodes((nds) => applyNodeChanges(changes, nds));
        return;
      }

      // Capture the deployIds of the nodes being removed BEFORE they're gone.
      const removedDeployIds = new Set<string>();
      for (const n of nodes) {
        if (removedIds.includes(n.id)) {
          const deployId = (n.data as unknown as ContractNodeData).deployId;
          if (deployId !== "") removedDeployIds.add(deployId);
        }
      }

      setNodes((nds) => {
        const next = applyNodeChanges(changes, nds);
        return next.map((n) => {
          const d = n.data as unknown as ContractNodeData;
          // "after" holds raw node ids (see instantiateTemplate) — prune by id
          // regardless of whether the removed node ever got a deployId.
          const after = d.after.filter((id) => !removedIds.includes(id));
          // Config steps target/reference contracts by deployId — only prune
          // when the removed node actually had one (empty deployId can never
          // be a meaningful reference, see stepReferencesDeployId).
          const configSteps =
            removedDeployIds.size > 0
              ? d.configSteps.filter((s) => !stepReferencesAny(s, removedDeployIds))
              : d.configSteps;
          if (after.length === d.after.length && configSteps.length === d.configSteps.length) {
            return n;
          }
          return { ...n, data: { ...d, after, configSteps } as unknown as Record<string, unknown> };
        });
      });

      if (removedDeployIds.size > 0) {
        setOrderedSteps((prev) => prev.filter((s) => !stepReferencesAny(s, removedDeployIds)));
      }
    },
    [nodes],
  );

  const onEdgesChange: OnEdgesChange<StudioFlowEdge> = useCallback((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  /**
   * onConnect: only creates constructorRef edges (wire edges removed).
   * If the target handle matches `-arg-N`, creates a constructorRef edge.
   * Any other connection is silently ignored (no wire edges created).
   */
  const onConnect = useCallback((connection: Connection) => {
    const targetHandle = connection.targetHandle ?? "";
    const argMatch = targetHandle.match(/-arg-(\d+)$/);
    if (argMatch) {
      const argIndex = parseInt(argMatch[1], 10);
      const edgeData: StudioEdgeData = { edgeKind: "constructorRef", argIndex };
      setEdges((eds) =>
        addEdge(
          { ...connection, data: edgeData as unknown as Record<string, unknown> },
          eds,
        ),
      );
    }
    // No wire edge path: connections to non-arg handles are ignored.
    // Cross-contract wiring is now done via config call steps with address-ref args.
  }, []);

  // ---- Node management ------------------------------------------------------

  const addContractFromManifest = useCallback(
    (manifest: ContractManifest, position?: { x: number; y: number }) => {
      const id = makeNodeId();
      const args = manifest.constructorArgs.map((arg, i) => ({
        index: i,
        kind: "literal" as const,
        value: "",
        name: arg.name,
        type: arg.type,
      }));
      const nodeData: ContractNodeData = {
        deployId: "",
        contractName: manifest.name,
        args,
        after: [],
        configSteps: [],
        onUpdateDeployId: updateDeployId,
        onUpdateContractName: updateContractName,
        onUpdateArgSlot: updateArgSlot,
      };
      const newNode: ContractFlowNode = {
        id,
        type: "contractNode",
        position: position ?? { x: 100 + (nodeCounter - 1) * 250, y: 100 },
        data: nodeData as unknown as Record<string, unknown>,
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [updateDeployId, updateContractName, updateArgSlot],
  );

  // ---- Template instantiation -----------------------------------------------

  const instantiateTemplate = useCallback(
    (template: Template) => {
      // Collect existing deployIds from the current nodes closure value to detect
      // collisions. Reads from the closure value rather than inside an updater
      // so both nodes and edges are built from the same consistent snapshot.
      const existingDeployIds = new Set<string>(
        nodes.map((n) => (n.data as unknown as ContractNodeData).deployId),
      );

      // Canvas offset: position templates below existing nodes
      const baseOffsetY = nodes.length > 0 ? 150 : 0;

      // Map from template-local node id → real graph node id.
      // makeNodeId() is invoked once per node here (outside any updater) so that
      // a double-invoke of an updater under StrictMode/concurrent rendering
      // cannot mint duplicate ids or advance the counter twice.
      const idMap = new Map<string, string>();
      for (const tNode of template.nodes) {
        const realId = makeNodeId();
        idMap.set(tNode.id, realId);
      }

      // Helper: de-duplicate a deployId seed against existing + newly-chosen deployIds
      const chosenDeployIds = new Set<string>(existingDeployIds);
      function resolveDeployId(seed: string): string {
        if (!chosenDeployIds.has(seed)) {
          chosenDeployIds.add(seed);
          return seed;
        }
        let counter = 2;
        while (chosenDeployIds.has(`${seed}-${counter}`)) {
          counter++;
        }
        const resolved = `${seed}-${counter}`;
        chosenDeployIds.add(resolved);
        return resolved;
      }

      // Build real nodes (all ids and deployIds are resolved upfront)
      const newNodes: ContractFlowNode[] = template.nodes.map((tNode) => {
        const realId = idMap.get(tNode.id)!;
        const deployId = resolveDeployId(tNode.data.deployIdSeed);
        const nodeData: ContractNodeData = {
          deployId,
          contractName: tNode.data.contractName,
          args: tNode.data.args.map((slot) => ({ ...slot })),
          after: tNode.data.after.map((localId) => idMap.get(localId) ?? localId),
          configSteps: tNode.data.configSteps.map((s) => ({ ...s })),
          onUpdateDeployId: updateDeployId,
          onUpdateContractName: updateContractName,
          onUpdateArgSlot: updateArgSlot,
        };
        return {
          id: realId,
          type: "contractNode",
          position: {
            x: 100 + tNode.data.position.x,
            y: 100 + tNode.data.position.y + baseOffsetY,
          },
          data: nodeData as unknown as Record<string, unknown>,
        };
      });

      // Build edges upfront (edge ids are computed once here, not inside updaters)
      const newEdges: StudioFlowEdge[] = template.edges.map((tEdge) => {
        const realSource = idMap.get(tEdge.source)!;
        const realTarget = idMap.get(tEdge.target)!;
        const edgeData: StudioEdgeData = {
          edgeKind: "constructorRef",
          argIndex: tEdge.argIndex,
        };
        return {
          id: `template-edge-${realSource}-${realTarget}-arg${tEdge.argIndex}`,
          source: realSource,
          target: realTarget,
          sourceHandle: `${realSource}-output`,
          targetHandle: `${realTarget}-arg-${tEdge.argIndex}`,
          data: edgeData as unknown as Record<string, unknown>,
        };
      });

      // Apply the two state updates independently with pure functional updaters.
      // Neither updater calls the other — React can safely invoke each one
      // multiple times under StrictMode/concurrent rendering without side effects.
      setNodes((prev) => [...prev, ...newNodes]);
      setEdges((prev) => [...prev, ...newEdges]);
    },
    [nodes, updateDeployId, updateContractName, updateArgSlot],
  );

  // ---- Per-node config steps ------------------------------------------------

  const addConfigStep = useCallback(
    (nodeId: string, choice: ManifestFunction | "grantRole") => {
      if (choice === "grantRole") {
        // Legacy path (see UseGraphReturn.addConfigStep doc) — no longer
        // reachable from AddConfigCallMenu, kept for back-compat / tests.
        const stepId = makeStepId("grantRole");
        const step: StudioGrantRoleStep = {
          kind: "grantRole",
          id: stepId,
          role: "",
          accountKind: "literal",
          accountValue: "",
        };
        updateNodeData(nodeId, (d) => ({ ...d, configSteps: [...d.configSteps, step] }));
        return;
      }
      // Normal path (issue #85/#89): choice is a REAL manifest function
      // (chosen from AddConfigCallMenu, which lists the target contract's
      // actual state-changing functions). Pre-populate one empty arg slot
      // per real parameter so the step card immediately shows a labeled
      // input for each — see SetXCallCard/ConfigArgInput.
      const stepId = makeStepId("setX");
      const step: StudioSetXStep = {
        kind: "setX",
        id: stepId,
        functionName: choice.name,
        functionSignature: choice.signature,
        args: choice.inputs.map(() => ""),
      };
      updateNodeData(nodeId, (d) => ({ ...d, configSteps: [...d.configSteps, step] }));
    },
    [updateNodeData],
  );

  const removeConfigStep = useCallback(
    (nodeId: string, stepId: string) =>
      updateNodeData(nodeId, (d) => ({
        ...d,
        configSteps: d.configSteps.filter((s) => s.id !== stepId),
      })),
    [updateNodeData],
  );

  const updateSetXStep = useCallback(
    (nodeId: string, stepId: string, update: Partial<Omit<StudioSetXStep, "kind" | "id">>) =>
      updateNodeData(nodeId, (d) => ({
        ...d,
        configSteps: d.configSteps.map((s) =>
          s.id === stepId && s.kind === "setX" ? { ...s, ...update } : s,
        ),
      })),
    [updateNodeData],
  );

  const updateGrantRoleStep = useCallback(
    (
      nodeId: string,
      stepId: string,
      update: Partial<Omit<StudioGrantRoleStep, "kind" | "id">>,
    ) =>
      updateNodeData(nodeId, (d) => ({
        ...d,
        configSteps: d.configSteps.map((s) =>
          s.id === stepId && s.kind === "grantRole" ? { ...s, ...update } : s,
        ),
      })),
    [updateNodeData],
  );

  // ---- Global ordered steps -------------------------------------------------

  const addOrderedStep = useCallback(() => {
    const stepId = makeStepId("ordered");
    const step: StudioOrderedConfigStep = { kind: "setX", id: stepId, functionName: "", args: [] };
    setOrderedSteps((prev) => [...prev, step]);
  }, []);

  const removeOrderedStep = useCallback((stepId: string) => {
    setOrderedSteps((prev) => prev.filter((s) => s.id !== stepId));
  }, []);

  const updateOrderedStep = useCallback(
    (stepId: string, update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => {
      setOrderedSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, ...update } : s)),
      );
    },
    [],
  );

  const moveOrderedStepUp = useCallback((stepId: string) => {
    setOrderedSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === stepId);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }, []);

  const moveOrderedStepDown = useCallback((stepId: string) => {
    setOrderedSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === stepId);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }, []);

  // ---- Deployment-wide parameters (issue #137) -------------------------------

  const addParameter = useCallback(() => {
    const id = makeStepId("param");
    const param: StudioParameter = { id, name: "", defaultValue: "", networkOverrides: {} };
    setParameters((prev) => [...prev, param]);
  }, []);

  const removeParameter = useCallback((id: string) => {
    setParameters((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const updateParameter = useCallback(
    (id: string, update: Partial<Omit<StudioParameter, "id" | "networkOverrides">>) => {
      setParameters((prev) => prev.map((p) => (p.id === id ? { ...p, ...update } : p)));
    },
    [],
  );

  const updateParameterOverride = useCallback((id: string, network: string, value: string) => {
    setParameters((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, networkOverrides: { ...p.networkOverrides, [network]: value } } : p,
      ),
    );
  }, []);

  const addNetwork = useCallback((name: string) => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setNetworks((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  }, []);

  /**
   * Remove a declared network. Also prunes that network's override entry from
   * every parameter (a dangling override for a network that no longer exists
   * would otherwise linger, unreachable from the panel's UI) and clears
   * `selectedNetwork` if it was the one being removed (falls back to "no
   * network selected" rather than silently keeping a reference to a removed
   * network).
   */
  const removeNetwork = useCallback((name: string) => {
    setNetworks((prev) => prev.filter((n) => n !== name));
    setParameters((prev) =>
      prev.map((p) => {
        if (!(name in p.networkOverrides)) return p;
        const rest = Object.fromEntries(
          Object.entries(p.networkOverrides).filter(([k]) => k !== name),
        );
        return { ...p, networkOverrides: rest };
      }),
    );
    setSelectedNetworkState((prev) => (prev === name ? null : prev));
  }, []);

  const setSelectedNetwork = useCallback((name: string | null) => {
    setSelectedNetworkState(name);
  }, []);

  // ---- Autosave (debounced) — issue #80 --------------------------------------
  // Every change to nodes/edges/orderedSteps resets a short debounce timer;
  // the actual localStorage write only happens once changes settle for
  // AUTOSAVE_DEBOUNCE_MS, so rapid typing doesn't hammer localStorage.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      savePersistedState(nodes, edges, orderedSteps, parameters, networks, selectedNetwork);
      saveTimerRef.current = null;
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [nodes, edges, orderedSteps, parameters, networks, selectedNetwork]);

  // ---- Reset ("New / Clear canvas") — issue #80 ------------------------------

  const resetGraph = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setNodes([]);
    setEdges([]);
    setOrderedSteps([]);
    setSelectedNodeId(null);
    setParameters([]);
    setNetworks([]);
    setSelectedNetworkState(null);
    clearPersistedState();
  }, []);

  return {
    nodes,
    edges,
    selectedNodeId,
    orderedSteps,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addContractFromManifest,
    instantiateTemplate,
    setSelectedNodeId,
    addConfigStep,
    removeConfigStep,
    updateSetXStep,
    updateGrantRoleStep,
    addOrderedStep,
    removeOrderedStep,
    updateOrderedStep,
    moveOrderedStepUp,
    moveOrderedStepDown,
    resetGraph,
    // Deployment-wide parameters (issue #137)
    parameters,
    networks,
    selectedNetwork,
    addParameter,
    removeParameter,
    updateParameter,
    updateParameterOverride,
    addNetwork,
    removeNetwork,
    setSelectedNetwork,
  };
}

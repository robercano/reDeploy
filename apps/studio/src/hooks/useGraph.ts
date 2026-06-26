/**
 * useGraph.ts
 *
 * React state management for the authoring canvas graph.
 * Provides callbacks for adding/updating/removing nodes and for managing
 * config steps attached to nodes.
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
 */

import { useState, useCallback, useRef } from "react";
import type { Node, Edge, Connection, OnNodesChange, OnEdgesChange } from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges, addEdge } from "@xyflow/react";
import type {
  ContractNodeData,
  StudioEdgeData,
  StudioSetXStep,
  StudioGrantRoleStep,
} from "../spec/types";

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

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

interface UseGraphReturn {
  nodes: ContractFlowNode[];
  edges: StudioFlowEdge[];
  selectedNodeId: string | null;
  onNodesChange: OnNodesChange<ContractFlowNode>;
  onEdgesChange: OnEdgesChange<StudioFlowEdge>;
  onConnect: (connection: Connection) => void;
  addContractNode: () => void;
  setSelectedNodeId: (id: string | null) => void;
  addConfigStep: (nodeId: string, kind: "setX" | "grantRole") => void;
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
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGraph(): UseGraphReturn {
  const [nodes, setNodes] = useState<ContractFlowNode[]>([]);
  const [edges, setEdges] = useState<StudioFlowEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Stable ref to setNodes so embedded node-data callbacks can call it
  const setNodesRef = useRef(setNodes);
  setNodesRef.current = setNodes;

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
    (nodeId: string, slotIndex: number, value: string) =>
      updateNodeData(nodeId, (d) => ({
        ...d,
        args: d.args.map((slot) =>
          slot.index === slotIndex ? { ...slot, value } : slot,
        ),
      })),
    [updateNodeData],
  );

  const addArgSlot = useCallback(
    (nodeId: string) =>
      updateNodeData(nodeId, (d) => {
        const nextIndex =
          d.args.length > 0 ? Math.max(...d.args.map((a) => a.index)) + 1 : 0;
        return {
          ...d,
          args: [...d.args, { index: nextIndex, kind: "literal" as const, value: "" }],
        };
      }),
    [updateNodeData],
  );

  const removeArgSlot = useCallback(
    (nodeId: string, slotIndex: number) =>
      updateNodeData(nodeId, (d) => ({
        ...d,
        args: d.args.filter((slot) => slot.index !== slotIndex),
      })),
    [updateNodeData],
  );

  // ---- React Flow change handlers -------------------------------------------

  const onNodesChange: OnNodesChange<ContractFlowNode> = useCallback((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange: OnEdgesChange<StudioFlowEdge> = useCallback((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

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
    } else {
      const wireStepId = makeStepId("wire");
      const edgeData: StudioEdgeData = {
        edgeKind: "wire",
        wireStepId,
        wireFunction: "setAddress",
      };
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            data: edgeData as unknown as Record<string, unknown>,
            label: `wire: setAddress`,
          },
          eds,
        ),
      );
    }
  }, []);

  // ---- Node management ------------------------------------------------------

  const addContractNode = useCallback(() => {
    const id = makeNodeId();
    const nodeData: ContractNodeData = {
      deployId: "",
      contractName: "",
      args: [],
      after: [],
      configSteps: [],
      onUpdateDeployId: updateDeployId,
      onUpdateContractName: updateContractName,
      onUpdateArgSlot: updateArgSlot,
      onAddArg: addArgSlot,
      onRemoveArg: removeArgSlot,
    };
    const newNode: ContractFlowNode = {
      id,
      type: "contractNode",
      position: { x: 100 + (nodeCounter - 1) * 250, y: 100 },
      data: nodeData as unknown as Record<string, unknown>,
    };
    setNodes((nds) => [...nds, newNode]);
  }, [updateDeployId, updateContractName, updateArgSlot, addArgSlot, removeArgSlot]);

  // ---- Config steps ---------------------------------------------------------

  const addConfigStep = useCallback(
    (nodeId: string, kind: "setX" | "grantRole") => {
      const stepId = makeStepId(kind);
      updateNodeData(nodeId, (d) => {
        if (kind === "setX") {
          const step: StudioSetXStep = { kind: "setX", id: stepId, functionName: "", args: [] };
          return { ...d, configSteps: [...d.configSteps, step] };
        }
        const step: StudioGrantRoleStep = {
          kind: "grantRole",
          id: stepId,
          role: "",
          accountKind: "literal",
          accountValue: "",
        };
        return { ...d, configSteps: [...d.configSteps, step] };
      });
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

  return {
    nodes,
    edges,
    selectedNodeId,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addContractNode,
    setSelectedNodeId,
    addConfigStep,
    removeConfigStep,
    updateSetXStep,
    updateGrantRoleStep,
  };
}

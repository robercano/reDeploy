/**
 * App.tsx
 *
 * Main authoring canvas: React Flow canvas with contract nodes, a toolbar
 * for adding nodes and exporting, and a config panel for the selected node.
 *
 * ## Type note
 * React Flow requires `Node<T>` where `T extends Record<string, unknown>`.
 * Our `ContractNodeData` interface does not declare a string index signature
 * so we use `Node<Record<string, unknown>>` at the React Flow API boundary
 * and cast `node.data` to `ContractNodeData` when passing it to ConfigPanel.
 */

import { useMemo, useCallback } from "react";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import type { NodeMouseHandler, NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ContractNode } from "./components/ContractNode";
import { ConfigPanel } from "./components/ConfigPanel";
import { SpecExporter } from "./components/SpecExporter";
import { useGraph } from "./hooks/useGraph";
import { graphToSpec } from "./spec/graph-to-spec";
import type { GraphNode, GraphEdge } from "./spec/graph-to-spec";
import type { ContractNodeData } from "./spec/types";

// Register the custom node type once (stable reference required by React Flow).
// Cast to NodeTypes to satisfy the `Record<string, unknown>` data constraint.
const NODE_TYPES: NodeTypes = { contractNode: ContractNode } as unknown as NodeTypes;

const toolbarStyle: React.CSSProperties = {
  position: "fixed",
  top: 12,
  left: 12,
  zIndex: 10,
  display: "flex",
  gap: 8,
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  cursor: "pointer",
  borderRadius: 4,
  fontSize: 13,
  border: "1px solid #ccc",
  background: "#fff",
  boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
};

export function App() {
  const {
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
  } = useGraph();

  // Compute the spec pair for export whenever nodes/edges change.
  // Strip callbacks from node data — graphToSpec only needs the payload fields.
  const { deployment, config } = useMemo(() => {
    const graphNodes: GraphNode[] = nodes.map((n) => {
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
    const graphEdges: GraphEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));
    return graphToSpec(graphNodes, graphEdges);
  }, [nodes, edges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => setSelectedNodeId(node.id),
    [setSelectedNodeId],
  );

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        <button
          style={btnStyle}
          onClick={addContractNode}
          data-testid="add-contract-btn"
        >
          + Contract
        </button>
        <SpecExporter deployment={deployment} config={config} />
      </div>

      {/* React Flow canvas */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>

      {/* Config panel for selected node */}
      {selectedNode && (
        <ConfigPanel
          nodeId={selectedNode.id}
          data={selectedNode.data as unknown as ContractNodeData}
          onAddStep={addConfigStep}
          onRemoveStep={removeConfigStep}
          onUpdateSetXStep={updateSetXStep}
          onUpdateGrantRoleStep={updateGrantRoleStep}
        />
      )}
    </div>
  );
}

export default App;

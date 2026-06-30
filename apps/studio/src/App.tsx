/**
 * App.tsx
 *
 * Main application: a mode toggle (authoring / inspector) plus the
 * corresponding canvas for each mode.
 *
 * ## Authoring mode (default)
 * React Flow canvas with contract nodes, a toolbar for adding nodes and
 * exporting, and a config panel for the selected node. A toggleable Contracts
 * Browser panel lets users add contracts to the canvas by clicking or dragging.
 *
 * ## Inspector mode
 * Read-only React Flow canvas rendering a DeploymentView (passed as a
 * static in-memory sample for the browser). The actual disk read
 * (readDeployment) is Node-only and lives in src/inspector/load-deployment.ts
 * — it is NOT imported here.
 *
 * ## React Flow + useReactFlow
 * `useReactFlow()` (needed for `screenToFlowPosition` in drag-drop) must be
 * called inside a `<ReactFlowProvider>` ancestor. We therefore split authoring
 * into an outer `App` (holds state + provider) and an inner `AuthoringCanvas`
 * (calls useReactFlow for drop position resolution).
 *
 * ## Type note
 * React Flow requires `Node<T>` where `T extends Record<string, unknown>`.
 * Our `ContractNodeData` interface does not declare a string index signature
 * so we use `Node<Record<string, unknown>>` at the React Flow API boundary
 * and cast `node.data` to `ContractNodeData` when passing it to ConfigPanel.
 */

import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from "@xyflow/react";
import type { NodeMouseHandler, NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ContractNode } from "./components/ContractNode.js";
import { ConfigPanel } from "./components/ConfigPanel.js";
import type { DeployTarget } from "./components/ConfigPanel.js";
import { ContractsBrowser, DRAG_TRANSFER_KEY } from "./components/ContractsBrowser.js";
import { SpecExporter } from "./components/SpecExporter.js";
import { TemplateGallery } from "./components/TemplateGallery.js";
import { SaveTemplateModal } from "./components/SaveTemplateModal.js";
import { Inspector } from "./components/Inspector.js";
import { useGraph } from "./hooks/useGraph.js";
import { useUserTemplates } from "./hooks/useUserTemplates.js";
import { graphToTemplate } from "./templates/serialize.js";
import type { ParamSelection } from "./templates/serialize.js";
import { graphToSpec } from "./spec/graph-to-spec.js";
import type { GraphEdge } from "./spec/graph-to-spec.js";
import { toGraphNodes } from "./spec/project-nodes.js";
import type { ContractNodeData, ViewMode } from "./spec/types.js";
import { enrichNodesWithRefSources } from "./spec/enrich-nodes.js";
import { SAMPLE_DEPLOYMENT_VIEW } from "./inspector/sample-view.js";
import { contractManifest } from "./manifest/index.js";
import type { ContractManifest } from "./manifest/types.js";

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

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: "#1a73e8",
  color: "#fff",
  border: "1px solid #1a73e8",
};

type AppMode = "authoring" | "inspector";

// ---------------------------------------------------------------------------
// Inner authoring canvas (must be inside ReactFlowProvider to use useReactFlow)
// ---------------------------------------------------------------------------

interface AuthoringCanvasProps {
  nodes: ReturnType<typeof useGraph>["nodes"];
  edges: ReturnType<typeof useGraph>["edges"];
  onNodesChange: ReturnType<typeof useGraph>["onNodesChange"];
  onEdgesChange: ReturnType<typeof useGraph>["onEdgesChange"];
  onConnect: ReturnType<typeof useGraph>["onConnect"];
  onNodeClick: NodeMouseHandler;
  onPaneClick: () => void;
  addContractFromManifest: ReturnType<typeof useGraph>["addContractFromManifest"];
  instantiateTemplate: ReturnType<typeof useGraph>["instantiateTemplate"];
  selectedNode: ReturnType<typeof useGraph>["nodes"][number] | undefined;
  deployment: ReturnType<typeof graphToSpec>["deployment"];
  config: ReturnType<typeof graphToSpec>["config"];
  addConfigStep: ReturnType<typeof useGraph>["addConfigStep"];
  removeConfigStep: ReturnType<typeof useGraph>["removeConfigStep"];
  updateSetXStep: ReturnType<typeof useGraph>["updateSetXStep"];
  updateGrantRoleStep: ReturnType<typeof useGraph>["updateGrantRoleStep"];
  showBrowser: boolean;
  onToggleBrowser: () => void;
  /** Current view mode ("detailed" | "overview"). */
  viewMode: ViewMode;
  /** Callback to toggle viewMode. */
  onToggleViewMode: () => void;
  /** All deploy targets in the graph, for the setX target picker in ConfigPanel. */
  deployTargets: DeployTarget[];
  /** User-saved templates to pass to TemplateGallery. */
  userTemplates: ReturnType<typeof useUserTemplates>["userTemplates"];
  /** Called when a user template is deleted from the gallery. */
  onDeleteTemplate: ReturnType<typeof useUserTemplates>["deleteTemplate"];
  /** Called when "Save as Template" is confirmed. */
  onSaveTemplate: (name: string, description: string, params: ParamSelection[]) => void;
}

function AuthoringCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  addContractFromManifest,
  instantiateTemplate,
  selectedNode,
  deployment,
  config,
  addConfigStep,
  removeConfigStep,
  updateSetXStep,
  updateGrantRoleStep,
  showBrowser,
  onToggleBrowser,
  viewMode,
  onToggleViewMode,
  deployTargets,
  userTemplates,
  onDeleteTemplate,
  onSaveTemplate,
}: AuthoringCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const [showSaveModal, setShowSaveModal] = useState(false);

  // Build a stable lookup map from uniqueId (sourcePath::name) → ContractManifest
  const manifestById = useMemo(() => {
    const m = new Map<string, ContractManifest>();
    for (const c of contractManifest) {
      m.set(`${c.sourcePath}::${c.name}`, c);
    }
    return m;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(DRAG_TRANSFER_KEY)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const uniqueId = e.dataTransfer.getData(DRAG_TRANSFER_KEY);
      if (!uniqueId) return;
      const manifest = manifestById.get(uniqueId);
      if (!manifest) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addContractFromManifest(manifest, position);
    },
    [manifestById, screenToFlowPosition, addContractFromManifest],
  );

  // Canvas left offset when browser is visible
  const canvasStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: showBrowser ? 280 : 0,
    right: 0,
    bottom: 0,
  };

  return (
    <>
      {/* Authoring toolbar */}
      <div style={{ ...toolbarStyle, left: showBrowser ? 300 : 200 }}>
        <button
          style={showBrowser ? activeBtnStyle : btnStyle}
          onClick={onToggleBrowser}
          data-testid="toggle-contracts-browser"
        >
          Contracts
        </button>
        <button
          style={viewMode === "overview" ? activeBtnStyle : btnStyle}
          onClick={onToggleViewMode}
          data-testid="toggle-view-mode"
        >
          {viewMode === "overview" ? "Overview" : "Detailed"}
        </button>
        <TemplateGallery
          onInstantiate={instantiateTemplate}
          userTemplates={userTemplates}
          onDelete={onDeleteTemplate}
        />
        <button
          style={btnStyle}
          onClick={() => setShowSaveModal(true)}
          data-testid="save-template-btn"
        >
          Save as Template
        </button>
        <SpecExporter deployment={deployment} config={config} />
      </div>

      {/* Save as Template modal */}
      {showSaveModal && (
        <SaveTemplateModal
          nodes={nodes}
          onSave={(name, description, params) => {
            onSaveTemplate(name, description, params);
            setShowSaveModal(false);
          }}
          onClose={() => setShowSaveModal(false)}
        />
      )}

      {/* Contracts browser panel (left sidebar) */}
      {showBrowser && (
        <ContractsBrowser
          onAddContract={(c) => addContractFromManifest(c)}
        />
      )}

      {/* React Flow canvas (drag-drop target) */}
      <div
        style={canvasStyle}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        data-testid="canvas-drop-target"
      >
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
      </div>

      {/* Config panel for selected node */}
      {selectedNode && (
        <ConfigPanel
          nodeId={selectedNode.id}
          data={selectedNode.data as unknown as ContractNodeData}
          deployTargets={deployTargets}
          onAddStep={addConfigStep}
          onRemoveStep={removeConfigStep}
          onUpdateSetXStep={updateSetXStep}
          onUpdateGrantRoleStep={updateGrantRoleStep}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export function App() {
  const [mode, setMode] = useState<AppMode>("authoring");
  const [showBrowser, setShowBrowser] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("detailed");

  const {
    nodes,
    edges,
    selectedNodeId,
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
  } = useGraph();

  const { userTemplates, saveTemplate, deleteTemplate } = useUserTemplates();

  // Compute the spec pair for export whenever nodes/edges change.
  // toGraphNodes strips all display-only fields (viewMode, refSourceDeployIds)
  // and callbacks — graphToSpec only reads the five payload fields.
  const { deployment, config } = useMemo(() => {
    const graphNodes = toGraphNodes(nodes);
    const graphEdges: GraphEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: e.data as unknown as GraphEdge["data"],
    }));
    return graphToSpec(graphNodes, graphEdges);
  }, [nodes, edges]);

  // Enrich nodes in two steps:
  // 1. enrichNodesWithRefSources — inject refSourceDeployIds from edges (#54).
  // 2. Inject viewMode — presentation-only, never reaches graphToSpec (#55).
  // Composition: viewMode is applied ON TOP of the enriched nodes so both
  // display-only fields coexist without conflicts.
  const enrichedNodes = useMemo(() => {
    const withRefSources = enrichNodesWithRefSources(nodes, edges);
    return withRefSources.map((n) => ({
      ...n,
      data: {
        ...n.data,
        viewMode,
      },
    }));
  }, [nodes, edges, viewMode]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => setSelectedNodeId(node.id),
    [setSelectedNodeId],
  );

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId]);

  const selectedNode = enrichedNodes.find((n) => n.id === selectedNodeId);

  // Derive deploy targets from all graph nodes — used by ConfigPanel's setX target picker.
  // Dedup by deployId so the picker never receives duplicate keys (duplicate deployIds are
  // a user error caught by validateSpec, but the UI must not crash before validation runs).
  const deployTargets = useMemo<DeployTarget[]>(() => {
    const seen = new Set<string>();
    const targets: DeployTarget[] = [];
    for (const n of nodes) {
      const d = n.data as unknown as ContractNodeData;
      if (d.deployId !== "" && !seen.has(d.deployId)) {
        seen.add(d.deployId);
        targets.push({ deployId: d.deployId, contractName: d.contractName });
      }
    }
    return targets;
  }, [nodes]);

  const onToggleBrowser = useCallback(() => setShowBrowser((v) => !v), []);
  const onToggleViewMode = useCallback(
    () => setViewMode((v) => (v === "detailed" ? "overview" : "detailed")),
    [],
  );

  const handleSaveTemplate = useCallback(
    (name: string, description: string, params: ParamSelection[]) => {
      const id = `user-${Date.now()}`;
      const template = graphToTemplate(nodes, edges, id, name, description, params);
      saveTemplate(template);
    },
    [nodes, edges, saveTemplate],
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Mode toggle toolbar */}
      <div style={toolbarStyle}>
        <button
          style={mode === "authoring" ? activeBtnStyle : btnStyle}
          onClick={() => setMode("authoring")}
          data-testid="mode-authoring"
        >
          Authoring
        </button>
        <button
          style={mode === "inspector" ? activeBtnStyle : btnStyle}
          onClick={() => setMode("inspector")}
          data-testid="mode-inspector"
        >
          Inspector
        </button>
      </div>

      {mode === "authoring" && (
        <ReactFlowProvider>
          <AuthoringCanvas
            nodes={enrichedNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            addContractFromManifest={addContractFromManifest}
            instantiateTemplate={instantiateTemplate}
            selectedNode={selectedNode}
            deployment={deployment}
            config={config}
            addConfigStep={addConfigStep}
            removeConfigStep={removeConfigStep}
            updateSetXStep={updateSetXStep}
            updateGrantRoleStep={updateGrantRoleStep}
            showBrowser={showBrowser}
            onToggleBrowser={onToggleBrowser}
            viewMode={viewMode}
            onToggleViewMode={onToggleViewMode}
            deployTargets={deployTargets}
            userTemplates={userTemplates}
            onDeleteTemplate={deleteTemplate}
            onSaveTemplate={handleSaveTemplate}
          />
        </ReactFlowProvider>
      )}

      {mode === "inspector" && (
        <Inspector view={SAMPLE_DEPLOYMENT_VIEW} />
      )}
    </div>
  );
}

export default App;

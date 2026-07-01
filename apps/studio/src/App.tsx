/**
 * App.tsx
 *
 * Main application: a mode toggle (authoring / inspector) plus the
 * corresponding canvas for each mode.
 *
 * ## Authoring mode (default)
 * React Flow canvas with contract nodes, a toolbar for adding nodes and
 * exporting, and a per-node inline config section. A toggleable Contracts
 * Browser panel lets users add contracts to the canvas by clicking or dragging.
 * A toolbar-openable Ordered Config panel lists globally ordered config steps.
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
 * ## ConfigCallbacks injection
 * Per-node config call callbacks (addConfigStep, removeConfigStep, etc.) and
 * the current deployTargets are injected into each node's data.configCallbacks
 * field so that ContractNode can render the inline config section without
 * receiving them as direct React props (React Flow only passes `data`).
 *
 * ## Type note
 * React Flow requires `Node<T>` where `T extends Record<string, unknown>`.
 * Our `ContractNodeData` interface does not declare a string index signature
 * so we use `Node<Record<string, unknown>>` at the React Flow API boundary
 * and cast `node.data` to `ContractNodeData` when accessing it internally.
 */

import { useMemo, useCallback, useState, useRef, useEffect } from "react";
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
import type { ConfigCallbacks, CanvasDeployTarget } from "./components/ContractNode.js";
import { ContractsBrowser, DRAG_TRANSFER_KEY } from "./components/ContractsBrowser.js";
import { SpecExporter } from "./components/SpecExporter.js";
import { TemplateGallery } from "./components/TemplateGallery.js";
import { SaveTemplateModal } from "./components/SaveTemplateModal.js";
import { Inspector } from "./components/Inspector.js";
import { OrderedConfigPanelToggle } from "./components/OrderedConfigPanel.js";
import type { OrderedPanelDeployTarget } from "./components/OrderedConfigPanel.js";
import { useGraph } from "./hooks/useGraph.js";
import { useUserTemplates } from "./hooks/useUserTemplates.js";
import { graphToTemplate } from "./templates/serialize.js";
import type { ParamSelection } from "./templates/serialize.js";
import { graphToSpec } from "./spec/graph-to-spec.js";
import type { GraphEdge } from "./spec/graph-to-spec.js";
import { toGraphNodes } from "./spec/project-nodes.js";
import { overviewEdges } from "./spec/overview-edges.js";
import type { ContractNodeData, ViewMode } from "./spec/types.js";
import { enrichNodesWithRefSources } from "./spec/enrich-nodes.js";
import { SAMPLE_DEPLOYMENT_VIEW } from "./inspector/sample-view.js";
import { runSimulate } from "./deploy/simulate-client.js";
import { runDeploy } from "./deploy/deploy-client.js";
import type { DeploymentView } from "@redeploy/reader";
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

// The authoring toolbar sits on a second row (top: 52) so it never overlaps the
// mode-toggle + Deploy toolbar on the first row (top: 12). The left offset shifts
// right when the Contracts Browser panel is open so it doesn't slide under the panel.
const AUTHORING_TOOLBAR_TOP = 52;
const authoringToolbarBaseStyle: React.CSSProperties = {
  position: "fixed",
  top: AUTHORING_TOOLBAR_TOP,
  zIndex: 10,
  display: "flex",
  gap: 8,
};

// Banners stack below the authoring toolbar row. Each banner is ~36px tall with
// 4px gap → row 1 starts at AUTHORING_TOOLBAR_TOP + 40, row 2 at + 80.
const ERROR_BANNER_TOP = AUTHORING_TOOLBAR_TOP + 40;
const SUCCESS_BANNER_TOP = AUTHORING_TOOLBAR_TOP + 80;

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
  deployment: ReturnType<typeof graphToSpec>["deployment"];
  config: ReturnType<typeof graphToSpec>["config"];
  showBrowser: boolean;
  onToggleBrowser: () => void;
  /** Current view mode ("detailed" | "overview"). */
  viewMode: ViewMode;
  /** Callback to toggle viewMode. */
  onToggleViewMode: () => void;
  /** User-saved templates to pass to TemplateGallery. */
  userTemplates: ReturnType<typeof useUserTemplates>["userTemplates"];
  /** Called when a user template is deleted from the gallery. */
  onDeleteTemplate: ReturnType<typeof useUserTemplates>["deleteTemplate"];
  /** Called when "Save as Template" is confirmed. */
  onSaveTemplate: (name: string, description: string, params: ParamSelection[]) => void;
  // Ordered config panel props
  orderedSteps: ReturnType<typeof useGraph>["orderedSteps"];
  deployTargets: OrderedPanelDeployTarget[];
  onAddOrderedStep: ReturnType<typeof useGraph>["addOrderedStep"];
  onRemoveOrderedStep: ReturnType<typeof useGraph>["removeOrderedStep"];
  onUpdateOrderedStep: ReturnType<typeof useGraph>["updateOrderedStep"];
  onMoveOrderedStepUp: ReturnType<typeof useGraph>["moveOrderedStepUp"];
  onMoveOrderedStepDown: ReturnType<typeof useGraph>["moveOrderedStepDown"];
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
  deployment,
  config,
  showBrowser,
  onToggleBrowser,
  viewMode,
  onToggleViewMode,
  userTemplates,
  onDeleteTemplate,
  onSaveTemplate,
  orderedSteps,
  deployTargets,
  onAddOrderedStep,
  onRemoveOrderedStep,
  onUpdateOrderedStep,
  onMoveOrderedStepUp,
  onMoveOrderedStepDown,
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
      {/* Authoring toolbar — second row (top: 52) so it never overlaps the mode-toggle row */}
      <div style={{ ...authoringToolbarBaseStyle, left: showBrowser ? 300 : 12 }}>
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
        <OrderedConfigPanelToggle
          orderedSteps={orderedSteps}
          deployTargets={deployTargets}
          onAddStep={onAddOrderedStep}
          onRemoveStep={onRemoveOrderedStep}
          onUpdateStep={onUpdateOrderedStep}
          onMoveUp={onMoveOrderedStepUp}
          onMoveDown={onMoveOrderedStepDown}
          btnStyle={btnStyle}
          activeBtnStyle={activeBtnStyle}
        />
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
          edges={viewMode === "overview" ? overviewEdges(edges) : edges}
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
  const [simulating, setSimulating] = useState(false);
  const [liveView, setLiveView] = useState<DeploymentView | null>(null);
  const [simulateError, setSimulateError] = useState<string | null>(null);
  const [simulateSuccess, setSimulateSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real-deploy state. `viewKind` discriminates whether the current liveView came
  // from a dry-run simulate or a real deploy, so the Inspector badge reflects the
  // truth. The confirm modal gates the (irreversible) POST behind an explicit
  // confirmation click.
  const [viewKind, setViewKind] = useState<"simulate" | "deploy" | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deploySuccess, setDeploySuccess] = useState<string | null>(null);

  // Keep a ref to the current deployment so the callback always has the latest value
  // without being stale-closed.
  const deploymentRef = useRef<ReturnType<typeof graphToSpec>["deployment"] | null>(null);

  const {
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
  } = useGraph();

  const { userTemplates, saveTemplate, deleteTemplate } = useUserTemplates();

  // Derive deploy targets from all graph nodes.
  const deployTargets = useMemo<CanvasDeployTarget[]>(() => {
    const seen = new Set<string>();
    const targets: CanvasDeployTarget[] = [];
    for (const n of nodes) {
      const d = n.data as unknown as ContractNodeData;
      if (d.deployId !== "" && !seen.has(d.deployId)) {
        seen.add(d.deployId);
        targets.push({ deployId: d.deployId, contractName: d.contractName });
      }
    }
    return targets;
  }, [nodes]);

  // Build stable configCallbacks object to inject into each node's data.
  // These callbacks allow ContractNode to render the inline per-node config section.
  const configCallbacks = useMemo<ConfigCallbacks>(
    () => ({
      onAddConfigStep: addConfigStep,
      onRemoveConfigStep: removeConfigStep,
      onUpdateSetXStep: updateSetXStep,
      onUpdateGrantRoleStep: updateGrantRoleStep,
      deployTargets,
    }),
    [addConfigStep, removeConfigStep, updateSetXStep, updateGrantRoleStep, deployTargets],
  );

  // Compute the spec pair for export whenever nodes/edges/orderedSteps change.
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
    return graphToSpec(graphNodes, graphEdges, orderedSteps);
  }, [nodes, edges, orderedSteps]);

  // Keep ref in sync so the simulate callback is never stale-closed.
  deploymentRef.current = deployment;

  // Clean up the success banner auto-dismiss timer on unmount.
  useEffect(() => {
    return () => {
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  // Enrich nodes in three steps:
  // 1. enrichNodesWithRefSources — inject refSourceDeployIds from edges (#54).
  // 2. Inject viewMode — presentation-only, never reaches graphToSpec (#55).
  // 3. Inject configCallbacks — per-node config section callbacks (#56).
  const enrichedNodes = useMemo(() => {
    const withRefSources = enrichNodesWithRefSources(nodes, edges);
    return withRefSources.map((n) => ({
      ...n,
      data: {
        ...n.data,
        viewMode,
        configCallbacks,
      },
    }));
  }, [nodes, edges, viewMode, configCallbacks]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => setSelectedNodeId(node.id),
    [setSelectedNodeId],
  );

  const onPaneClick = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId]);

  // Keep selectedNodeId in scope for any downstream usage (e.g. future panel targeting)
  void selectedNodeId;

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

  const handleSimulate = useCallback(async () => {
    if (simulating) return;
    setSimulating(true);
    setSimulateError(null);
    // Clear any prior success banner and cancel its timer before a new run.
    setSimulateSuccess(null);
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    const spec = deploymentRef.current;
    const result = await runSimulate(spec);

    if (result.ok) {
      setLiveView(result.view);
      setViewKind("simulate");
      setMode("inspector");
      const n = result.view.contracts.length;
      const msg = `Simulation complete — ${n} planned step(s). No contracts deployed (dry run).`;
      setSimulateSuccess(msg);
      // Auto-dismiss after 5 seconds.
      successTimerRef.current = setTimeout(() => {
        setSimulateSuccess(null);
        successTimerRef.current = null;
      }, 5000);
    } else {
      setSimulateError(result.error);
    }

    setSimulating(false);
  }, [simulating]);

  // "Deploy (real)" opens a confirmation modal — it never POSTs directly.
  const onOpenDeployModal = useCallback(() => {
    if (deploying) return;
    setShowDeployModal(true);
  }, [deploying]);

  const onCancelDeploy = useCallback(() => {
    setShowDeployModal(false);
  }, []);

  const handleDeploy = useCallback(async () => {
    if (deploying) return;
    // Close the confirm modal immediately so a second confirm can't double-fire.
    setShowDeployModal(false);
    setDeploying(true);
    setDeployError(null);
    setDeploySuccess(null);

    const spec = deploymentRef.current;
    const result = await runDeploy(spec);

    if (result.ok) {
      setLiveView(result.view);
      setViewKind("deploy");
      setMode("inspector");
      const n = result.view.contracts.length;
      setDeploySuccess(`Deployment complete — ${n} contract(s) deployed.`);
    } else {
      setDeployError(result.error);
    }

    setDeploying(false);
  }, [deploying]);

  const deployBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: simulating ? "#e8f0fe" : "#34a853",
    color: simulating ? "#1a73e8" : "#fff",
    border: simulating ? "1px solid #1a73e8" : "1px solid #2d8f47",
    cursor: simulating ? "not-allowed" : "pointer",
  };

  // "Deploy (real)" button — red/warning tone to signal danger (irreversible).
  const deployRealBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: deploying ? "#fce8e6" : "#d93025",
    color: deploying ? "#c5221f" : "#fff",
    border: deploying ? "1px solid #c5221f" : "1px solid #a50e0e",
    cursor: deploying ? "not-allowed" : "pointer",
  };

  // Best-effort truthful target descriptor for the confirm modal. We do NOT
  // fabricate an RPC/network: we show the deployment name if the spec exposes
  // one, otherwise a contract count so the user knows WHAT will be broadcast.
  const deployTargetLabel = useMemo(() => {
    const spec = deployment as unknown as Record<string, unknown> | null;
    const name =
      spec && typeof spec["name"] === "string" && spec["name"].trim() !== ""
        ? (spec["name"] as string)
        : null;
    const contracts = Array.isArray(spec?.["contracts"])
      ? (spec!["contracts"] as unknown[]).length
      : 0;
    if (name !== null) return `deployment "${name}" (${contracts} contract(s))`;
    return `${contracts} contract(s) in the current graph`;
  }, [deployment]);

  const errorBannerStyle: React.CSSProperties = {
    position: "fixed",
    top: ERROR_BANNER_TOP,
    left: 12,
    zIndex: 20,
    background: "#fce8e6",
    color: "#c5221f",
    border: "1px solid #f28b82",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 13,
    maxWidth: 600,
    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
  };

  const successBannerStyle: React.CSSProperties = {
    position: "fixed",
    top: SUCCESS_BANNER_TOP,
    left: 12,
    zIndex: 20,
    background: "#e6f4ea",
    color: "#137333",
    border: "1px solid #a8dab5",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 13,
    maxWidth: 600,
    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
  };

  // Confirm-modal styles (mirror SaveTemplateModal's overlay + card approach).
  const deployModalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  };

  const deployModalStyle: React.CSSProperties = {
    background: "#fff",
    borderRadius: 8,
    padding: 24,
    width: 480,
    maxWidth: "90vw",
    boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Mode toggle + Deploy toolbar */}
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
        <button
          style={deployBtnStyle}
          onClick={() => { void handleSimulate(); }}
          disabled={simulating}
          data-testid="deploy-simulate-button"
        >
          {simulating ? "Simulating…" : "Deploy (simulate)"}
        </button>
        <button
          style={deployRealBtnStyle}
          onClick={onOpenDeployModal}
          disabled={deploying}
          data-testid="deploy-real-button"
        >
          {deploying ? "Deploying…" : "Deploy (real)"}
        </button>
      </div>

      {/* Deploy (real) confirmation modal — gates the irreversible POST */}
      {showDeployModal && (
        <div style={deployModalOverlayStyle} data-testid="deploy-real-modal">
          <div style={deployModalStyle}>
            <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#c5221f" }}>
              Confirm real deployment
            </h3>
            <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5 }}>
              This will <strong>broadcast real transactions</strong> to the
              configured network. It is <strong>irreversible</strong> — contracts
              will be deployed on-chain and gas will be spent.
            </p>
            <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5 }}>
              Target: <strong data-testid="deploy-real-target">{deployTargetLabel}</strong>
              <br />
              <span style={{ fontSize: 11, color: "#666" }}>
                Network / RPC is resolved server-side from its environment.
              </span>
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                style={btnStyle}
                onClick={onCancelDeploy}
                data-testid="deploy-real-cancel"
              >
                Cancel
              </button>
              <button
                style={{
                  ...btnStyle,
                  background: "#d93025",
                  color: "#fff",
                  border: "1px solid #a50e0e",
                }}
                onClick={() => { void handleDeploy(); }}
                data-testid="deploy-real-confirm"
              >
                Deploy for real
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Simulation error banner */}
      {simulateError !== null && (
        <div style={errorBannerStyle} data-testid="deploy-simulate-error">
          {simulateError}
        </div>
      )}

      {/* Simulation success banner */}
      {simulateSuccess !== null && (
        <div style={successBannerStyle} data-testid="deploy-simulate-success">
          {simulateSuccess}
        </div>
      )}

      {/* Real-deploy error banner */}
      {deployError !== null && (
        <div style={errorBannerStyle} data-testid="deploy-real-error">
          {deployError}
        </div>
      )}

      {/* Real-deploy success banner */}
      {deploySuccess !== null && (
        <div style={successBannerStyle} data-testid="deploy-real-success">
          {deploySuccess}
        </div>
      )}

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
            deployment={deployment}
            config={config}
            showBrowser={showBrowser}
            onToggleBrowser={onToggleBrowser}
            viewMode={viewMode}
            onToggleViewMode={onToggleViewMode}
            deployTargets={deployTargets}
            userTemplates={userTemplates}
            onDeleteTemplate={deleteTemplate}
            onSaveTemplate={handleSaveTemplate}
            orderedSteps={orderedSteps}
            onAddOrderedStep={addOrderedStep}
            onRemoveOrderedStep={removeOrderedStep}
            onUpdateOrderedStep={updateOrderedStep}
            onMoveOrderedStepUp={moveOrderedStepUp}
            onMoveOrderedStepDown={moveOrderedStepDown}
          />
        </ReactFlowProvider>
      )}

      {mode === "inspector" && (
        <Inspector
          view={liveView ?? SAMPLE_DEPLOYMENT_VIEW}
          contextLabel={
            liveView !== null && viewKind !== null
              ? viewKind === "deploy"
                ? "Real deployment (broadcast on-chain)"
                : "Simulated plan (dry run)"
              : undefined
          }
        />
      )}
    </div>
  );
}

export default App;

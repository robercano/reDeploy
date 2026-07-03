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
import { buildNodeFieldErrors, validateConstructorArgs } from "./deploy/field-errors.js";
import type { NodeFieldErrors } from "./deploy/field-errors.js";
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
// mode-toggle + Deploy toolbar on the first row (top: 12).
//
// ## Issue #80 — no conditional left-offset
// Previously this row shifted right (left: 12 → 300) whenever the Contracts
// Browser panel opened, so it no longer aligned with the first (mode-toggle)
// row, which never moves. That produced a visible "second row jumps right"
// glitch every time the panel was toggled.
//
// Fix: BOTH toolbar rows now stay at a fixed left:12 at all times — opening
// the browser causes no relative displacement between them. Instead, the
// Contracts Browser panel itself is positioned low enough (see
// ContractsBrowser's `top` prop, wired below) to clear both fixed rows, so a
// conditional offset is never needed in the first place.
const AUTHORING_TOOLBAR_TOP = 52;
const AUTHORING_TOOLBAR_LEFT = 12;
const authoringToolbarBaseStyle: React.CSSProperties = {
  position: "fixed",
  top: AUTHORING_TOOLBAR_TOP,
  left: AUTHORING_TOOLBAR_LEFT,
  zIndex: 10,
  display: "flex",
  gap: 8,
};

// Banners stack below the authoring toolbar row. Each banner is ~36px tall with
// 4px gap → row 1 starts at AUTHORING_TOOLBAR_TOP + 40, row 2 at + 80.
const ERROR_BANNER_TOP = AUTHORING_TOOLBAR_TOP + 40;
const SUCCESS_BANNER_TOP = AUTHORING_TOOLBAR_TOP + 80;

// The Contracts Browser panel must start below BOTH fixed toolbar rows so it
// never needs to push either row aside (see note above). Row 2 bottom edge is
// roughly at ERROR_BANNER_TOP (52 + 40 = 92); give the panel a hair more
// clearance still.
const BROWSER_PANEL_TOP = AUTHORING_TOOLBAR_TOP + 44;

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
  /** Opens the "New / Clear canvas" confirmation modal (issue #80). */
  onNewCanvas: () => void;
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
  onNewCanvas,
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
      {/* Authoring toolbar — second row (top: 52) so it never overlaps the mode-toggle row.
          Fixed left:12 at all times (issue #80) — opening/closing the Contracts Browser
          panel never displaces this row relative to the mode-toggle row above it. */}
      <div style={authoringToolbarBaseStyle}>
        <button
          style={showBrowser ? activeBtnStyle : btnStyle}
          onClick={onToggleBrowser}
          data-testid="toggle-contracts-browser"
        >
          Contracts
        </button>
        <button
          style={btnStyle}
          onClick={onNewCanvas}
          title="Clear the canvas and start a new authoring session"
          data-testid="new-canvas-btn"
        >
          New
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

      {/* Contracts browser panel (left sidebar). `top` is pinned below BOTH
          fixed toolbar rows (see BROWSER_PANEL_TOP) so opening/closing this
          panel never requires shifting either toolbar row (issue #80). */}
      {showBrowser && (
        <ContractsBrowser
          onAddContract={(c) => addContractFromManifest(c)}
          top={BROWSER_PANEL_TOP}
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
          deleteKeyCode={["Delete", "Backspace"]}
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

  // "New / Clear canvas" (issue #80) — gated behind a confirm modal since it
  // discards the entire authoring graph (and its localStorage autosave).
  const [showNewCanvasModal, setShowNewCanvasModal] = useState(false);

  // Per-node field/node-level validation error highlighting (issue #83).
  // Shared by BOTH the simulate and the real-deploy flow: whichever run fails
  // last populates this map (keyed by canvas node id); a fresh run of either
  // kind clears it immediately, and a successful run of either kind clears it
  // too. See deploy/field-errors.ts for the path → field/node mapping.
  const [fieldErrors, setFieldErrors] = useState<Map<string, NodeFieldErrors>>(new Map());

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
    resetGraph,
  } = useGraph();

  const { userTemplates, saveTemplate, deleteTemplate } = useUserTemplates();

  // Keep a ref to the current nodes so the simulate/deploy callbacks can map
  // structured errors (contracts[i] ⇔ nodes[i], positional — see
  // graph-to-spec.ts) back to canvas node ids without being stale-closed
  // (mirrors deploymentRef above).
  const nodesRef = useRef<typeof nodes>(nodes);
  nodesRef.current = nodes;

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

  // Enrich nodes in four steps:
  // 1. enrichNodesWithRefSources — inject refSourceDeployIds from edges (#54).
  // 2. Inject viewMode — presentation-only, never reaches graphToSpec (#55).
  // 3. Inject configCallbacks — per-node config section callbacks (#56).
  // 4. Inject errors — per-node field/node-level validation highlight (#83).
  const enrichedNodes = useMemo(() => {
    const withRefSources = enrichNodesWithRefSources(nodes, edges);
    return withRefSources.map((n) => ({
      ...n,
      data: {
        ...n.data,
        viewMode,
        configCallbacks,
        errors: fieldErrors.get(n.id),
      },
    }));
  }, [nodes, edges, viewMode, configCallbacks, fieldErrors]);

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

  // "New / Clear canvas" — open the confirm modal; the actual reset only
  // happens once the user confirms (handleConfirmNewCanvas).
  const onNewCanvas = useCallback(() => setShowNewCanvasModal(true), []);
  const onCancelNewCanvas = useCallback(() => setShowNewCanvasModal(false), []);
  const handleConfirmNewCanvas = useCallback(() => {
    setShowNewCanvasModal(false);
    resetGraph();
    setSelectedNodeId(null);
    setViewMode("detailed");
  }, [resetGraph, setSelectedNodeId]);

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
    // Clear any prior field/node highlight before a new run (issue #83).
    setFieldErrors(new Map());
    // Clear any prior success banner and cancel its timer before a new run.
    setSimulateSuccess(null);
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    const spec = deploymentRef.current;

    // Studio-side pre-validation (issue #83): the deploy-server does not (yet)
    // reject empty/blank constructor arg literals — an empty arg slot
    // serializes to a structurally valid `null`/blank literal and would
    // silently deploy. Per product requirement every constructor param must
    // have a value, so short-circuit here (no server round-trip) using the
    // SAME structured error shape + highlighting the server would produce.
    const localErrors = spec ? validateConstructorArgs(spec) : [];
    if (localErrors.length > 0) {
      const msgs = localErrors.map((e) => e.message).join("; ");
      setSimulateError(`Simulation failed: ${msgs}`);
      const nodeIds = nodesRef.current.map((n) => n.id);
      setFieldErrors(buildNodeFieldErrors(localErrors, nodeIds));
      setSimulating(false);
      return;
    }

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
      // Map structured errors (when present) to field/node highlights on the
      // canvas (issue #83). contracts[i] ⇔ nodes[i] positionally (see
      // graph-to-spec.ts), so nodeIds must reflect the SAME nodes array that
      // was serialized into the DeploymentSpec for this run.
      if (result.errors && result.errors.length > 0) {
        const nodeIds = nodesRef.current.map((n) => n.id);
        setFieldErrors(buildNodeFieldErrors(result.errors, nodeIds));
      }
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
    // Clear any prior field/node highlight before a new run (issue #83).
    setFieldErrors(new Map());
    setDeploySuccess(null);

    const spec = deploymentRef.current;

    // Studio-side pre-validation (issue #83) — see the matching comment in
    // handleSimulate. Short-circuit before the real-deploy POST so an empty
    // constructor arg can never reach the server, let alone broadcast.
    const localErrors = spec ? validateConstructorArgs(spec) : [];
    if (localErrors.length > 0) {
      const msgs = localErrors.map((e) => e.message).join("; ");
      setDeployError(`Deployment failed: ${msgs}`);
      const nodeIds = nodesRef.current.map((n) => n.id);
      setFieldErrors(buildNodeFieldErrors(localErrors, nodeIds));
      setDeploying(false);
      return;
    }

    try {
      const result = await runDeploy(spec);

      if (result.ok) {
        setLiveView(result.view);
        setViewKind("deploy");
        setMode("inspector");
        const n = result.view.contracts.length;
        setDeploySuccess(`Deployment complete — ${n} contract(s) deployed.`);
      } else {
        setDeployError(result.error);
        // Map structured errors (when present) to field/node highlights on
        // the canvas (issue #83) — see the matching comment in handleSimulate.
        if (result.errors && result.errors.length > 0) {
          const nodeIds = nodesRef.current.map((n) => n.id);
          setFieldErrors(buildNodeFieldErrors(result.errors, nodeIds));
        }
      }
    } catch (err) {
      // Defence in depth: runDeploy is expected to resolve with an ok:false
      // result rather than throw, but if anything unexpected escapes we still
      // surface it and (via finally) clear the in-flight flag so the button
      // can never get stuck on "Deploying…".
      setDeployError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
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

      {/* New / Clear canvas confirmation modal (issue #80) */}
      {showNewCanvasModal && (
        <div style={deployModalOverlayStyle} data-testid="new-canvas-modal">
          <div style={deployModalStyle}>
            <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Start a new canvas?</h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5 }}>
              This clears every node, edge, and config step from the authoring
              canvas (including the autosaved copy). This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                style={btnStyle}
                onClick={onCancelNewCanvas}
                data-testid="new-canvas-cancel"
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
                onClick={handleConfirmNewCanvas}
                data-testid="new-canvas-confirm"
              >
                Clear canvas
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
            onNewCanvas={onNewCanvas}
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

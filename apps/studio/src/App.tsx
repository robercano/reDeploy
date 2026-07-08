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
import { SnapshotViewer } from "./components/SnapshotViewer.js";
import { PlanView } from "./components/PlanView.js";
import { parseSnapshot, snapshotToDeploymentView } from "./inspector/snapshot-view.js";
import { computePlan } from "./spec/plan-diff.js";
import type { DeploymentPlan } from "./spec/plan-diff.js";
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
import type { DeploymentView, DeploymentSnapshot } from "@redeploy/reader";
import { contractManifest } from "./manifest/index.js";
import type { ContractManifest } from "./manifest/types.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { useTheme } from "./theme/useTheme.js";
import type { ThemeMode } from "./theme/useTheme.js";

// Register the custom node type once (stable reference required by React Flow).
// Cast to NodeTypes to satisfy the `Record<string, unknown>` data constraint.
const NODE_TYPES: NodeTypes = { contractNode: ContractNode } as unknown as NodeTypes;

// Issue #110 — narrow/portrait viewport overflow.
//
// Both fixed toolbar rows below are `position: fixed` with a fixed `left`
// offset. On narrow viewports (~375–414px, e.g. a phone in portrait) the
// combined width of all the buttons in a row can exceed the remaining
// viewport width to the right of `left`, pushing later buttons off-screen
// with no way to reach or tap them (fixed elements are not part of page
// scroll, and there was no overflow/wrap handling at all).
//
// ## Approach: bounded width + horizontal scroll (not wrap)
// We bound each row's width to the viewport (`maxWidth: calc(100vw - left -
// rightMargin)`) and make it horizontally scrollable (`overflowX: "auto"`,
// `flexWrap: "nowrap"`) rather than letting it wrap to multiple lines.
//
// Wrapping was considered and rejected: these rows are `position: fixed`, so
// a wrapped row grows *downward* by an amount that depends on the current
// viewport width (how many buttons fit per line) and even on browser locale
// / font metrics (button label widths). The banners (ERROR_BANNER_TOP /
// SUCCESS_BANNER_TOP) and the Contracts Browser panel (BROWSER_PANEL_TOP)
// below are positioned using a handful of *fixed* pixel offsets derived from
// each row's height — those constants would need to become dynamic (e.g.
// measured via ResizeObserver) to avoid the two rows, banners, and the
// browser panel colliding whenever a row wraps to 2+ lines. That is a much
// larger change for no material benefit here: a horizontally-scrollable row
// keeps every row's height constant (so all of the existing fixed offsets
// above remain valid, unchanged, on every viewport width) while still making
// every control reachable — the user just swipes/scrolls the row sideways.
//
// `TOOLBAR_ROW_RIGHT_MARGIN` is the breathing room kept between the row and
// the right edge of the viewport so the row's own edge/scrollbar never
// touches the viewport border.
const TOOLBAR_ROW_RIGHT_MARGIN = 12;

const toolbarStyle: React.CSSProperties = {
  position: "fixed",
  top: 12,
  left: 12,
  zIndex: 10,
  display: "flex",
  gap: 8,
  maxWidth: `calc(100vw - 12px - ${TOOLBAR_ROW_RIGHT_MARGIN}px)`,
  overflowX: "auto",
  flexWrap: "nowrap",
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
  // See the "Issue #110" comment above toolbarStyle: bounded width +
  // horizontal scroll (not wrap) keeps this row's height constant so
  // ERROR_BANNER_TOP / SUCCESS_BANNER_TOP / BROWSER_PANEL_TOP below (all
  // derived from a fixed row height) stay correct on every viewport width.
  maxWidth: `calc(100vw - ${AUTHORING_TOOLBAR_LEFT}px - ${TOOLBAR_ROW_RIGHT_MARGIN}px)`,
  overflowX: "auto",
  flexWrap: "nowrap",
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
  border: "1px solid var(--color-border-strong)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text)",
  boxShadow: "var(--shadow-md)",
};

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: "var(--color-primary)",
  color: "var(--color-text-on-accent)",
  border: "1px solid var(--color-primary-border)",
};

// Result-view dismiss control (issue #111). The Simulate/Deploy result
// (read-only Inspector, populated from liveView) fills the entire viewport
// and previously had no reachable way back to the authoring canvas on
// mobile portrait — the mode-toggle row lives at top-left and can scroll
// out of reach on narrow viewports (see the horizontal-scroll note above
// `toolbarStyle`). This button is deliberately independent of that row:
// fixed at the top-right corner (opposite corner from the toolbar, so it
// never competes for the same scroll region), with a z-index above every
// other fixed element in this file (toolbar/banners/panels all use 10-20;
// the deploy-confirm modal overlay — the only thing that should ever sit
// above it — uses 100) so it is never clipped or hidden behind other
// content, including on small screens.
const resultDismissStyle: React.CSSProperties = {
  position: "fixed",
  top: 12,
  right: 12,
  zIndex: 50,
  width: 40,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "50%",
  border: "1px solid var(--color-border-strong)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text)",
  boxShadow: "var(--shadow-md)",
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
};

type AppMode = "authoring" | "inspector";

// Tap-to-add (issue #90) cascade-offset tuning: each successive tap shifts
// the placed node by TAP_CASCADE_STEP_PX (both x and y), wrapping back to 0
// after TAP_CASCADE_MAX steps so the offset never drifts far from center.
const TAP_CASCADE_STEP_PX = 24;
const TAP_CASCADE_MAX = 6;

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
  /** Theme mode driving React Flow's built-in `colorMode` prop (issue #94). */
  themeMode: ThemeMode;
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
  themeMode,
}: AuthoringCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const [showSaveModal, setShowSaveModal] = useState(false);

  // Ref to the canvas drop-target wrapper, used by the tap-to-add fallback
  // (issue #90) to compute the visible canvas center in screen coordinates.
  const canvasWrapperRef = useRef<HTMLDivElement>(null);

  // Counts successive taps so handleTapAddContract can cascade the placement
  // offset — otherwise repeated taps would stack every node on the exact
  // same canvas-center point. Wraps after TAP_CASCADE_MAX steps so the
  // offset doesn't drift indefinitely off-screen.
  const tapCascadeRef = useRef(0);

  // Build a stable lookup map from uniqueId (sourcePath::name) → ContractManifest
  const manifestById = useMemo(() => {
    const m = new Map<string, ContractManifest>();
    for (const c of contractManifest) {
      m.set(`${c.sourcePath}::${c.name}`, c);
    }
    return m;
  }, []);

  // Materializes a contract node at a given flow-space position. Shared by
  // the HTML5 drag/drop path (handleDrop) and the tap/click fallback add
  // path (handleTapAddContract) so both go through the exact same
  // node-creation logic (id-generation / uniqueId conventions live inside
  // addContractFromManifest itself).
  const materializeContractAt = useCallback(
    (manifest: ContractManifest, position: { x: number; y: number }) => {
      addContractFromManifest(manifest, position);
    },
    [addContractFromManifest],
  );

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
      materializeContractAt(manifest, position);
    },
    [manifestById, screenToFlowPosition, materializeContractAt],
  );

  // Tap-to-add fallback (issue #90): native HTML5 drag-and-drop never fires
  // from touch input, so ContractsBrowser rows also call this handler
  // directly (via onAddContract) on tap/click. Places the new node at the
  // visible canvas center — computed from the canvas wrapper's bounding
  // rect, converted to flow space via screenToFlowPosition — with a small
  // cascading offset per successive tap so repeated taps don't stack nodes
  // exactly on top of one another.
  const handleTapAddContract = useCallback(
    (manifest: ContractManifest) => {
      const rect = canvasWrapperRef.current?.getBoundingClientRect();
      const centerX = rect ? rect.left + rect.width / 2 : 0;
      const centerY = rect ? rect.top + rect.height / 2 : 0;

      const step = tapCascadeRef.current % TAP_CASCADE_MAX;
      tapCascadeRef.current += 1;
      const offset = step * TAP_CASCADE_STEP_PX;

      const position = screenToFlowPosition({ x: centerX + offset, y: centerY + offset });
      materializeContractAt(manifest, position);
    },
    [screenToFlowPosition, materializeContractAt],
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
        <ContractsBrowser onAddContract={handleTapAddContract} top={BROWSER_PANEL_TOP} />
      )}

      {/* React Flow canvas (drag-drop target). canvasWrapperRef lets the
          tap-to-add fallback (issue #90) compute the visible canvas center. */}
      <div
        ref={canvasWrapperRef}
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
          colorMode={themeMode}
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
  // Dark-mode theme (issue #94): single source of truth for both the
  // ThemeToggle control and React Flow's `colorMode` prop in BOTH canvases
  // (authoring's AuthoringCanvas and the read-only Inspector).
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const [mode, setMode] = useState<AppMode>("authoring");
  const [showBrowser, setShowBrowser] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("detailed");
  const [simulating, setSimulating] = useState(false);
  const [liveView, setLiveView] = useState<DeploymentView | null>(null);
  const [simulateError, setSimulateError] = useState<string | null>(null);
  const [simulateSuccess, setSimulateSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real-deploy state. `viewKind` discriminates whether the current inspector
  // content came from a dry-run simulate, a real deploy, or a dry-run
  // plan/diff (issue #101), so the Inspector badge / which component renders
  // reflects the truth. The confirm modal gates the (irreversible) POST
  // behind an explicit confirmation click.
  const [viewKind, setViewKind] = useState<"simulate" | "deploy" | "plan" | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deploySuccess, setDeploySuccess] = useState<string | null>(null);

  // Provenance of `liveView`, tracked SEPARATELY from `viewKind` (bugfix,
  // issue #101 review). `viewKind` is the RENDER discriminator — it changes
  // to "plan" as soon as the user clicks Plan, even though `liveView` itself
  // (and what produced it) hasn't changed. If `bestKnownCurrentView` below
  // keyed off `viewKind === "deploy"`, then after Plan #1 (which correctly
  // diffs against a real deploy's liveView) `viewKind` becomes "plan" and
  // every SUBSEQUENT Plan click / deploy-modal summary would see
  // `bestKnownCurrentView === null` and wrongly show everything as "create"
  // — even though a real deploy's result is still sitting in `liveView`.
  // `lastResultKind` instead reflects ONLY "what kind of network result is
  // `liveView`" and is updated exclusively by handleSimulate/handleDeploy,
  // never by handleShowPlan, so it survives any number of subsequent Plan
  // clicks.
  const [lastResultKind, setLastResultKind] = useState<"simulate" | "deploy" | null>(null);

  // Dry-run plan/diff (issue #101): the last computed DeploymentPlan, shown
  // by <PlanView> in inspector mode when viewKind === "plan". Computed
  // synchronously (no network I/O) by handleShowPlan below.
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);

  // "New / Clear canvas" (issue #80) — gated behind a confirm modal since it
  // discards the entire authoring graph (and its localStorage autosave).
  const [showNewCanvasModal, setShowNewCanvasModal] = useState(false);

  // Deployment snapshot viewer (issue #105): a persisted DeploymentSnapshot
  // (from @redeploy/reader's buildSnapshot()) loaded from a local file and
  // rendered read-only in inspector mode, INSTEAD of the default Inspector,
  // while a snapshot is loaded. Purely additive — does not touch the
  // authoring/simulate/deploy flows above.
  const [loadedSnapshot, setLoadedSnapshot] = useState<DeploymentSnapshot | null>(null);
  const [snapshotLoadError, setSnapshotLoadError] = useState<string | null>(null);

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

  // Dry-run plan/diff (issue #101): the best "current state" the studio has
  // in memory to diff the desired spec against. v1 deliberately does NOT
  // fetch on-chain/journal state on demand (that would require a new
  // deploy-server endpoint, out of this module's boundary) — it reuses
  // whichever of these the studio already holds, in priority order:
  //   1. A loaded deployment snapshot (SnapshotViewer / issue #105) — the
  //      user explicitly opted into diffing against this state.
  //   2. The `done` view from the most recent REAL deploy (`lastResultKind
  //      === "deploy"` — see its doc comment above for why this is NOT
  //      `viewKind`) — a simulate's view is intentionally excluded here
  //      since it always has address: null and is not "current state", it's
  //      a previous dry run.
  //   3. Otherwise null — no known current state; computePlan treats that as
  //      "everything is create" and PlanView renders an explanatory note.
  const bestKnownCurrentView = useMemo<DeploymentView | null>(() => {
    if (loadedSnapshot !== null) return snapshotToDeploymentView(loadedSnapshot);
    if (lastResultKind === "deploy" && liveView !== null) return liveView;
    return null;
  }, [loadedSnapshot, lastResultKind, liveView]);

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

  // Mode toggle (issue #105 cleanup): switching mode also clears any loaded
  // snapshot + its load error, so the error banner never lingers after
  // leaving inspector mode and a stale snapshot never silently reappears on
  // returning to it. handleSimulate/handleDeploy intentionally bypass this
  // (they set mode via setMode directly) since they populate liveView, not
  // loadedSnapshot.
  const onSwitchMode = useCallback((next: AppMode) => {
    setMode(next);
    setLoadedSnapshot(null);
    setSnapshotLoadError(null);
  }, []);

  // Is a live Simulate/Deploy/Plan result view (NOT the sample/loaded-snapshot
  // inspector) currently shown? Drives both the dismiss button below and the
  // Esc-to-dismiss handler right after it (issue #111; extended for the
  // dry-run plan view in issue #101). Deliberately does NOT clear
  // liveView/viewKind/plan on dismiss — dismissing just routes back through
  // onSwitchMode("authoring"), the exact same call the "Authoring" toolbar
  // button already makes, so re-opening "Inspector" from the toolbar still
  // shows the last result (unchanged, pre-existing behavior).
  //
  // Bugfix (issue #101 review): this no longer excludes `viewKind === "plan"`
  // when `loadedSnapshot !== null`. PlanView is now allowed to render (see
  // its render block below) whenever `viewKind === "plan"`, REGARDLESS of
  // whether a snapshot is still loaded — a plan computed against a loaded
  // snapshot's state must actually be shown, not silently shadowed by the
  // (now stale, already-diffed) SnapshotViewer. `onLoadSnapshotFile` resets
  // `viewKind` on every successful NEW snapshot load specifically so a
  // freshly loaded snapshot is never itself shadowed by an old plan.
  const showingPlanView = mode === "inspector" && viewKind === "plan" && plan !== null;
  const showingResultView =
    (mode === "inspector" && liveView !== null && loadedSnapshot === null) || showingPlanView;

  // Esc dismisses the live result view and returns to authoring, mirroring
  // the dismiss button. Only listens while the result view is actually
  // shown, and cleans up on unmount / whenever that stops being true.
  useEffect(() => {
    if (!showingResultView) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onSwitchMode("authoring");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showingResultView, onSwitchMode]);

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

  // Deployment snapshot viewer (issue #105): load a JSON file, validate it as
  // a DeploymentSnapshot via parseSnapshot(), and render it read-only via
  // <SnapshotViewer> instead of the default <Inspector>. Never mutates
  // authoring/deploy state; only inspector-mode display state.
  //
  // Uses FileReader (not File.text()) — jsdom's File/Blob polyfill does not
  // implement .text() in every version, so FileReader is the more portable
  // choice for both real browsers and the test environment.
  const onLoadSnapshotFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input value so re-selecting the same file re-triggers onChange.
      event.target.value = "";
      if (file === undefined) return;

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = typeof reader.result === "string" ? reader.result : "";
          const parsed: unknown = JSON.parse(text);
          const snapshot = parseSnapshot(parsed);
          setLoadedSnapshot(snapshot);
          setSnapshotLoadError(null);
          // Bugfix (issue #101 review): a fresh, successfully loaded snapshot
          // must always be visible immediately. Reset viewKind away from
          // "plan" so a stale PlanView (from an earlier Plan click, possibly
          // against a DIFFERENT previously loaded snapshot) never shadows the
          // SnapshotViewer for this newly loaded file — see showingPlanView's
          // doc comment above and the PlanView/SnapshotViewer render block
          // below for how viewKind === "plan" now takes precedence.
          setViewKind(null);
        } catch (err) {
          setLoadedSnapshot(null);
          setSnapshotLoadError(
            err instanceof Error ? err.message : "Failed to load snapshot file",
          );
        }
      };
      reader.onerror = () => {
        setLoadedSnapshot(null);
        setSnapshotLoadError("Failed to read snapshot file");
      };
      reader.readAsText(file);
    },
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
      setLastResultKind("simulate");
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

  // "Plan" (issue #101) — a synchronous, local dry-run create/skip/change
  // preview. Unlike Simulate/Deploy this never touches the network: it
  // diffs the desired spec (deployment + config, already computed above via
  // graphToSpec) against `bestKnownCurrentView` (see its doc comment) using
  // the pure computePlan() from spec/plan-diff.ts.
  const handleShowPlan = useCallback(() => {
    const spec = deploymentRef.current;
    if (spec === null) return;
    const computed = computePlan(spec, config, bestKnownCurrentView);
    setPlan(computed);
    setViewKind("plan");
    setMode("inspector");
  }, [config, bestKnownCurrentView]);

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
        setLastResultKind("deploy");
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
    background: simulating ? "var(--color-primary-bg-subtle)" : "var(--color-success)",
    color: simulating ? "var(--color-primary-text)" : "var(--color-text-on-accent)",
    border: simulating
      ? "1px solid var(--color-primary-border)"
      : "1px solid var(--color-success-border)",
    cursor: simulating ? "not-allowed" : "pointer",
  };

  // "Deploy (real)" button — red/warning tone to signal danger (irreversible).
  const deployRealBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: deploying ? "var(--color-danger-bg)" : "var(--color-danger)",
    color: deploying ? "var(--color-danger-text)" : "var(--color-text-on-accent)",
    border: deploying
      ? "1px solid var(--color-danger-text)"
      : "1px solid var(--color-danger-border)",
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

  // Compact plan preview for the "Deploy (real)" confirm modal (issue #101):
  // a non-blocking, best-effort create/skip/change summary of the desired
  // spec against `bestKnownCurrentView` (a loaded snapshot or the last real
  // deploy's result — null if the studio has no known current state yet, in
  // which case computePlan reports everything as "create"). This never
  // blocks the Deploy button — it's a preview only.
  const deployModalPlanSummary = useMemo(
    () => computePlan(deployment, config, bestKnownCurrentView).summary,
    [deployment, config, bestKnownCurrentView],
  );

  const errorBannerStyle: React.CSSProperties = {
    position: "fixed",
    top: ERROR_BANNER_TOP,
    left: 12,
    zIndex: 20,
    background: "var(--color-danger-bg)",
    color: "var(--color-danger-text)",
    border: "1px solid var(--color-danger-border-faint)",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 13,
    maxWidth: 600,
    boxShadow: "var(--shadow-md)",
  };

  const successBannerStyle: React.CSSProperties = {
    position: "fixed",
    top: SUCCESS_BANNER_TOP,
    left: 12,
    zIndex: 20,
    background: "var(--color-success-bg)",
    color: "var(--color-success-text)",
    border: "1px solid var(--color-success-border-soft)",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 13,
    maxWidth: 600,
    boxShadow: "var(--shadow-md)",
  };

  // Confirm-modal styles (mirror SaveTemplateModal's overlay + card approach).
  const deployModalOverlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "var(--color-overlay)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  };

  const deployModalStyle: React.CSSProperties = {
    background: "var(--color-bg-elevated)",
    borderRadius: 8,
    padding: 24,
    width: 480,
    maxWidth: "90vw",
    boxShadow: "var(--shadow-xl)",
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Mode toggle + Deploy toolbar */}
      <div style={toolbarStyle}>
        <button
          style={mode === "authoring" ? activeBtnStyle : btnStyle}
          onClick={() => onSwitchMode("authoring")}
          data-testid="mode-authoring"
        >
          Authoring
        </button>
        <button
          style={mode === "inspector" ? activeBtnStyle : btnStyle}
          onClick={() => onSwitchMode("inspector")}
          data-testid="mode-inspector"
        >
          Inspector
        </button>
        {mode === "inspector" && (
          <label style={{ ...btnStyle, display: "inline-flex", alignItems: "center" }}>
            Load snapshot
            <input
              type="file"
              accept="application/json,.json"
              onChange={onLoadSnapshotFile}
              data-testid="load-snapshot-input"
              style={{ display: "none" }}
            />
          </label>
        )}
        <button
          style={deployBtnStyle}
          onClick={() => { void handleSimulate(); }}
          disabled={simulating}
          data-testid="deploy-simulate-button"
        >
          {simulating ? "Simulating…" : "Deploy (simulate)"}
        </button>
        <button
          style={btnStyle}
          onClick={handleShowPlan}
          data-testid="deploy-plan-button"
          title="Preview a create/skip/change plan for the current graph (no network call)"
        >
          Plan
        </button>
        <button
          style={deployRealBtnStyle}
          onClick={onOpenDeployModal}
          disabled={deploying}
          data-testid="deploy-real-button"
        >
          {deploying ? "Deploying…" : "Deploy (real)"}
        </button>
        <ThemeToggle mode={themeMode} onChange={setThemeMode} />
      </div>

      {/* Deploy (real) confirmation modal — gates the irreversible POST */}
      {showDeployModal && (
        <div style={deployModalOverlayStyle} data-testid="deploy-real-modal">
          <div style={deployModalStyle}>
            <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "var(--color-danger-text)" }}>
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
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                Network / RPC is resolved server-side from its environment.
              </span>
            </p>
            {/* Compact plan preview (issue #101) — non-blocking, best-effort */}
            <p
              style={{ margin: "0 0 16px", fontSize: 12, lineHeight: 1.5 }}
              data-testid="deploy-real-plan-summary"
            >
              Plan preview: {deployModalPlanSummary.toCreate} to create,{" "}
              {deployModalPlanSummary.toSkip} unchanged,{" "}
              {deployModalPlanSummary.toChange} to change
              {(deployModalPlanSummary.configToCreate > 0 ||
                deployModalPlanSummary.configToSkip > 0) && (
                <>
                  {" "}
                  ({deployModalPlanSummary.configToCreate} config step(s) to run,{" "}
                  {deployModalPlanSummary.configToSkip} already done)
                </>
              )}
              .{" "}
              <span style={{ color: "var(--color-text-secondary)" }}>
                Based on the last known state (loaded snapshot or last real
                deploy) — not a live on-chain check.
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
                  background: "var(--color-danger)",
                  color: "var(--color-text-on-accent)",
                  border: "1px solid var(--color-danger-border)",
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
                  background: "var(--color-danger)",
                  color: "var(--color-text-on-accent)",
                  border: "1px solid var(--color-danger-border)",
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

      {/* Snapshot load error (issue #105) — non-blocking; the normal inspector
          stays visible when a loaded file fails to parse as a DeploymentSnapshot. */}
      {snapshotLoadError !== null && (
        <div style={errorBannerStyle} data-testid="snapshot-load-error">
          {snapshotLoadError}
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
            themeMode={themeMode}
          />
        </ReactFlowProvider>
      )}

      {/* Dry-run plan/diff view (issue #101) — takes precedence over BOTH the
          SnapshotViewer and the default Inspector whenever the most recent
          inspector-mode action was "Plan" (bugfix, issue #101 review): this
          previously required `loadedSnapshot === null`, which meant a plan
          computed against a loaded snapshot's state (bestKnownCurrentView's
          priority-1 source) was a silent no-op — the plan was computed but
          the SnapshotViewer kept winning and nothing changed on screen. See
          showingPlanView's doc comment above for why loading a NEW snapshot
          (onLoadSnapshotFile) resets viewKind so a stale plan never shadows
          it in turn. */}
      {mode === "inspector" && viewKind === "plan" && plan !== null && (
        <PlanView plan={plan} />
      )}

      {mode === "inspector" &&
        loadedSnapshot !== null &&
        !(viewKind === "plan" && plan !== null) && (
          <SnapshotViewer snapshot={loadedSnapshot} themeMode={themeMode} />
        )}

      {mode === "inspector" &&
        loadedSnapshot === null &&
        !(viewKind === "plan" && plan !== null) && (
          <Inspector
            view={liveView ?? SAMPLE_DEPLOYMENT_VIEW}
            contextLabel={
              liveView !== null && viewKind !== null && viewKind !== "plan"
                ? viewKind === "deploy"
                  ? "Real deployment (broadcast on-chain)"
                  : "Simulated plan (dry run)"
                : undefined
            }
            themeMode={themeMode}
          />
        )}

      {/* Result-view dismiss control (issue #111) — a fixed, high-z-index ✕
          reachable independent of the (horizontally-scrollable, top-left)
          mode toggle row, so the Simulate/Deploy result never traps the user
          on mobile portrait. Only shown for a LIVE result (liveView !== null);
          the plain mode-toggle "Inspector" view (SAMPLE_DEPLOYMENT_VIEW) is
          already reachable via the "Authoring" toggle button and is left
          unaffected. Esc performs the same dismiss (see the useEffect above). */}
      {showingResultView && (
        <button
          type="button"
          style={resultDismissStyle}
          onClick={() => onSwitchMode("authoring")}
          data-testid="result-dismiss"
          aria-label="Close result view"
          title="Close result view (Esc)"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export default App;

/**
 * Inspector.tsx
 *
 * Read-only deployment inspector component.
 * Renders a React Flow canvas showing deployed contracts and their links,
 * plus a config-status sidebar listing all config steps with
 * completed/pending badges.
 *
 * Props:
 *   view — a DeploymentView passed from the parent (NOT loaded here;
 *           no disk I/O in this component).
 *
 * ## Type imports
 * Only types are imported from @redeploy/reader (no readDeployment call).
 * The actual disk read happens in load-deployment.ts (Node-only).
 *
 * ## React Flow setup
 * The `inspectorNode` type is registered the same casting way as
 * contractNode in App.tsx to satisfy React Flow's `Record<string, unknown>`
 * data constraint.
 */

import { useMemo } from "react";
import { ReactFlow, Background, Controls } from "@xyflow/react";
import type { NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { DeploymentView, ConfigStepStatus } from "@redeploy/reader";
import { InspectorContractNode } from "./InspectorContractNode.js";
import { deploymentViewToFlow } from "../inspector/view-to-flow.js";
import type { ThemeMode } from "../theme/useTheme.js";

// Register the custom node type once (stable reference required by React Flow).
const INSPECTOR_NODE_TYPES: NodeTypes = {
  inspectorNode: InspectorContractNode,
} as unknown as NodeTypes;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 0,
  top: 0,
  bottom: 0,
  width: 280,
  background: "var(--color-bg-panel)",
  borderLeft: "1px solid var(--color-border)",
  padding: 16,
  overflowY: "auto",
  zIndex: 10,
  fontSize: 13,
  color: "var(--color-text)",
};

const contextBadgeStyle: React.CSSProperties = {
  position: "fixed",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 20,
  background: "var(--color-warning-bg-soft)",
  color: "var(--color-warning-text-strong)",
  border: "1px solid var(--color-warning-border)",
  borderRadius: 4,
  padding: "4px 16px",
  fontSize: 13,
  fontWeight: 600,
  boxShadow: "var(--shadow-md)",
  whiteSpace: "nowrap",
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 8,
  fontSize: 14,
};

const stepCardStyle: React.CSSProperties = {
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 10,
  marginBottom: 10,
};

const badgeBaseStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: 10,
  fontWeight: 600,
  padding: "2px 6px",
  borderRadius: 10,
};

const completedBadgeStyle: React.CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--color-success-bg-strong)",
  color: "var(--color-success-text-strong)",
};

const pendingBadgeStyle: React.CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--color-warning-bg)",
  color: "var(--color-warning-text)",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfigStepCard({ step }: { step: ConfigStepStatus }) {
  const badge = step.completed ? (
    <span
      style={completedBadgeStyle}
      data-testid={`config-step-${step.id}-status`}
    >
      completed
    </span>
  ) : (
    <span
      style={pendingBadgeStyle}
      data-testid={`config-step-${step.id}-status`}
    >
      pending
    </span>
  );

  return (
    <div style={stepCardStyle} data-testid={`config-step-${step.id}`}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: 500, fontSize: 12 }}>{step.id}</span>
        {badge}
      </div>
      {step.kind !== "" && (
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>kind: {step.kind}</div>
      )}
      {step.completedAt !== null && (
        <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginTop: 2 }}>
          {step.completedAt}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector component
// ---------------------------------------------------------------------------

export interface InspectorProps {
  /** The deployment view to render (passed from parent; no disk I/O here). */
  view: DeploymentView;
  /**
   * Optional context label to display as a badge header above the canvas.
   * When present, renders a visible badge (e.g. "Simulated plan (dry run)").
   * When absent (default), no badge is shown — sample and real deployment views
   * are visually unchanged.
   */
  contextLabel?: string;
  /**
   * Theme mode driving React Flow's built-in `colorMode` prop (issue #94).
   * Defaults to "system" so standalone usage (e.g. tests/storybook) still
   * renders a sensible canvas palette without a parent-supplied theme.
   */
  themeMode?: ThemeMode;
}

export function Inspector({ view, contextLabel, themeMode = "system" }: InspectorProps) {
  const { nodes, edges } = useMemo(
    () => deploymentViewToFlow(view),
    [view],
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Dry-run / context badge — only shown when contextLabel is provided */}
      {contextLabel !== undefined && (
        <div style={contextBadgeStyle} data-testid="inspector-context-badge">
          {contextLabel}
        </div>
      )}

      {/* Read-only React Flow canvas */}
      <div style={{ width: "calc(100vw - 280px)", height: "100vh" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={INSPECTOR_NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          colorMode={themeMode}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {/* Config status sidebar */}
      <div style={panelStyle} data-testid="inspector-config-panel">
        <div style={sectionTitleStyle}>Config Steps</div>
        {view.configSteps.length === 0 ? (
          <p style={{ fontSize: 11, color: "var(--color-text-muted)" }}>No config steps.</p>
        ) : (
          view.configSteps.map((step) => (
            <ConfigStepCard key={step.id} step={step} />
          ))
        )}
        {view.warnings.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ ...sectionTitleStyle, color: "var(--color-warning-text)" }}>
              Warnings
            </div>
            {view.warnings.map((w, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  color: "var(--color-warning-text)",
                  marginBottom: 4,
                  background: "var(--color-warning-bg)",
                  padding: "3px 6px",
                  borderRadius: 3,
                }}
              >
                {w}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Inspector;

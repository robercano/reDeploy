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
  background: "#f8f9fa",
  borderLeft: "1px solid #dee2e6",
  padding: 16,
  overflowY: "auto",
  zIndex: 10,
  fontSize: 13,
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 8,
  fontSize: 14,
};

const stepCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #dee2e6",
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
  background: "#d4edda",
  color: "#155724",
};

const pendingBadgeStyle: React.CSSProperties = {
  ...badgeBaseStyle,
  background: "#fff3cd",
  color: "#856404",
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
        <div style={{ fontSize: 11, color: "#555" }}>kind: {step.kind}</div>
      )}
      {step.completedAt !== null && (
        <div style={{ fontSize: 10, color: "#888", marginTop: 2 }}>
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
}

export function Inspector({ view }: InspectorProps) {
  const { nodes, edges } = useMemo(
    () => deploymentViewToFlow(view),
    [view],
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Read-only React Flow canvas */}
      <div style={{ width: "calc(100vw - 280px)", height: "100vh" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={INSPECTOR_NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
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
          <p style={{ fontSize: 11, color: "#888" }}>No config steps.</p>
        ) : (
          view.configSteps.map((step) => (
            <ConfigStepCard key={step.id} step={step} />
          ))
        )}
        {view.warnings.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ ...sectionTitleStyle, color: "#856404" }}>
              Warnings
            </div>
            {view.warnings.map((w, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  color: "#856404",
                  marginBottom: 4,
                  background: "#fff3cd",
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

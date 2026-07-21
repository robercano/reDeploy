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
import type { ConfigDriftResultEntry, SourceVerifyResultEntry } from "../deploy/verify-client.js";
import type { ApplyConfigStepResult } from "../deploy/apply-config-client.js";

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

const failedBadgeStyle: React.CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--color-danger-bg)",
  color: "var(--color-danger-text)",
};

const DRIFT_BADGE_STYLES: Record<string, React.CSSProperties> = {
  match: {
    ...badgeBaseStyle,
    background: "var(--color-success-bg-strong)",
    color: "var(--color-success-text-strong)",
  },
  drift: {
    ...badgeBaseStyle,
    background: "var(--color-danger-bg)",
    color: "var(--color-danger-text)",
  },
  error: {
    ...badgeBaseStyle,
    background: "var(--color-warning-bg)",
    color: "var(--color-warning-text)",
  },
  skipped: {
    ...badgeBaseStyle,
    background: "var(--color-bg-elevated)",
    color: "var(--color-text-muted)",
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfigStepCard({
  step,
  drift,
  applyResult,
}: {
  step: ConfigStepStatus;
  drift?: ConfigDriftResultEntry;
  applyResult?: ApplyConfigStepResult;
}) {
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
        <span style={{ display: "flex", gap: 4 }}>
          {badge}
          {/* Config-drift badge (issue #138) — only rendered once a
              /api/verify/config run has produced a result for this step. */}
          {drift !== undefined && (
            <span
              style={DRIFT_BADGE_STYLES[drift.status] ?? badgeBaseStyle}
              data-testid={`config-step-${step.id}-drift`}
              title={drift.message}
            >
              {drift.status}
            </span>
          )}
          {/* Apply-config failure badge (issue #151) — only rendered when the
              LAST /api/apply-config run reported this step as failed; a
              completed/skipped step is already reflected by the `badge`
              above (view.configSteps is re-read from the journal after a
              successful apply). */}
          {applyResult !== undefined && applyResult.status === "failed" && (
            <span
              style={failedBadgeStyle}
              data-testid={`config-step-${step.id}-apply-status`}
              title={applyResult.message}
            >
              failed
            </span>
          )}
        </span>
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
  /**
   * Per-config-step drift results from the last `/api/verify/config` run
   * (issue #138), matched onto ConfigStepCards by step id. Omitted / no
   * result for a given step id => no drift badge rendered for that step.
   */
  driftResults?: ConfigDriftResultEntry[];
  /**
   * Per-contract source-verification results from the last
   * `/api/verify/source` run (issue #138), matched onto contract nodes by
   * contract id. Omitted / no result for a given id => no verified badge
   * rendered for that node.
   */
  sourceVerifyResults?: SourceVerifyResultEntry[];
  /**
   * Per-step results from the last `/api/apply-config` run (issue #151),
   * matched onto ConfigStepCards by step id. Omitted / no result for a given
   * step id => no apply-failure badge rendered for that step. A completed
   * step is already reflected by `view.configSteps` (re-read from the
   * journal after a successful apply) — this prop only ever ADDS a distinct
   * "failed" badge, it never overrides the completed/pending badge.
   */
  applyConfigResults?: ApplyConfigStepResult[];
}

export function Inspector({
  view,
  contextLabel,
  themeMode = "system",
  driftResults,
  sourceVerifyResults,
  applyConfigResults,
}: InspectorProps) {
  const { nodes, edges } = useMemo(
    () => deploymentViewToFlow(view, sourceVerifyResults),
    [view, sourceVerifyResults],
  );

  const driftById = useMemo(
    () => new Map<string, ConfigDriftResultEntry>((driftResults ?? []).map((r) => [r.id, r])),
    [driftResults],
  );

  const applyResultById = useMemo(
    () =>
      new Map<string, ApplyConfigStepResult>(
        (applyConfigResults ?? []).map((r) => [r.stepId, r]),
      ),
    [applyConfigResults],
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
            <ConfigStepCard
              key={step.id}
              step={step}
              drift={driftById.get(step.id)}
              applyResult={applyResultById.get(step.id)}
            />
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

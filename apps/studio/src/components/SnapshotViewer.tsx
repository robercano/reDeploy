/**
 * SnapshotViewer.tsx
 *
 * Read-only render of a persisted `DeploymentSnapshot` (issue #105):
 * built on top of the existing read-only `<Inspector>` (graph canvas +
 * config-steps sidebar), plus two additional panels layered on top:
 *   - a metadata header (takenAt, chainId, network, toolVersion, specHash)
 *   - a contracts list (id, contractName, address, configured constructor
 *     args) rendered as plain DOM (NOT React Flow nodes) so tests can assert
 *     on addresses/args without depending on React Flow's canvas layout,
 *     which jsdom does not compute reliably.
 *
 * Strictly read-only: no callbacks that mutate snapshot or app state.
 *
 * ## Layout
 * The Inspector's own sidebar is a fixed, right-anchored 280px panel
 * (`inspector-config-panel`). This component's own panels are fixed to the
 * LEFT (metadata header, top-left) and to a left-anchored contracts list
 * below it, so neither overlaps the Inspector's sidebar.
 *
 * ## Type imports
 * Only TYPES are imported from @redeploy/reader — no `readDeployment` /
 * `buildSnapshot` value imports — so this stays safe to bundle in the browser.
 */

import { memo, useMemo } from "react";
import type { ArgValue, BigIntValue, DeploymentSnapshot } from "@redeploy/reader";
import { Inspector } from "./Inspector.js";
import { snapshotToDeploymentView } from "../inspector/snapshot-view.js";
import type { ThemeMode } from "../theme/useTheme.js";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const metaPanelStyle: React.CSSProperties = {
  position: "fixed",
  top: 12,
  left: 12,
  zIndex: 15,
  background: "var(--color-bg-panel)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "10px 14px",
  fontSize: 12,
  color: "var(--color-text)",
  boxShadow: "var(--shadow-md)",
  maxWidth: 420,
};

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginBottom: 2,
};

const metaLabelStyle: React.CSSProperties = {
  color: "var(--color-text-secondary)",
  minWidth: 90,
};

const metaValueStyle: React.CSSProperties = {
  color: "var(--color-text)",
  wordBreak: "break-all",
  fontFamily: "monospace",
};

const contractsPanelStyle: React.CSSProperties = {
  position: "fixed",
  top: 120,
  left: 12,
  bottom: 12,
  width: 340,
  zIndex: 15,
  background: "var(--color-bg-panel)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "10px 14px",
  fontSize: 12,
  color: "var(--color-text)",
  boxShadow: "var(--shadow-md)",
  overflowY: "auto",
};

const contractCardStyle: React.CSSProperties = {
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 8,
  marginBottom: 8,
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 8,
  fontSize: 13,
};

const addressStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "var(--color-primary-text)",
  wordBreak: "break-all",
};

const notDeployedStyle: React.CSSProperties = {
  fontSize: 11,
  fontStyle: "italic",
  color: "var(--color-text-muted)",
};

const argRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  fontSize: 11,
  color: "var(--color-text)",
};

// ---------------------------------------------------------------------------
// Arg value rendering (mirrors InspectorContractNode.tsx's renderArgValue)
// ---------------------------------------------------------------------------

function isBigIntValue(v: ArgValue): v is BigIntValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "$bigint" in v &&
    typeof (v as BigIntValue).$bigint === "string"
  );
}

function renderArgValue(v: ArgValue): string {
  if (v === null) return "null";
  if (isBigIntValue(v)) return v.$bigint;
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SnapshotViewerProps {
  /** The persisted deployment snapshot to render (read-only; no disk I/O here). */
  snapshot: DeploymentSnapshot;
  /** Theme mode, forwarded to the underlying Inspector's React Flow canvas. */
  themeMode?: ThemeMode;
}

function SnapshotViewerImpl({ snapshot, themeMode = "system" }: SnapshotViewerProps) {
  // Memoize on `snapshot` identity so `view` is stable across unrelated parent
  // re-renders — Inspector's own useMemo(() => deploymentViewToFlow(view), [view])
  // (Inspector.tsx) otherwise sees a new object every render and re-runs the
  // full React Flow layout for no reason. Mirrors the stable-identity view
  // passed at the App.tsx call site.
  const view = useMemo(() => snapshotToDeploymentView(snapshot), [snapshot]);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      {/* Snapshot metadata header */}
      <div style={metaPanelStyle} data-testid="snapshot-meta-panel">
        <div style={sectionTitleStyle}>Snapshot</div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>Taken at</span>
          <span style={metaValueStyle} data-testid="snapshot-taken-at">
            {snapshot.takenAt}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>Chain id</span>
          <span style={metaValueStyle} data-testid="snapshot-chain-id">
            {snapshot.chainId}
          </span>
        </div>
        {snapshot.network !== undefined && (
          <div style={metaRowStyle}>
            <span style={metaLabelStyle}>Network</span>
            <span style={metaValueStyle} data-testid="snapshot-network">
              {snapshot.network}
            </span>
          </div>
        )}
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>Tool version</span>
          <span style={metaValueStyle} data-testid="snapshot-tool-version">
            {snapshot.toolVersion}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>Spec hash</span>
          <span style={metaValueStyle} data-testid="snapshot-spec-hash">
            {snapshot.specHash}
          </span>
        </div>
      </div>

      {/* Contracts list — plain DOM, independent of React Flow canvas layout */}
      <div style={contractsPanelStyle} data-testid="snapshot-contracts-panel">
        <div style={sectionTitleStyle}>Contracts</div>
        {snapshot.contracts.length === 0 ? (
          <p style={{ fontSize: 11, color: "var(--color-text-muted)" }}>No contracts.</p>
        ) : (
          snapshot.contracts.map((contract) => (
            <div
              key={contract.id}
              style={contractCardStyle}
              data-testid={`snapshot-contract-${contract.id}`}
            >
              <div style={{ fontWeight: 500, fontSize: 12, marginBottom: 4 }}>
                {contract.id}{" "}
                <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>
                  ({contract.contractName})
                </span>
              </div>
              {contract.address !== null ? (
                <div
                  style={addressStyle}
                  data-testid={`snapshot-contract-${contract.id}-address`}
                >
                  {contract.address}
                </div>
              ) : (
                <div
                  style={notDeployedStyle}
                  data-testid={`snapshot-contract-${contract.id}-address`}
                >
                  (not deployed)
                </div>
              )}
              {contract.args.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {contract.args.map((arg, idx) => (
                    <div
                      key={idx}
                      style={argRowStyle}
                      data-testid={`snapshot-contract-${contract.id}-arg-${idx}`}
                    >
                      <span style={{ color: "var(--color-text-muted)", minWidth: 18 }}>
                        [{idx}]
                      </span>
                      <span>{renderArgValue(arg)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Reuse the existing read-only graph canvas + config-steps sidebar */}
      <Inspector
        view={view}
        contextLabel={`Saved snapshot (${snapshot.takenAt})`}
        themeMode={themeMode}
      />
    </div>
  );
}

// Wrapped in React.memo: this renders static snapshot data inside the large
// <App> component, so it has no reason to re-render on unrelated App state
// changes as long as its own props (snapshot, themeMode) are unchanged.
export const SnapshotViewer = memo(SnapshotViewerImpl);

export default SnapshotViewer;

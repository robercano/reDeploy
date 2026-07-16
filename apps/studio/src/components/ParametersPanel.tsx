/**
 * ParametersPanel.tsx
 *
 * Deployment-wide PARAMETERS panel (toolbar-opened, mirrors
 * OrderedConfigPanel.tsx's shell + toggle pattern) — issue #137.
 *
 * Lets the author:
 * - declare named parameters (referenced from constructor arg slots of
 *   kind === "param" via ArgSlot.paramName — see ContractNode.tsx's ArgRow),
 * - set each parameter's default value,
 * - declare a small set of "network" names and record a per-network override
 *   value for each parameter,
 * - select which declared network is "active".
 *
 * ## Studio-only per-network overrides
 * Core's `DeploymentSpec.parameters` is a FLAT map of default values — there
 * is no concept of "network" in the spec format itself (see
 * `@redeploy/core/spec`'s `DeploymentSpec.parameters` doc and
 * `StudioParameter`'s doc in spec/types.ts). The network selector here is a
 * studio-authoring convenience: whichever network is selected, its override
 * value (when set for a given parameter) is substituted for that
 * parameter's `defaultValue` in the SINGLE value graph-to-spec.ts's
 * `buildParameters()` emits into `spec.parameters[name]`. Switching the
 * selected network changes what value gets baked into the next
 * export/simulate/deploy — it does not add any per-network structure to the
 * emitted spec.
 *
 * Note: `apps/deploy-server` does not (yet) accept/forward per-network
 * `DeployOptions.deploymentParameters` at real-deploy time — see the studio
 * module's delivery report for that gap (deploy-server is outside this
 * module's boundary).
 */

import { useState } from "react";
import type { StudioParameter } from "../spec/types.js";

interface ParametersPanelProps {
  parameters: StudioParameter[];
  networks: string[];
  selectedNetwork: string | null;
  onAddParameter: () => void;
  onRemoveParameter: (id: string) => void;
  onUpdateParameter: (id: string, update: Partial<Omit<StudioParameter, "id" | "networkOverrides">>) => void;
  onUpdateParameterOverride: (id: string, network: string, value: string) => void;
  onAddNetwork: (name: string) => void;
  onRemoveNetwork: (name: string) => void;
  onSelectNetwork: (name: string | null) => void;
}

// ---------------------------------------------------------------------------
// Styles (mirrors OrderedConfigPanel.tsx)
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 0,
  top: 0,
  bottom: 0,
  width: 320,
  background: "var(--color-bg-panel)",
  borderLeft: "1px solid var(--color-border)",
  padding: 16,
  overflowY: "auto",
  zIndex: 10,
  fontSize: 13,
  color: "var(--color-text)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 8,
  fontSize: 14,
};

const inputStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "3px 6px",
  border: "1px solid var(--color-border-strong)",
  borderRadius: 3,
  width: "100%",
  boxSizing: "border-box",
  marginBottom: 6,
  background: "var(--color-bg-elevated)",
  color: "var(--color-text)",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-secondary)",
  marginBottom: 2,
};

const stepCardStyle: React.CSSProperties = {
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 10,
  marginBottom: 10,
};

const networkRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginBottom: 4,
};

// ---------------------------------------------------------------------------
// Network management (declare/select/remove)
// ---------------------------------------------------------------------------

function NetworkManager({
  networks,
  selectedNetwork,
  onAddNetwork,
  onRemoveNetwork,
  onSelectNetwork,
}: {
  networks: string[];
  selectedNetwork: string | null;
  onAddNetwork: (name: string) => void;
  onRemoveNetwork: (name: string) => void;
  onSelectNetwork: (name: string | null) => void;
}) {
  const [newNetworkName, setNewNetworkName] = useState("");

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={labelStyle}>Active network</div>
      <select
        style={inputStyle}
        value={selectedNetwork ?? ""}
        onChange={(e) => onSelectNetwork(e.target.value === "" ? null : e.target.value)}
        aria-label="parameters-selected-network"
      >
        <option value="">— use default values —</option>
        {networks.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <div style={labelStyle}>Declared networks</div>
      {networks.map((n) => (
        <div key={n} style={networkRowStyle} data-testid={`parameters-network-${n}`}>
          <span style={{ flex: 1 }}>{n}</span>
          <button
            onClick={() => onRemoveNetwork(n)}
            style={{ fontSize: 11, cursor: "pointer", color: "var(--color-danger-simple)", background: "none", border: "none" }}
            title="Remove network"
            data-testid={`parameters-network-remove-${n}`}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 4 }}>
        <input
          style={{ ...inputStyle, marginBottom: 0 }}
          value={newNetworkName}
          placeholder="e.g. mainnet"
          onChange={(e) => setNewNetworkName(e.target.value)}
          aria-label="parameters-new-network-name"
        />
        <button
          style={{ fontSize: 12, cursor: "pointer", padding: "3px 10px", borderRadius: 3, border: "1px solid var(--color-border-strong)", background: "var(--color-bg-elevated)", color: "var(--color-text)" }}
          onClick={() => {
            if (newNetworkName.trim() === "") return;
            onAddNetwork(newNetworkName);
            setNewNetworkName("");
          }}
          data-testid="parameters-add-network-btn"
        >
          + Network
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ParameterCard
// ---------------------------------------------------------------------------

function ParameterCard({
  param,
  networks,
  onUpdate,
  onUpdateOverride,
  onRemove,
}: {
  param: StudioParameter;
  networks: string[];
  onUpdate: (update: Partial<Omit<StudioParameter, "id" | "networkOverrides">>) => void;
  onUpdateOverride: (network: string, value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div style={stepCardStyle} data-testid={`parameter-card-${param.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 500, fontSize: 12, color: "var(--color-text-secondary)" }}>Parameter</span>
        <button
          onClick={onRemove}
          style={{ fontSize: 11, cursor: "pointer", color: "var(--color-danger-simple)", background: "none", border: "none" }}
          title="Remove parameter"
          data-testid={`parameter-remove-${param.id}`}
        >
          ✕
        </button>
      </div>

      <div style={labelStyle}>Name</div>
      <input
        style={inputStyle}
        value={param.name}
        placeholder="e.g. initialOwner"
        onChange={(e) => onUpdate({ name: e.target.value })}
        aria-label={`parameter-name-${param.id}`}
      />

      <div style={labelStyle}>Default value</div>
      <input
        style={inputStyle}
        value={param.defaultValue}
        placeholder="value"
        onChange={(e) => onUpdate({ defaultValue: e.target.value })}
        aria-label={`parameter-default-${param.id}`}
      />

      {networks.length > 0 && (
        <>
          <div style={labelStyle}>Per-network overrides</div>
          {networks.map((n) => (
            <div key={n} style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>{n}</span>
              <input
                style={{ ...inputStyle, marginBottom: 0 }}
                value={Object.hasOwn(param.networkOverrides, n) ? param.networkOverrides[n] : ""}
                placeholder={`override for ${n} (blank = use default)`}
                onChange={(e) => onUpdateOverride(n, e.target.value)}
                aria-label={`parameter-override-${param.id}-${n}`}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * ParametersPanel — deployment-wide parameters authoring panel.
 * Opened from the toolbar (like Templates/Export/Ordered Config).
 */
export function ParametersPanel({
  parameters,
  networks,
  selectedNetwork,
  onAddParameter,
  onRemoveParameter,
  onUpdateParameter,
  onUpdateParameterOverride,
  onAddNetwork,
  onRemoveNetwork,
  onSelectNetwork,
}: ParametersPanelProps) {
  return (
    <div style={panelStyle} data-testid="parameters-panel">
      <div style={sectionTitleStyle}>Parameters</div>
      <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 12 }}>
        Declare named parameters referenced by constructor args of kind
        "param". Default values are emitted into the deployment spec; the
        active network's override (if set) is used instead.
      </p>

      <NetworkManager
        networks={networks}
        selectedNetwork={selectedNetwork}
        onAddNetwork={onAddNetwork}
        onRemoveNetwork={onRemoveNetwork}
        onSelectNetwork={onSelectNetwork}
      />

      {parameters.map((p) => (
        <ParameterCard
          key={p.id}
          param={p}
          networks={networks}
          onUpdate={(u) => onUpdateParameter(p.id, u)}
          onUpdateOverride={(network, value) => onUpdateParameterOverride(p.id, network, value)}
          onRemove={() => onRemoveParameter(p.id)}
        />
      ))}

      <button
        style={{ width: "100%", padding: "6px 12px", cursor: "pointer", fontSize: 12, borderRadius: 4, border: "1px solid var(--color-border-strong)", background: "var(--color-bg-elevated)", color: "var(--color-text)" }}
        onClick={onAddParameter}
        data-testid="parameters-add-btn"
      >
        + Add parameter
      </button>
    </div>
  );
}

/**
 * Parameters panel toggle button (appears in toolbar).
 * Manages its own open/close state — mirrors OrderedConfigPanelToggle.
 */
export function ParametersPanelToggle({
  parameters,
  networks,
  selectedNetwork,
  onAddParameter,
  onRemoveParameter,
  onUpdateParameter,
  onUpdateParameterOverride,
  onAddNetwork,
  onRemoveNetwork,
  onSelectNetwork,
  btnStyle,
  activeBtnStyle,
}: ParametersPanelProps & {
  btnStyle: React.CSSProperties;
  activeBtnStyle: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        style={open ? activeBtnStyle : btnStyle}
        onClick={() => setOpen((v) => !v)}
        data-testid="toggle-parameters"
      >
        Parameters {parameters.length > 0 ? `(${parameters.length})` : ""}
      </button>
      {open && (
        <ParametersPanel
          parameters={parameters}
          networks={networks}
          selectedNetwork={selectedNetwork}
          onAddParameter={onAddParameter}
          onRemoveParameter={onRemoveParameter}
          onUpdateParameter={onUpdateParameter}
          onUpdateParameterOverride={onUpdateParameterOverride}
          onAddNetwork={onAddNetwork}
          onRemoveNetwork={onRemoveNetwork}
          onSelectNetwork={onSelectNetwork}
        />
      )}
    </>
  );
}

export default ParametersPanel;

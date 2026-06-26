/**
 * ConfigPanel.tsx
 *
 * Side panel for editing config steps (setX, grantRole) attached to the
 * currently selected contract node. Wire steps are created via edges on the
 * canvas and are not edited here.
 */

import type { ContractNodeData, StudioConfigStep, StudioSetXStep, StudioGrantRoleStep } from "../spec/types";

interface ConfigPanelProps {
  nodeId: string;
  data: ContractNodeData;
  onAddStep: (nodeId: string, kind: "setX" | "grantRole") => void;
  onRemoveStep: (nodeId: string, stepId: string) => void;
  onUpdateSetXStep: (nodeId: string, stepId: string, update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onUpdateGrantRoleStep: (nodeId: string, stepId: string, update: Partial<Omit<StudioGrantRoleStep, "kind" | "id">>) => void;
}

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

const inputStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "3px 6px",
  border: "1px solid #ccc",
  borderRadius: 3,
  width: "100%",
  boxSizing: "border-box",
  marginBottom: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#555",
  marginBottom: 2,
};

const stepCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #dee2e6",
  borderRadius: 6,
  padding: 10,
  marginBottom: 10,
};

function SetXStepCard({
  step,
  nodeId,
  onUpdate,
  onRemove,
}: {
  step: StudioSetXStep;
  nodeId: string;
  onUpdate: (update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onRemove: () => void;
}) {
  return (
    <div style={stepCardStyle} data-testid={`step-${step.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: 500, fontSize: 12 }}>setX ({step.id})</span>
        <button onClick={onRemove} style={{ fontSize: 11, cursor: "pointer", color: "#dc3545", background: "none", border: "none" }} title="Remove step">✕</button>
      </div>
      <div style={labelStyle}>Function name</div>
      <input
        style={inputStyle}
        value={step.functionName}
        placeholder="e.g. setFee"
        onChange={(e) => onUpdate({ functionName: e.target.value })}
        aria-label={`setx-function-${nodeId}-${step.id}`}
      />
      <div style={labelStyle}>Args (comma-separated)</div>
      <input
        style={inputStyle}
        value={step.args.join(",")}
        placeholder='e.g. 100,true,"hello"'
        onChange={(e) =>
          onUpdate({ args: e.target.value === "" ? [] : e.target.value.split(",").map((s) => s.trim()) })
        }
        aria-label={`setx-args-${nodeId}-${step.id}`}
      />
    </div>
  );
}

function GrantRoleStepCard({
  step,
  nodeId,
  onUpdate,
  onRemove,
}: {
  step: StudioGrantRoleStep;
  nodeId: string;
  onUpdate: (update: Partial<Omit<StudioGrantRoleStep, "kind" | "id">>) => void;
  onRemove: () => void;
}) {
  return (
    <div style={stepCardStyle} data-testid={`step-${step.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: 500, fontSize: 12 }}>grantRole ({step.id})</span>
        <button onClick={onRemove} style={{ fontSize: 11, cursor: "pointer", color: "#dc3545", background: "none", border: "none" }} title="Remove step">✕</button>
      </div>
      <div style={labelStyle}>Role</div>
      <input
        style={inputStyle}
        value={step.role}
        placeholder="e.g. MINTER_ROLE"
        onChange={(e) => onUpdate({ role: e.target.value })}
        aria-label={`grantrole-role-${nodeId}-${step.id}`}
      />
      <div style={labelStyle}>Account kind</div>
      <select
        style={{ ...inputStyle }}
        value={step.accountKind}
        onChange={(e) => onUpdate({ accountKind: e.target.value as "literal" | "ref" })}
        aria-label={`grantrole-acct-kind-${nodeId}-${step.id}`}
      >
        <option value="literal">literal</option>
        <option value="ref">ref (contract id)</option>
      </select>
      <div style={labelStyle}>{step.accountKind === "ref" ? "Contract ID" : "Address"}</div>
      <input
        style={inputStyle}
        value={step.accountValue}
        placeholder={step.accountKind === "ref" ? "deployId" : "0x..."}
        onChange={(e) => onUpdate({ accountValue: e.target.value })}
        aria-label={`grantrole-acct-val-${nodeId}-${step.id}`}
      />
    </div>
  );
}

export function ConfigPanel({
  nodeId,
  data,
  onAddStep,
  onRemoveStep,
  onUpdateSetXStep,
  onUpdateGrantRoleStep,
}: ConfigPanelProps) {
  return (
    <div style={panelStyle} data-testid="config-panel">
      <div style={sectionTitleStyle}>Config Steps — {data.deployId || "(no id)"}</div>
      <p style={{ fontSize: 11, color: "#888", marginBottom: 12 }}>
        Wire steps are added by drawing edges on the canvas.
      </p>

      {data.configSteps.map((step: StudioConfigStep) => {
        if (step.kind === "setX") {
          return (
            <SetXStepCard
              key={step.id}
              step={step}
              nodeId={nodeId}
              onUpdate={(u) => onUpdateSetXStep(nodeId, step.id, u)}
              onRemove={() => onRemoveStep(nodeId, step.id)}
            />
          );
        }
        return (
          <GrantRoleStepCard
            key={step.id}
            step={step}
            nodeId={nodeId}
            onUpdate={(u) => onUpdateGrantRoleStep(nodeId, step.id, u)}
            onRemove={() => onRemoveStep(nodeId, step.id)}
          />
        );
      })}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={{ flex: 1, padding: "4px 8px", cursor: "pointer", fontSize: 12 }}
          onClick={() => onAddStep(nodeId, "setX")}
        >
          + setX
        </button>
        <button
          style={{ flex: 1, padding: "4px 8px", cursor: "pointer", fontSize: 12 }}
          onClick={() => onAddStep(nodeId, "grantRole")}
        >
          + grantRole
        </button>
      </div>
    </div>
  );
}

export default ConfigPanel;

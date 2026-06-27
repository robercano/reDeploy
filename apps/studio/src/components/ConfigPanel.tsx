/**
 * ConfigPanel.tsx
 *
 * Side panel for editing config steps (setX, grantRole) attached to the
 * currently selected contract node. Wire steps are created via edges on the
 * canvas and are not edited here.
 */

import { getContract } from "../manifest/index.js";
import type { ManifestFunction } from "../manifest/types.js";
import type { ContractNodeData, StudioConfigStep, StudioSetXStep, StudioGrantRoleStep } from "../spec/types";

/** A deploy-id / contractName pair used to populate the target picker. */
export interface DeployTarget {
  deployId: string;
  contractName: string;
}

interface ConfigPanelProps {
  nodeId: string;
  data: ContractNodeData;
  /** All deploy targets currently in the graph (for the setX target picker). */
  deployTargets: DeployTarget[];
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

/**
 * Groups the writable (nonpayable/payable) manifest functions by declaredIn.
 * Returns an array of { group, fns } in the order they first appear.
 */
function groupWriteFunctions(fns: ManifestFunction[]): { group: string; fns: ManifestFunction[] }[] {
  const writeFns = fns.filter(
    (f) => f.stateMutability === "nonpayable" || f.stateMutability === "payable",
  );
  const order: string[] = [];
  const byGroup = new Map<string, ManifestFunction[]>();
  for (const fn of writeFns) {
    if (!byGroup.has(fn.declaredIn)) {
      order.push(fn.declaredIn);
      byGroup.set(fn.declaredIn, []);
    }
    byGroup.get(fn.declaredIn)!.push(fn);
  }
  return order.map((g) => ({ group: g, fns: byGroup.get(g)! }));
}

function SetXStepCard({
  step,
  nodeId,
  deployTargets,
  ownDeployId,
  onUpdate,
  onRemove,
}: {
  step: StudioSetXStep;
  nodeId: string;
  deployTargets: DeployTarget[];
  /** deployId of the node this step is attached to (used as fallback target when step.target is undefined). */
  ownDeployId: string;
  onUpdate: (update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onRemove: () => void;
}) {
  // Resolve the target deploy-id: use the explicit step.target override, or the
  // attached node's own deployId as the default. This matches graph-to-spec.ts
  // which serializes `step.target ?? targetId` where targetId is the node's own
  // deployId — NOT a contractName lookup, which would fail for multiple nodes
  // sharing the same contractName (e.g. two Token deploys token1/token2).
  const targetDeployId = step.target ?? ownDeployId;
  // Resolve contractName for the selected target (look up by deployId).
  const targetContractName = deployTargets.find((dt) => dt.deployId === targetDeployId)?.contractName ?? "";
  const manifest = getContract(targetContractName);
  const groups = manifest ? groupWriteFunctions(manifest.functions) : [];
  const hasManifest = manifest !== undefined && groups.length > 0;

  // Derive selected function's inputs for display-only arg labels.
  const selectedFn: ManifestFunction | undefined = hasManifest
    ? groups.flatMap((g) => g.fns).find((f) => f.name === step.functionName)
    : undefined;

  return (
    <div style={stepCardStyle} data-testid={`step-${step.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: 500, fontSize: 12 }}>setX ({step.id})</span>
        <button onClick={onRemove} style={{ fontSize: 11, cursor: "pointer", color: "#dc3545", background: "none", border: "none" }} title="Remove step">✕</button>
      </div>

      {/* Target contract picker */}
      {deployTargets.length > 0 && (
        <>
          <div style={labelStyle}>Target contract</div>
          <select
            style={{ ...inputStyle }}
            value={targetDeployId}
            onChange={(e) => {
              const newTarget = e.target.value;
              // Clear functionName when target changes so stale selections don't persist.
              onUpdate({ target: newTarget || undefined, functionName: "", args: [] });
            }}
            aria-label={`setx-target-${nodeId}-${step.id}`}
          >
            <option value="">— select target —</option>
            {deployTargets.map((dt) => (
              <option key={dt.deployId} value={dt.deployId}>
                {dt.deployId} ({dt.contractName})
              </option>
            ))}
          </select>
        </>
      )}

      {/* Function picker (manifest-driven) or free-text fallback.
          NOTE: The spec's SetXStep uses a single `function: string` field, so
          overloaded Solidity functions (same name, different signatures) cannot
          be distinguished at the spec level. Current fixtures have no overloads,
          so keying options by fn.name is safe for now. */}
      <div style={labelStyle}>Function name</div>
      {hasManifest ? (
        <select
          style={{ ...inputStyle }}
          value={step.functionName}
          onChange={(e) => onUpdate({ functionName: e.target.value, args: [] })}
          aria-label={`setx-function-select-${nodeId}-${step.id}`}
        >
          <option value="">— select function —</option>
          {groups.map(({ group, fns }) => (
            <optgroup key={group} label={group}>
              {fns.map((fn) => (
                <option key={fn.name} value={fn.name}>
                  {fn.name}({fn.inputs.map((i) => i.type).join(", ")})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : (
        <input
          style={inputStyle}
          value={step.functionName}
          placeholder="e.g. setFee"
          onChange={(e) => onUpdate({ functionName: e.target.value })}
          aria-label={`setx-function-${nodeId}-${step.id}`}
        />
      )}

      {/* Args: per-input with labels when a manifest function is selected */}
      {selectedFn && selectedFn.inputs.length > 0 ? (
        <>
          {selectedFn.inputs.map((input, idx) => (
            <div key={idx}>
              <div style={labelStyle}>
                {input.name} <span style={{ color: "#888", fontStyle: "italic" }}>({input.type})</span>
              </div>
              <input
                style={inputStyle}
                value={step.args[idx] ?? ""}
                placeholder={input.type}
                onChange={(e) => {
                  const newArgs = [...step.args];
                  newArgs[idx] = e.target.value;
                  onUpdate({ args: newArgs });
                }}
                aria-label={`setx-arg-${nodeId}-${step.id}-${idx}`}
              />
            </div>
          ))}
        </>
      ) : (
        <>
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
        </>
      )}
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
  deployTargets,
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
              deployTargets={deployTargets}
              ownDeployId={data.deployId}
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

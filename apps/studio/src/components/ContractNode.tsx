/**
 * ContractNode.tsx
 *
 * Custom React Flow node for a deployable contract.
 * Shows: deployment id, contract name (read-only), constructor arg slots,
 *        and a collapsible "Config calls" section for per-node config steps.
 * Handles: output handle (for outgoing edges), arg input handles.
 *
 * NOTE: The `${id}-input` handle is RETAINED as a passive overview-edge anchor.
 * It is no longer a wire-edge target — wire edges have been removed. Cross-contract
 * wiring is now expressed as a config call step whose arg is a `{DeployID}.address`
 * reference. Any connection drawn to the input handle is silently dropped by
 * onConnect (which only accepts arg-handle connections).
 *
 * Callbacks are passed via the `data` prop (NodeCallbacks interface)
 * because React Flow custom nodes only receive their `data` prop — not
 * arbitrary extra props.
 *
 * ## Type note
 * React Flow requires custom node props to be typed as
 * `NodeProps<Node<YourDataType>>`. We use `NodeProps` directly and cast `data`
 * to `ContractNodeData` since our data type does not have a string index
 * signature (required by `Record<string, unknown>`).
 *
 * ## Read-only fields
 * - Contract Name: authoritative from the manifest; rendered as static text.
 * - Constructor arg slots bound by a constructorRef edge: rendered as
 *   "{sourceDeployId}.address" (read-only). The source deploy ID is supplied
 *   via data.refSourceDeployIds (populated by App.tsx from live edge state).
 *   When the edge is removed, the slot reverts to an editable literal input.
 */

import { memo, useCallback, useState } from "react";
import { Handle, Position, useReactFlow } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ContractNodeData, ArgSlot, StudioConfigStep, StudioAddressRef, StudioSetXStep, StudioGrantRoleStep } from "../spec/types.js";
import { getContract } from "../manifest/index.js";
import type { ManifestFunction } from "../manifest/types.js";

const inputStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 4px",
  border: "1px solid #ccc",
  borderRadius: 3,
  width: "100%",
  boxSizing: "border-box",
};

const readonlyValueStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 4px",
  border: "1px solid #ccc",
  borderRadius: 3,
  width: "100%",
  boxSizing: "border-box",
  background: "#f5f5f5",
  color: "#444",
  fontStyle: "italic",
  userSelect: "none",
} as React.CSSProperties;

const staticLabelValueStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 4px",
  color: "#333",
  fontWeight: 500,
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#666",
  marginBottom: 2,
};

// Delete-node affordance (issue #80): a small circular "✕" pinned to the
// node's top-right corner. Always visible (not hover-only) so it's
// discoverable without relying on the user knowing about the Delete/Backspace
// keyboard shortcut (also wired via React Flow's deleteKeyCode).
const deleteButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: -10,
  right: -10,
  width: 20,
  height: 20,
  borderRadius: "50%",
  border: "1px solid #a50e0e",
  background: "#d93025",
  color: "#fff",
  fontSize: 11,
  lineHeight: "18px",
  textAlign: "center",
  cursor: "pointer",
  padding: 0,
  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
};

const argRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginBottom: 4,
  position: "relative",
};

const paramTypeStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#999",
  fontStyle: "italic",
};

function ArgRow({
  slot,
  nodeId,
  onUpdate,
  refSourceDeployId,
  isOverview,
}: {
  slot: ArgSlot;
  nodeId: string;
  onUpdate: (index: number, value: string) => void;
  /** When defined, the slot is bound by a constructorRef edge to this deploy ID. */
  refSourceDeployId?: string;
  /** When true, the visible arg content is hidden (overview mode). */
  isOverview?: boolean;
}) {
  const handleId = `${nodeId}-arg-${slot.index}`;
  const hasParamInfo = slot.name !== undefined || slot.type !== undefined;
  const isBoundByEdge = refSourceDeployId !== undefined;

  return (
    <div style={argRowStyle}>
      {/*
        The Handle MUST always be mounted (even in overview mode) so that
        constructor-ref edges remain anchored and don't crash React Flow.
        In overview mode the dot is made invisible via opacity:0 so it doesn't
        clutter the compact view, while still occupying its layout box so React
        Flow continues to anchor edge lines to the correct position.
        DO NOT use display:none — that removes the layout box and drops the anchor.
      */}
      <Handle
        type="target"
        position={Position.Left}
        id={handleId}
        style={{ top: "50%", left: -8, background: "#555", ...(isOverview ? { opacity: 0 } : {}) }}
      />
      {/* Collapse visible content in overview mode; keep Handle above for edges. */}
      <div style={isOverview ? { height: 0, overflow: "hidden" } : { flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontSize: 10, color: "#999", minWidth: 12 }}>
          [{slot.index}]
        </span>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
          {hasParamInfo && (
            <div style={{ display: "flex", gap: 4, alignItems: "baseline" }}>
              {slot.name !== undefined && (
                <span style={{ ...labelStyle, marginBottom: 0 }}>{slot.name}</span>
              )}
              {slot.type !== undefined && (
                <span style={paramTypeStyle}>{slot.type}</span>
              )}
            </div>
          )}
          {isBoundByEdge ? (
            <div
              style={readonlyValueStyle}
              title={`Bound by edge to ${refSourceDeployId}`}
              aria-label={`arg-${slot.index}`}
              data-ref-value={`${refSourceDeployId}.address`}
            >
              {refSourceDeployId}.address
            </div>
          ) : (
            <input
              style={inputStyle}
              value={slot.value}
              placeholder="value"
              title={`Constructor arg ${slot.index}${slot.name ? ` — ${slot.name}` : ""}${slot.type ? ` (${slot.type})` : ""}`}
              onChange={(e) => onUpdate(slot.index, e.target.value)}
              aria-label={`arg-${slot.index}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-node Config Calls section
// ---------------------------------------------------------------------------

/** Groups the writable (nonpayable/payable) manifest functions by declaredIn. */
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

/** A deploy-id / contractName pair used for the address-ref arg picker. */
export interface CanvasDeployTarget {
  deployId: string;
  contractName: string;
}

/** Callbacks for per-node config calls section (injected into node data via App.tsx). */
export interface ConfigCallbacks {
  onAddConfigStep: (nodeId: string, kind: "setX" | "grantRole") => void;
  onRemoveConfigStep: (nodeId: string, stepId: string) => void;
  onUpdateSetXStep: (nodeId: string, stepId: string, update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onUpdateGrantRoleStep: (nodeId: string, stepId: string, update: Partial<Omit<StudioGrantRoleStep, "kind" | "id">>) => void;
  /** All deploy targets currently on the canvas (for address-ref arg picker). */
  deployTargets?: CanvasDeployTarget[];
}

const configCardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #e0e0e0",
  borderRadius: 4,
  padding: "6px 8px",
  marginBottom: 6,
  fontSize: 11,
};

const configSectionStyle: React.CSSProperties = {
  marginTop: 6,
  borderTop: "1px solid #eee",
  paddingTop: 6,
};

const configArgRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginBottom: 4,
};

const smallInputStyle: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 4px",
  border: "1px solid #ccc",
  borderRadius: 3,
  width: "100%",
  boxSizing: "border-box",
};

const smallSelectStyle: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 4px",
  border: "1px solid #ccc",
  borderRadius: 3,
  width: "100%",
  boxSizing: "border-box",
};

/**
 * Renders a single config step arg: either a literal input or an address-ref picker.
 */
function ConfigArgInput({
  value,
  index,
  stepId,
  nodeId,
  inputName,
  deployTargets,
  onChange,
}: {
  value: string | StudioAddressRef;
  index: number;
  stepId: string;
  nodeId: string;
  inputName?: string;
  deployTargets: CanvasDeployTarget[];
  onChange: (v: string | StudioAddressRef) => void;
}) {
  const isRef = typeof value === "object" && value.kind === "addressRef";
  const argLabel = `config-arg-${nodeId}-${stepId}-${index}`;

  return (
    <div style={configArgRowStyle}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        {inputName && (
          <span style={{ fontSize: 10, color: "#888" }}>{inputName}</span>
        )}
        <div style={{ display: "flex", gap: 4 }}>
          {/* Kind toggle: literal vs addressRef */}
          <select
            style={{ ...smallSelectStyle, width: "auto", minWidth: 60 }}
            value={isRef ? "ref" : "literal"}
            onChange={(e) => {
              if (e.target.value === "ref") {
                onChange({ kind: "addressRef", deployId: deployTargets[0]?.deployId ?? "" });
              } else {
                onChange(typeof value === "object" ? "" : value);
              }
            }}
            aria-label={`${argLabel}-kind`}
          >
            <option value="literal">literal</option>
            <option value="ref">address ref</option>
          </select>
          {isRef ? (
            <select
              style={smallSelectStyle}
              value={(value as StudioAddressRef).deployId}
              onChange={(e) => onChange({ kind: "addressRef", deployId: e.target.value })}
              aria-label={`${argLabel}-ref`}
            >
              {deployTargets.length === 0 && (
                <option value="">— no contracts on canvas —</option>
              )}
              {deployTargets.map((dt) => (
                <option key={dt.deployId} value={dt.deployId}>
                  {dt.deployId}.address
                </option>
              ))}
            </select>
          ) : (
            <input
              style={smallInputStyle}
              value={typeof value === "string" ? value : ""}
              placeholder="value"
              onChange={(e) => onChange(e.target.value)}
              aria-label={`${argLabel}-literal`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SetXCallCard({
  step,
  nodeId,
  contractName,
  deployTargets,
  onUpdate,
  onRemove,
}: {
  step: StudioSetXStep;
  nodeId: string;
  contractName: string;
  deployTargets: CanvasDeployTarget[];
  onUpdate: (update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onRemove: () => void;
}) {
  const manifest = getContract(contractName);
  const groups = manifest ? groupWriteFunctions(manifest.functions) : [];
  const hasManifest = manifest !== undefined && groups.length > 0;
  const allWriteFns = groups.flatMap((g) => g.fns);

  const selectedFn: ManifestFunction | undefined = hasManifest
    ? (step.functionSignature
        ? allWriteFns.find((f) => f.signature === step.functionSignature)
        : allWriteFns.find((f) => f.name === step.functionName))
    : undefined;

  return (
    <div style={configCardStyle} data-testid={`node-config-step-${step.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontWeight: 500, fontSize: 10, color: "#555" }}>setX</span>
        <button
          onClick={onRemove}
          style={{ fontSize: 10, cursor: "pointer", color: "#dc3545", background: "none", border: "none", padding: 0 }}
          title="Remove config call"
          data-testid={`node-config-step-remove-${step.id}`}
        >
          ✕
        </button>
      </div>

      {/* Function picker (manifest-driven or free-text fallback) */}
      {hasManifest ? (
        <select
          style={smallSelectStyle}
          value={step.functionSignature ?? step.functionName}
          onChange={(e) => {
            const sig = e.target.value;
            const chosenFn = allWriteFns.find((f) => f.signature === sig);
            onUpdate({
              functionName: chosenFn ? chosenFn.name : sig,
              functionSignature: chosenFn ? chosenFn.signature : undefined,
              args: [],
            });
          }}
          aria-label={`node-setx-fn-${nodeId}-${step.id}`}
        >
          <option value="">— select function —</option>
          {groups.map(({ group, fns }) => (
            <optgroup key={group} label={group}>
              {fns.map((fn) => {
                const overloadCount = allWriteFns.filter((f) => f.name === fn.name).length;
                const label = overloadCount > 1 ? fn.signature : `${fn.name}(${fn.inputs.map((i) => i.type).join(", ")})`;
                return (
                  <option key={fn.signature} value={fn.signature}>
                    {label}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
      ) : (
        <input
          style={smallInputStyle}
          value={step.functionName}
          placeholder="function name"
          onChange={(e) => onUpdate({ functionName: e.target.value })}
          aria-label={`node-setx-fn-${nodeId}-${step.id}`}
        />
      )}

      {/* Args: per-input with labels when manifest function is selected */}
      {selectedFn && selectedFn.inputs.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          {selectedFn.inputs.map((input, idx) => (
            <ConfigArgInput
              key={idx}
              value={step.args[idx] ?? ""}
              index={idx}
              stepId={step.id}
              nodeId={nodeId}
              inputName={`${input.name} (${input.type})`}
              deployTargets={deployTargets}
              onChange={(v) => {
                const newArgs = [...step.args];
                newArgs[idx] = v;
                onUpdate({ args: newArgs });
              }}
            />
          ))}
        </div>
      ) : (
        !hasManifest && (
          <div style={{ marginTop: 4 }}>
            <ConfigArgInput
              value={step.args[0] ?? ""}
              index={0}
              stepId={step.id}
              nodeId={nodeId}
              deployTargets={deployTargets}
              onChange={(v) => onUpdate({ args: [v] })}
            />
          </div>
        )
      )}
    </div>
  );
}

function GrantRoleCallCard({
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
    <div style={configCardStyle} data-testid={`node-config-step-${step.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontWeight: 500, fontSize: 10, color: "#555" }}>grantRole</span>
        <button
          onClick={onRemove}
          style={{ fontSize: 10, cursor: "pointer", color: "#dc3545", background: "none", border: "none", padding: 0 }}
          title="Remove config call"
          data-testid={`node-config-step-remove-${step.id}`}
        >
          ✕
        </button>
      </div>
      <input
        style={smallInputStyle}
        value={step.role}
        placeholder="role (e.g. MINTER_ROLE)"
        onChange={(e) => onUpdate({ role: e.target.value })}
        aria-label={`node-grantrole-role-${nodeId}-${step.id}`}
      />
      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
        <select
          style={{ ...smallSelectStyle, width: "auto" }}
          value={step.accountKind}
          onChange={(e) => onUpdate({ accountKind: e.target.value as "literal" | "ref" })}
          aria-label={`node-grantrole-kind-${nodeId}-${step.id}`}
        >
          <option value="literal">literal</option>
          <option value="ref">ref</option>
        </select>
        <input
          style={smallInputStyle}
          value={step.accountValue}
          placeholder={step.accountKind === "ref" ? "deployId" : "0x..."}
          onChange={(e) => onUpdate({ accountValue: e.target.value })}
          aria-label={`node-grantrole-acct-${nodeId}-${step.id}`}
        />
      </div>
    </div>
  );
}

/**
 * Per-node collapsible "Config calls" section rendered inside the ContractNode.
 */
function NodeConfigSection({
  nodeId,
  contractName,
  configSteps,
  configCallbacks,
  deployTargets,
}: {
  nodeId: string;
  contractName: string;
  configSteps: StudioConfigStep[];
  configCallbacks: ConfigCallbacks;
  deployTargets: CanvasDeployTarget[];
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={configSectionStyle} data-testid={`node-config-section-${nodeId}`}>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, cursor: "pointer" }}
        onClick={() => setCollapsed((v) => !v)}
        data-testid={`node-config-section-toggle-${nodeId}`}
      >
        <span style={{ fontSize: 10, fontWeight: 600, color: "#555" }}>
          Config calls {configSteps.length > 0 ? `(${configSteps.length})` : ""}
        </span>
        <span style={{ fontSize: 10, color: "#888" }}>{collapsed ? "▸" : "▾"}</span>
      </div>
      {!collapsed && (
        <div>
          {configSteps.map((step: StudioConfigStep) => {
            if (step.kind === "setX") {
              return (
                <SetXCallCard
                  key={step.id}
                  step={step}
                  nodeId={nodeId}
                  contractName={contractName}
                  deployTargets={deployTargets}
                  onUpdate={(u) => configCallbacks.onUpdateSetXStep(nodeId, step.id, u)}
                  onRemove={() => configCallbacks.onRemoveConfigStep(nodeId, step.id)}
                />
              );
            }
            return (
              <GrantRoleCallCard
                key={step.id}
                step={step}
                nodeId={nodeId}
                onUpdate={(u) => configCallbacks.onUpdateGrantRoleStep(nodeId, step.id, u)}
                onRemove={() => configCallbacks.onRemoveConfigStep(nodeId, step.id)}
              />
            );
          })}
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <button
              style={{ flex: 1, padding: "2px 4px", cursor: "pointer", fontSize: 10, borderRadius: 3, border: "1px solid #ccc" }}
              onClick={() => configCallbacks.onAddConfigStep(nodeId, "setX")}
              data-testid={`node-add-setx-${nodeId}`}
            >
              + setX
            </button>
            <button
              style={{ flex: 1, padding: "2px 4px", cursor: "pointer", fontSize: 10, borderRadius: 3, border: "1px solid #ccc" }}
              onClick={() => configCallbacks.onAddConfigStep(nodeId, "grantRole")}
              data-testid={`node-add-grantrole-${nodeId}`}
            >
              + grantRole
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContractNode main component
// ---------------------------------------------------------------------------

/**
 * ContractNode component.
 * Typed as `NodeProps` (the base unparameterised form) so that React Flow's
 * internal NodeTypes registry is satisfied, and data is cast internally.
 */
function ContractNodeInner({ id, data: rawData, selected }: NodeProps) {
  // Cast data to our precise type — React Flow stores it as Record<string, unknown>
  const data = rawData as unknown as ContractNodeData;
  const isOverview = data.viewMode === "overview";

  // deleteElements removes this node AND any edges connected to it in one
  // call (React Flow computes connectedEdges internally), and routes both
  // through the controlled onNodesChange/onEdgesChange props — the same path
  // Delete/Backspace uses via deleteKeyCode. useGraph's onNodesChange then
  // prunes any dangling config-step / ordered-step / "after" references to
  // the deleted contract (issue #80).
  const { deleteElements } = useReactFlow();
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void deleteElements({ nodes: [{ id }] });
    },
    [deleteElements, id],
  );

  const containerStyle: React.CSSProperties = {
    position: "relative",
    background: "#fff",
    border: `2px solid ${selected ? "#1a73e8" : "#999"}`,
    borderRadius: 6,
    padding: "8px 12px",
    minWidth: 200,
    boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
    fontSize: 12,
  };

  // Resolve configCallbacks and deployTargets if present in data (injected by App.tsx)
  const configCallbacks = (rawData as unknown as Record<string, unknown>).configCallbacks as ConfigCallbacks | undefined;
  const deployTargets = configCallbacks?.deployTargets ?? [];

  return (
    <div style={containerStyle} data-testid={`contract-node-${id}`}>
      <button
        type="button"
        style={deleteButtonStyle}
        onClick={handleDelete}
        title="Delete node"
        aria-label={`delete-node-${id}`}
        data-testid={`delete-node-${id}`}
      >
        ✕
      </button>
      {/*
        Overview-anchor input handle: used ONLY as an anchor point for
        overview-mode edge display. Wire edges no longer exist; this handle
        does not accept meaningful connections (any connection to it is
        silently dropped by onConnect which only processes arg-handle
        connections). In overview mode it is hidden via opacity:0.
      */}
      <Handle
        type="target"
        position={Position.Left}
        id={`${id}-input`}
        style={{ top: "50%", left: -8, background: "#555", ...(isOverview ? { opacity: 0 } : { opacity: 0 }) }}
      />

      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Deploy ID</div>
        <input
          style={inputStyle}
          value={data.deployId}
          placeholder="e.g. token"
          onChange={(e) => data.onUpdateDeployId(id, e.target.value)}
          aria-label="deploy-id"
        />
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Contract Name</div>
        <div
          style={staticLabelValueStyle}
          aria-label="contract-name"
          data-testid="contract-name-label"
        >
          {data.contractName}
        </div>
      </div>

      {data.args.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {/* In overview mode, the section label is also hidden to keep the
              node compact, but each ArgRow's Handle remains mounted. */}
          {!isOverview && <div style={labelStyle}>Constructor Args</div>}
          {data.args.map((slot) => (
            <ArgRow
              key={slot.index}
              slot={slot}
              nodeId={id}
              onUpdate={(idx, val) => data.onUpdateArgSlot(id, idx, val)}
              refSourceDeployId={data.refSourceDeployIds?.get(slot.index)}
              isOverview={isOverview}
            />
          ))}
        </div>
      )}

      {/* Per-node config calls section (hidden in overview mode) */}
      {!isOverview && configCallbacks && (
        <NodeConfigSection
          nodeId={id}
          contractName={data.contractName}
          configSteps={data.configSteps}
          configCallbacks={configCallbacks}
          deployTargets={deployTargets}
        />
      )}

      {/*
        Source output handle: hidden in overview via opacity:0 (layout box
        preserved so constructor-ref edges remain anchored).
      */}
      <Handle
        type="source"
        position={Position.Right}
        id={`${id}-output`}
        style={{ top: "50%", right: -8, background: "#e8711a", ...(isOverview ? { opacity: 0 } : {}) }}
      />
    </div>
  );
}

export const ContractNode = memo(ContractNodeInner);
export default ContractNode;

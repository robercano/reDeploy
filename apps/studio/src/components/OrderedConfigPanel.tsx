/**
 * OrderedConfigPanel.tsx
 *
 * Deployment-wide ORDERED config panel (toolbar-opened, like Templates/Export).
 * Lists globally ordered config steps that are reorderable (up/down) and map
 * to ConfigSpec.orderedSteps (strict array-index execution order).
 *
 * Each step targets any contract on the canvas + a method + args (same
 * manifest function picker and address-ref arg as the per-node section in
 * ContractNode.tsx).
 *
 * These steps are serialized to ConfigSpec.orderedSteps in graphToSpec.ts:
 * per the design, orderedSteps run AFTER all unordered per-node steps, in
 * strict array index order.
 */

import { useState } from "react";
import type { StudioOrderedConfigStep, StudioSetXStep, StudioConfigArg, StudioAddressRef, StudioReadRef } from "../spec/types.js";
import { getContract, getViewFunctions } from "../manifest/index.js";
import type { ManifestFunction } from "../manifest/types.js";

/** A deploy-id / contractName pair for the target picker. */
export interface OrderedPanelDeployTarget {
  deployId: string;
  contractName: string;
}

interface OrderedConfigPanelProps {
  orderedSteps: StudioOrderedConfigStep[];
  /** All deploy targets currently in the graph. */
  deployTargets: OrderedPanelDeployTarget[];
  onAddStep: () => void;
  onRemoveStep: (stepId: string) => void;
  onUpdateStep: (stepId: string, update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onMoveUp: (stepId: string) => void;
  onMoveDown: (stepId: string) => void;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  position: "fixed",
  right: 0,
  top: 0,
  bottom: 0,
  width: 300,
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

const argRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 6,
  flexDirection: "column",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ConfigArgInput for ordered panel
// ---------------------------------------------------------------------------

function OrderedArgInput({
  value,
  index,
  stepId,
  inputName,
  deployTargets,
  onChange,
}: {
  value: StudioConfigArg;
  index: number;
  stepId: string;
  inputName?: string;
  deployTargets: OrderedPanelDeployTarget[];
  onChange: (v: StudioConfigArg) => void;
}) {
  const isRef = typeof value === "object" && (value as StudioAddressRef).kind === "addressRef";
  const isRead = typeof value === "object" && (value as StudioReadRef).kind === "read";
  const argLabel = `ordered-arg-${stepId}-${index}`;

  const readContractName = isRead
    ? (deployTargets.find((dt) => dt.deployId === (value as StudioReadRef).contract)?.contractName ?? "")
    : "";
  const readViewFns = isRead ? getViewFunctions(readContractName) : [];

  return (
    <div style={argRowStyle}>
      {inputName && (
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{inputName}</span>
      )}
      <div style={{ display: "flex", gap: 4 }}>
        <select
          style={{ ...inputStyle, width: "auto", marginBottom: 0, minWidth: 70 }}
          value={isRead ? "read" : isRef ? "ref" : "literal"}
          onChange={(e) => {
            if (e.target.value === "ref") {
              onChange({ kind: "addressRef", deployId: deployTargets[0]?.deployId ?? "" });
            } else if (e.target.value === "read") {
              const firstTarget = deployTargets[0];
              const firstFn = firstTarget ? getViewFunctions(firstTarget.contractName)[0] : undefined;
              onChange({ kind: "read", contract: firstTarget?.deployId ?? "", function: firstFn?.name ?? "" });
            } else {
              onChange(typeof value === "object" ? "" : value);
            }
          }}
          aria-label={`${argLabel}-kind`}
        >
          <option value="literal">literal</option>
          <option value="ref">address ref</option>
          <option value="read">read</option>
        </select>
        {isRef ? (
          <select
            style={{ ...inputStyle, marginBottom: 0 }}
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
        ) : isRead ? (
          <>
            <select
              style={{ ...inputStyle, marginBottom: 0 }}
              value={(value as StudioReadRef).contract}
              onChange={(e) => {
                const newContract = e.target.value;
                const newContractName = deployTargets.find((dt) => dt.deployId === newContract)?.contractName ?? "";
                const firstFn = getViewFunctions(newContractName)[0];
                onChange({ kind: "read", contract: newContract, function: firstFn?.name ?? "" });
              }}
              aria-label={`${argLabel}-read-contract`}
            >
              {deployTargets.length === 0 && (
                <option value="">— no contracts on canvas —</option>
              )}
              {deployTargets.map((dt) => (
                <option key={dt.deployId} value={dt.deployId}>
                  {dt.deployId}
                </option>
              ))}
            </select>
            <select
              style={{ ...inputStyle, marginBottom: 0 }}
              value={(value as StudioReadRef).function}
              onChange={(e) => onChange({ ...(value as StudioReadRef), function: e.target.value })}
              aria-label={`${argLabel}-read-function`}
            >
              {readViewFns.length === 0 && (
                <option value="">— no view functions —</option>
              )}
              {readViewFns.map((fn) => (
                <option key={fn.signature} value={fn.name}>
                  {fn.name}()
                </option>
              ))}
            </select>
          </>
        ) : (
          <input
            style={{ ...inputStyle, marginBottom: 0 }}
            value={typeof value === "string" ? value : ""}
            placeholder="value"
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${argLabel}-literal`}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderedStepCard
// ---------------------------------------------------------------------------

function OrderedStepCard({
  step,
  index,
  total,
  deployTargets,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: StudioOrderedConfigStep;
  index: number;
  total: number;
  deployTargets: OrderedPanelDeployTarget[];
  onUpdate: (update: Partial<Omit<StudioSetXStep, "kind" | "id">>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  // Resolve target contract name for manifest lookup
  const targetDeployId = step.target ?? "";
  const targetContractName = deployTargets.find((dt) => dt.deployId === targetDeployId)?.contractName ?? "";
  const manifest = getContract(targetContractName);
  const groups = manifest ? groupWriteFunctions(manifest.functions) : [];
  const hasManifest = manifest !== undefined && groups.length > 0;
  const allWriteFns = groups.flatMap((g) => g.fns);

  const selectedFn: ManifestFunction | undefined = hasManifest
    ? (step.functionSignature
        ? allWriteFns.find((f) => f.signature === step.functionSignature)
        : allWriteFns.find((f) => f.name === step.functionName))
    : undefined;

  return (
    <div style={stepCardStyle} data-testid={`ordered-step-${step.id}`}>
      {/* Header: order index, remove, move buttons */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 500, fontSize: 12, color: "var(--color-text-secondary)" }}>
          #{index + 1}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={onMoveUp}
            disabled={index === 0}
            style={{ fontSize: 11, cursor: index === 0 ? "default" : "pointer", color: "var(--color-text-secondary)", background: "none", border: "none", opacity: index === 0 ? 0.3 : 1 }}
            title="Move up"
            data-testid={`ordered-step-up-${step.id}`}
          >
            ▲
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === total - 1}
            style={{ fontSize: 11, cursor: index === total - 1 ? "default" : "pointer", color: "var(--color-text-secondary)", background: "none", border: "none", opacity: index === total - 1 ? 0.3 : 1 }}
            title="Move down"
            data-testid={`ordered-step-down-${step.id}`}
          >
            ▼
          </button>
          <button
            onClick={onRemove}
            style={{ fontSize: 11, cursor: "pointer", color: "var(--color-danger-simple)", background: "none", border: "none" }}
            title="Remove step"
            data-testid={`ordered-step-remove-${step.id}`}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Target contract picker */}
      <div style={labelStyle}>Target contract</div>
      <select
        style={inputStyle}
        value={targetDeployId}
        onChange={(e) => {
          const newTarget = e.target.value;
          onUpdate({ target: newTarget || undefined, functionName: "", functionSignature: undefined, args: [] });
        }}
        aria-label={`ordered-target-${step.id}`}
      >
        <option value="">— select target —</option>
        {deployTargets.map((dt) => (
          <option key={dt.deployId} value={dt.deployId}>
            {dt.deployId} ({dt.contractName})
          </option>
        ))}
      </select>

      {/* Function picker */}
      <div style={labelStyle}>Function</div>
      {hasManifest ? (
        <select
          style={inputStyle}
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
          aria-label={`ordered-fn-${step.id}`}
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
          style={inputStyle}
          value={step.functionName}
          placeholder="e.g. setFee"
          onChange={(e) => onUpdate({ functionName: e.target.value })}
          aria-label={`ordered-fn-${step.id}`}
        />
      )}

      {/* Args */}
      {selectedFn && selectedFn.inputs.length > 0 ? (
        <div>
          {selectedFn.inputs.map((input, idx) => (
            <OrderedArgInput
              key={idx}
              value={step.args[idx] ?? ""}
              index={idx}
              stepId={step.id}
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
        !hasManifest && step.functionName !== "" && (
          <div>
            <div style={labelStyle}>Args (comma-separated)</div>
            <input
              style={inputStyle}
              value={step.args.filter((a) => typeof a === "string").join(",")}
              placeholder='e.g. 100,true,"hello"'
              onChange={(e) =>
                onUpdate({ args: e.target.value === "" ? [] : e.target.value.split(",").map((s) => s.trim()) })
              }
              aria-label={`ordered-args-${step.id}`}
            />
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * OrderedConfigPanel — deployment-wide ordered config steps panel.
 * Opened from toolbar (like Templates/Export). Steps map to ConfigSpec.orderedSteps.
 */
export function OrderedConfigPanel({
  orderedSteps,
  deployTargets,
  onAddStep,
  onRemoveStep,
  onUpdateStep,
  onMoveUp,
  onMoveDown,
}: OrderedConfigPanelProps) {
  return (
    <div style={panelStyle} data-testid="ordered-config-panel">
      <div style={sectionTitleStyle}>Ordered Config Steps</div>
      <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 12 }}>
        These steps run after all per-node config, in strict order. Reorder with ▲/▼.
      </p>

      {orderedSteps.map((step, index) => (
        <OrderedStepCard
          key={step.id}
          step={step}
          index={index}
          total={orderedSteps.length}
          deployTargets={deployTargets}
          onUpdate={(u) => onUpdateStep(step.id, u)}
          onRemove={() => onRemoveStep(step.id)}
          onMoveUp={() => onMoveUp(step.id)}
          onMoveDown={() => onMoveDown(step.id)}
        />
      ))}

      <button
        style={{ width: "100%", padding: "6px 12px", cursor: "pointer", fontSize: 12, borderRadius: 4, border: "1px solid var(--color-border-strong)", background: "var(--color-bg-elevated)", color: "var(--color-text)" }}
        onClick={onAddStep}
        data-testid="ordered-add-step-btn"
      >
        + Add ordered step
      </button>
    </div>
  );
}

/**
 * Ordered config panel toggle button (appears in toolbar).
 * Manages its own open/close state.
 */
export function OrderedConfigPanelToggle({
  orderedSteps,
  deployTargets,
  onAddStep,
  onRemoveStep,
  onUpdateStep,
  onMoveUp,
  onMoveDown,
  btnStyle,
  activeBtnStyle,
}: OrderedConfigPanelProps & {
  btnStyle: React.CSSProperties;
  activeBtnStyle: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        style={open ? activeBtnStyle : btnStyle}
        onClick={() => setOpen((v) => !v)}
        data-testid="toggle-ordered-config"
      >
        Ordered Config {orderedSteps.length > 0 ? `(${orderedSteps.length})` : ""}
      </button>
      {open && (
        <OrderedConfigPanel
          orderedSteps={orderedSteps}
          deployTargets={deployTargets}
          onAddStep={onAddStep}
          onRemoveStep={onRemoveStep}
          onUpdateStep={onUpdateStep}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
        />
      )}
    </>
  );
}

export default OrderedConfigPanel;

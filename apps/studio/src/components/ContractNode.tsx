/**
 * ContractNode.tsx
 *
 * Custom React Flow node for a deployable contract.
 * Shows: deployment id, contract name (read-only), constructor arg slots.
 * Handles: output handle (for outgoing edges), arg input handles, and
 *          a general input handle for wire edges.
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

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { ContractNodeData, ArgSlot } from "../spec/types";

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
        Only the visible content below the Handle is collapsed in overview mode.
      */}
      <Handle
        type="target"
        position={Position.Left}
        id={handleId}
        style={{ top: "50%", left: -8, background: "#555" }}
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

/**
 * ContractNode component.
 * Typed as `NodeProps` (the base unparameterised form) so that React Flow's
 * internal NodeTypes registry is satisfied, and data is cast internally.
 */
function ContractNodeInner({ id, data: rawData, selected }: NodeProps) {
  // Cast data to our precise type — React Flow stores it as Record<string, unknown>
  const data = rawData as unknown as ContractNodeData;
  const isOverview = data.viewMode === "overview";

  const containerStyle: React.CSSProperties = {
    background: "#fff",
    border: `2px solid ${selected ? "#1a73e8" : "#999"}`,
    borderRadius: 6,
    padding: "8px 12px",
    minWidth: 200,
    boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
    fontSize: 12,
  };

  return (
    <div style={containerStyle} data-testid={`contract-node-${id}`}>
      <Handle
        type="target"
        position={Position.Left}
        id={`${id}-input`}
        style={{ top: "50%", left: -8, background: "#1a73e8" }}
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

      <Handle
        type="source"
        position={Position.Right}
        id={`${id}-output`}
        style={{ top: "50%", right: -8, background: "#e8711a" }}
      />
    </div>
  );
}

export const ContractNode = memo(ContractNodeInner);
export default ContractNode;

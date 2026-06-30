/**
 * ContractNode.tsx
 *
 * Custom React Flow node for a deployable contract.
 * Shows: deployment id, contract name, constructor arg slots.
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
}: {
  slot: ArgSlot;
  nodeId: string;
  onUpdate: (index: number, value: string) => void;
}) {
  const handleId = `${nodeId}-arg-${slot.index}`;
  const hasParamInfo = slot.name !== undefined || slot.type !== undefined;
  return (
    <div style={argRowStyle}>
      <Handle
        type="target"
        position={Position.Left}
        id={handleId}
        style={{ top: "50%", left: -8, background: "#555" }}
      />
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
        <input
          style={inputStyle}
          value={slot.value}
          placeholder={slot.kind === "ref" ? "(ref)" : "value"}
          title={`Constructor arg ${slot.index}${slot.kind === "ref" ? " (bound by edge)" : ""}${slot.name ? ` — ${slot.name}` : ""}${slot.type ? ` (${slot.type})` : ""}`}
          onChange={(e) => onUpdate(slot.index, e.target.value)}
          aria-label={`arg-${slot.index}`}
        />
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
        <input
          style={inputStyle}
          value={data.contractName}
          placeholder="e.g. ERC20Token"
          onChange={(e) => data.onUpdateContractName(id, e.target.value)}
          aria-label="contract-name"
        />
      </div>

      {data.args.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={labelStyle}>Constructor Args</div>
          {data.args.map((slot) => (
            <ArgRow
              key={slot.index}
              slot={slot}
              nodeId={id}
              onUpdate={(idx, val) => data.onUpdateArgSlot(id, idx, val)}
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

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

function ArgRow({
  slot,
  nodeId,
  onUpdate,
  onRemove,
}: {
  slot: ArgSlot;
  nodeId: string;
  onUpdate: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const handleId = `${nodeId}-arg-${slot.index}`;
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
      <input
        style={{ ...inputStyle, flex: 1 }}
        value={slot.value}
        placeholder={slot.kind === "ref" ? "(ref)" : "value"}
        title={`Constructor arg ${slot.index}${slot.kind === "ref" ? " (bound by edge)" : ""}`}
        onChange={(e) => onUpdate(slot.index, e.target.value)}
        aria-label={`arg-${slot.index}`}
      />
      <button
        style={{ fontSize: 10, padding: "1px 4px", cursor: "pointer" }}
        onClick={() => onRemove(slot.index)}
        title="Remove arg"
      >
        ×
      </button>
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
              onRemove={(idx) => data.onRemoveArg(id, idx)}
            />
          ))}
        </div>
      )}

      <button
        style={{ fontSize: 10, padding: "2px 6px", cursor: "pointer", width: "100%" }}
        onClick={() => data.onAddArg(id)}
        title="Add constructor arg"
      >
        + arg
      </button>

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

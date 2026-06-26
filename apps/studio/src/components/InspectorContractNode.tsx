/**
 * InspectorContractNode.tsx
 *
 * Read-only custom React Flow node for the deployment inspector canvas.
 * Shows: contract id, contract name, deployed address (or "(not deployed)"),
 * and constructor args.
 *
 * This component is intentionally read-only — no editable inputs, no
 * callbacks, no onUpdate handlers.
 *
 * Constructor args rendering:
 *   - BigIntValue ({ $bigint: "..." }) → rendered as the $bigint string value
 *   - Arrays / objects                → rendered via JSON.stringify
 *   - Primitives (string, number, boolean, null) → rendered as-is
 *
 * ## Type note
 * React Flow requires `NodeProps` where `data` is `Record<string, unknown>`.
 * We cast internally to `InspectorNodeData` (same pattern as ContractNode.tsx).
 */

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { InspectorNodeData } from "../inspector/types.js";
import type { ArgValue, BigIntValue } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// Styles (mirroring ContractNode.tsx approach — inline style objects)
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#666",
  marginBottom: 2,
};

const valueStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#333",
  marginBottom: 6,
  wordBreak: "break-all",
};

const addressStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "monospace",
  color: "#1a73e8",
  marginBottom: 6,
  wordBreak: "break-all",
};

const notDeployedStyle: React.CSSProperties = {
  fontSize: 11,
  fontStyle: "italic",
  color: "#999",
  marginBottom: 6,
};

const argRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 2,
  fontSize: 11,
  color: "#333",
};

// ---------------------------------------------------------------------------
// Arg value rendering helper
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
  if (isBigIntValue(v)) return (v as BigIntValue).$bigint;
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Arrays and objects — use JSON.stringify for a compact representation.
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function InspectorContractNodeInner({ data: rawData }: NodeProps) {
  const data = rawData as unknown as InspectorNodeData;
  const { id, contractName, address, args } = data;

  const containerStyle: React.CSSProperties = {
    background: "#f0f4ff",
    border: "2px solid #5b8dee",
    borderRadius: 6,
    padding: "8px 12px",
    minWidth: 220,
    boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
    fontSize: 12,
  };

  return (
    <div style={containerStyle} data-testid={`inspector-node-${id}`}>
      {/* Target handle on the left (incoming dependency/library edges) */}
      <Handle
        type="target"
        position={Position.Left}
        id={`${id}-input`}
        style={{ top: "50%", left: -8, background: "#5b8dee" }}
      />

      {/* Contract id */}
      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Deploy ID</div>
        <div style={valueStyle}>{id}</div>
      </div>

      {/* Contract name */}
      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Contract</div>
        <div style={valueStyle}>{contractName}</div>
      </div>

      {/* Address */}
      <div>
        <div style={labelStyle}>Address</div>
        {address !== null ? (
          <div
            style={addressStyle}
            data-testid={`inspector-node-${id}-address`}
          >
            {address}
          </div>
        ) : (
          <div
            style={notDeployedStyle}
            data-testid={`inspector-node-${id}-address`}
          >
            (not deployed)
          </div>
        )}
      </div>

      {/* Constructor args */}
      {args.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={labelStyle}>Constructor Args</div>
          {args.map((arg, idx) => (
            <div key={idx} style={argRowStyle}>
              <span style={{ color: "#999", minWidth: 18 }}>[{idx}]</span>
              <span>{renderArgValue(arg)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Source handle on the right (outgoing dependency/library edges) */}
      <Handle
        type="source"
        position={Position.Right}
        id={`${id}-output`}
        style={{ top: "50%", right: -8, background: "#e8711a" }}
      />
    </div>
  );
}

export const InspectorContractNode = memo(InspectorContractNodeInner);
export default InspectorContractNode;

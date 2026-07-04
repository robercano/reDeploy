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
  color: "var(--color-text-secondary)",
  marginBottom: 2,
};

const valueStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text)",
  marginBottom: 6,
  wordBreak: "break-all",
};

const addressStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "monospace",
  color: "var(--color-primary-text)",
  marginBottom: 6,
  wordBreak: "break-all",
};

const notDeployedStyle: React.CSSProperties = {
  fontSize: 11,
  fontStyle: "italic",
  color: "var(--color-text-muted)",
  marginBottom: 6,
};

const argRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 2,
  fontSize: 11,
  color: "var(--color-text)",
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
    background: "var(--color-inspector-node-bg)",
    border: "2px solid var(--color-inspector-node-border)",
    borderRadius: 6,
    padding: "8px 12px",
    minWidth: 220,
    boxShadow: "var(--shadow-lg)",
    fontSize: 12,
  };

  return (
    <div style={containerStyle} data-testid={`inspector-node-${id}`}>
      {/* Target handle on the left (incoming dependency/library edges) */}
      <Handle
        type="target"
        position={Position.Left}
        id={`${id}-input`}
        style={{ top: "50%", left: -8, background: "var(--color-inspector-node-border)" }}
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
              <span style={{ color: "var(--color-text-muted)", minWidth: 18 }}>[{idx}]</span>
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
        style={{ top: "50%", right: -8, background: "var(--color-handle-output)" }}
      />
    </div>
  );
}

export const InspectorContractNode = memo(InspectorContractNodeInner);
export default InspectorContractNode;

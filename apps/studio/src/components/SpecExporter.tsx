/**
 * SpecExporter.tsx
 *
 * Shows the serialized deployment + config spec in a textarea and lets the
 * user download it as JSON. Calls validateSpec / validateConfig and displays
 * any validation errors so the user gets immediate feedback.
 */

import { useState } from "react";
import { validateSpec } from "@redeploy/core/spec";
import { validateConfig } from "@redeploy/config/steps";
import type { DeploymentSpec } from "@redeploy/core/spec";
import type { ConfigSpec } from "@redeploy/config/steps";

interface SpecExporterProps {
  deployment: DeploymentSpec;
  config: ConfigSpec;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--color-overlay)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const modalStyle: React.CSSProperties = {
  background: "var(--color-bg-elevated)",
  color: "var(--color-text)",
  borderRadius: 8,
  padding: 24,
  width: 600,
  maxHeight: "80vh",
  overflowY: "auto",
  boxShadow: "var(--shadow-xl)",
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 14px",
  cursor: "pointer",
  borderRadius: 4,
  border: "1px solid var(--color-border-strong)",
  color: "var(--color-text)",
  fontSize: 13,
};

const errorStyle: React.CSSProperties = {
  background: "var(--color-danger-bg-soft)",
  border: "1px solid var(--color-danger-border-soft)",
  borderRadius: 4,
  padding: 10,
  marginBottom: 10,
  fontSize: 12,
  color: "var(--color-danger-text-soft)",
};

const okStyle: React.CSSProperties = {
  background: "var(--color-success-bg-soft)",
  border: "1px solid var(--color-success-border-soft)",
  borderRadius: 4,
  padding: 10,
  marginBottom: 10,
  fontSize: 12,
  color: "var(--color-success-text-soft)",
};

type SpecTab = "deployment" | "config";

export function SpecExporter({ deployment, config }: SpecExporterProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SpecTab>("deployment");

  if (!open) {
    return (
      <button
        style={{ ...buttonStyle, background: "var(--color-primary)", color: "var(--color-text-on-accent)", border: "none" }}
        onClick={() => setOpen(true)}
        data-testid="export-spec-btn"
      >
        Export Spec
      </button>
    );
  }

  const deployResult = validateSpec(deployment);
  const configResult = validateConfig(config, deployment);

  const deployJson = JSON.stringify(deployment, null, 2);
  const configJson = JSON.stringify(config, null, 2);

  function downloadFile(content: string, filename: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={overlayStyle} data-testid="spec-exporter-modal">
      <div style={modalStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: "var(--color-text)" }}>Export Spec</h3>
          <button style={{ ...buttonStyle, background: "none" }} onClick={() => setOpen(false)}>✕ Close</button>
        </div>

        {/* Validation badges */}
        {deployResult.ok ? (
          <div style={okStyle} data-testid="deploy-valid">Deployment spec: valid</div>
        ) : (
          <div style={errorStyle} data-testid="deploy-invalid">
            Deployment errors: {deployResult.errors.map((e) => e.message).join("; ")}
          </div>
        )}
        {configResult.ok ? (
          <div style={okStyle} data-testid="config-valid">Config spec: valid</div>
        ) : (
          <div style={errorStyle} data-testid="config-invalid">
            Config errors: {configResult.errors.map((e) => e.message).join("; ")}
          </div>
        )}

        {/* Tab selector */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            style={{ ...buttonStyle, background: tab === "deployment" ? "var(--color-primary)" : "var(--color-bg-elevated)", color: tab === "deployment" ? "var(--color-text-on-accent)" : "var(--color-text)" }}
            onClick={() => setTab("deployment")}
          >
            deployment.json
          </button>
          <button
            style={{ ...buttonStyle, background: tab === "config" ? "var(--color-primary)" : "var(--color-bg-elevated)", color: tab === "config" ? "var(--color-text-on-accent)" : "var(--color-text)" }}
            onClick={() => setTab("config")}
          >
            config.json
          </button>
        </div>

        <textarea
          style={{ width: "100%", height: 300, fontFamily: "monospace", fontSize: 12, padding: 8, boxSizing: "border-box", border: "1px solid var(--color-border-strong)", borderRadius: 4, background: "var(--color-bg-elevated)", color: "var(--color-text)" }}
          readOnly
          value={tab === "deployment" ? deployJson : configJson}
          data-testid="spec-textarea"
        />

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button
            style={{ ...buttonStyle, background: "var(--color-success)", color: "var(--color-text-on-accent)", border: "none" }}
            onClick={() => downloadFile(deployJson, "deployment.json")}
          >
            Download deployment.json
          </button>
          <button
            style={{ ...buttonStyle, background: "var(--color-success)", color: "var(--color-text-on-accent)", border: "none" }}
            onClick={() => downloadFile(configJson, "config.json")}
          >
            Download config.json
          </button>
        </div>
      </div>
    </div>
  );
}

export default SpecExporter;

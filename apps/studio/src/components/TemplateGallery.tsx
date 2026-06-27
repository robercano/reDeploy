/**
 * TemplateGallery.tsx
 *
 * A toolbar button ("Templates") that opens a modal listing built-in templates.
 * Choosing a template calls onInstantiate(template) and then surfaces the
 * template's params so the user knows which arg slots to fill.
 *
 * Styling mirrors SpecExporter.tsx (overlayStyle/modalStyle, close button,
 * data-testid conventions).
 *
 * ## Usage
 *
 *   <TemplateGallery onInstantiate={instantiateTemplate} />
 *
 * The actual arg editing happens in the existing ContractNode UI — the gallery
 * only shows a read-only checklist of param labels/hints after instantiation.
 */

import { useState } from "react";
import { BUILTIN_TEMPLATES } from "../templates/builtin.js";
import type { Template, TemplateParam } from "../templates/types.js";

// ---------------------------------------------------------------------------
// Shared styles (mirrors SpecExporter)
// ---------------------------------------------------------------------------

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 8,
  padding: 24,
  width: 560,
  maxHeight: "80vh",
  overflowY: "auto",
  boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 14px",
  cursor: "pointer",
  borderRadius: 4,
  border: "1px solid #ccc",
  fontSize: 13,
};

const templateCardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "12px 14px",
  marginBottom: 10,
  cursor: "pointer",
  transition: "border-color 0.15s",
};

const templateCardHoverStyle: React.CSSProperties = {
  ...templateCardStyle,
  borderColor: "#1a73e8",
  background: "#f0f7ff",
};

const paramListStyle: React.CSSProperties = {
  background: "#f7fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "12px 14px",
  marginTop: 12,
};

const paramItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  marginBottom: 6,
  fontSize: 13,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ParamChecklist({ params }: { params: TemplateParam[] }) {
  if (params.length === 0) return null;
  return (
    <div style={paramListStyle} data-testid="template-params-list">
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "#2d3748" }}>
        Fill in these args after the template is added to the canvas:
      </div>
      {params.map((p, i) => (
        <div key={i} style={paramItemStyle}>
          <span style={{ color: "#718096", marginTop: 1 }}>□</span>
          <span>
            <strong>{p.label}</strong>
            {p.hint && (
              <span style={{ color: "#718096", marginLeft: 6 }}>— {p.hint}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  onChoose,
}: {
  template: Template;
  onChoose: (t: Template) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={hovered ? templateCardHoverStyle : templateCardStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onChoose(template)}
      data-testid={`template-item-${template.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose(template);
        }
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{template.name}</div>
      <div style={{ fontSize: 12, color: "#718096" }}>{template.description}</div>
      <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 6 }}>
        {template.nodes.length} contract{template.nodes.length !== 1 ? "s" : ""},
        {" "}{template.edges.length} edge{template.edges.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TemplateGalleryProps {
  onInstantiate: (template: Template) => void;
}

// ---------------------------------------------------------------------------
// TemplateGallery
// ---------------------------------------------------------------------------

export function TemplateGallery({ onInstantiate }: TemplateGalleryProps) {
  const [open, setOpen] = useState(false);
  const [instantiated, setInstantiated] = useState<Template | null>(null);

  if (!open) {
    return (
      <button
        style={{ ...buttonStyle, background: "#6f42c1", color: "#fff", border: "none" }}
        onClick={() => {
          setInstantiated(null);
          setOpen(true);
        }}
        data-testid="template-gallery-btn"
      >
        Templates
      </button>
    );
  }

  function handleChoose(template: Template) {
    onInstantiate(template);
    setInstantiated(template);
  }

  function handleClose() {
    setOpen(false);
    setInstantiated(null);
  }

  return (
    <div style={overlayStyle} data-testid="template-gallery-modal">
      <div style={modalStyle}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {instantiated ? "Template Added" : "Choose a Template"}
          </h3>
          <button
            style={{ ...buttonStyle, background: "none" }}
            onClick={handleClose}
            data-testid="template-gallery-close"
          >
            ✕ Close
          </button>
        </div>

        {!instantiated ? (
          /* Template list */
          <div>
            <p style={{ fontSize: 12, color: "#718096", margin: "0 0 12px" }}>
              Select a template to add a pre-arranged set of contracts to the canvas.
              Fill in the highlighted arg slots before exporting.
            </p>
            {BUILTIN_TEMPLATES.map((t) => (
              <TemplateCard key={t.id} template={t} onChoose={handleChoose} />
            ))}
            {BUILTIN_TEMPLATES.length === 0 && (
              <p style={{ color: "#a0aec0", fontSize: 13 }}>No templates available.</p>
            )}
          </div>
        ) : (
          /* Post-instantiation: show param checklist */
          <div>
            <div
              style={{
                background: "#f0fff4",
                border: "1px solid #c6f6d5",
                borderRadius: 4,
                padding: 10,
                marginBottom: 12,
                fontSize: 13,
                color: "#276749",
              }}
              data-testid="template-instantiated-banner"
            >
              <strong>{instantiated.name}</strong> has been added to the canvas.
            </div>
            <ParamChecklist params={instantiated.params} />
            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <button
                style={{ ...buttonStyle, background: "#6f42c1", color: "#fff", border: "none" }}
                onClick={() => setInstantiated(null)}
                data-testid="template-gallery-add-another"
              >
                Add Another Template
              </button>
              <button
                style={buttonStyle}
                onClick={handleClose}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default TemplateGallery;

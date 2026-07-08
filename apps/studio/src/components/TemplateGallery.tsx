/**
 * TemplateGallery.tsx
 *
 * A toolbar button ("Templates") that opens a modal listing built-in templates
 * AND user-saved templates. Choosing a template calls onInstantiate(template)
 * and then surfaces the template's params so the user knows which arg slots to
 * fill. User templates have a delete button; built-in templates do not.
 *
 * Styling mirrors SpecExporter.tsx (overlayStyle/modalStyle, close button,
 * data-testid conventions).
 *
 * ## Usage
 *
 *   <TemplateGallery
 *     onInstantiate={instantiateTemplate}
 *     userTemplates={userTemplates}
 *     onDelete={deleteTemplate}
 *   />
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
  // Issue #114: a fixed `width: 560` overflows narrow/mobile viewports
  // (~375-414px portrait) since there is no viewport bound. `min(560px,
  // 90vw)` caps the modal at 90% of the viewport width on narrow screens
  // while still using the full 560px on wide/desktop screens. Mirrors the
  // #110 toolbar fix's viewport-bounded-width approach.
  width: "min(560px, 90vw)",
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

const templateCardStyle: React.CSSProperties = {
  border: "1px solid var(--color-border-subtle)",
  borderRadius: 6,
  padding: "12px 14px",
  marginBottom: 10,
  cursor: "pointer",
  transition: "border-color 0.15s",
};

const templateCardHoverStyle: React.CSSProperties = {
  ...templateCardStyle,
  borderColor: "var(--color-primary-border)",
  background: "var(--color-bg-hover)",
};

const paramListStyle: React.CSSProperties = {
  background: "var(--color-bg-subtle)",
  border: "1px solid var(--color-border-subtle)",
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
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: "var(--color-text)" }}>
        Fill in these args after the template is added to the canvas:
      </div>
      {params.map((p, i) => (
        <div key={i} style={paramItemStyle}>
          <span style={{ color: "var(--color-text-muted)", marginTop: 1 }}>□</span>
          <span>
            <strong>{p.label}</strong>
            {p.hint && (
              <span style={{ color: "var(--color-text-muted)", marginLeft: 6 }}>— {p.hint}</span>
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
  onDelete,
}: {
  template: Template;
  onChoose: (t: Template) => void;
  onDelete?: (id: string) => void;
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{template.name}</div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{template.description}</div>
          <div style={{ fontSize: 11, color: "var(--color-text-faint)", marginTop: 6 }}>
            {template.nodes.length} contract{template.nodes.length !== 1 ? "s" : ""},
            {" "}{template.edges.length} edge{template.edges.length !== 1 ? "s" : ""}
          </div>
        </div>
        {onDelete && (
          <button
            style={{
              marginLeft: 8,
              padding: "2px 8px",
              cursor: "pointer",
              borderRadius: 4,
              border: "1px solid var(--color-danger-border-soft)",
              background: "var(--color-danger-bg-soft)",
              color: "var(--color-danger-text-soft)",
              fontSize: 11,
              flexShrink: 0,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(template.id);
            }}
            data-testid={`template-delete-${template.id}`}
            title="Delete this template"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TemplateGalleryProps {
  onInstantiate: (template: Template) => void;
  /** User-saved templates to show alongside built-ins. */
  userTemplates?: Template[];
  /** Called when a user template's delete button is clicked. */
  onDelete?: (id: string) => void;
}

// ---------------------------------------------------------------------------
// TemplateGallery
// ---------------------------------------------------------------------------

export function TemplateGallery({ onInstantiate, userTemplates = [], onDelete }: TemplateGalleryProps) {
  const [open, setOpen] = useState(false);
  const [instantiated, setInstantiated] = useState<Template | null>(null);

  if (!open) {
    return (
      <button
        style={{ ...buttonStyle, background: "var(--color-purple)", color: "var(--color-text-on-accent)", border: "none" }}
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

  const allTemplatesEmpty = BUILTIN_TEMPLATES.length === 0 && userTemplates.length === 0;

  return (
    <div style={overlayStyle} data-testid="template-gallery-modal">
      <div style={modalStyle}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: "var(--color-text)" }}>
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
            <p style={{ fontSize: 12, color: "var(--color-text-muted)", margin: "0 0 12px" }}>
              Select a template to add a pre-arranged set of contracts to the canvas.
              Fill in the highlighted arg slots before exporting.
            </p>

            {/* Built-in templates */}
            {BUILTIN_TEMPLATES.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-faint)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                  Built-in
                </div>
                {BUILTIN_TEMPLATES.map((t) => (
                  <TemplateCard key={t.id} template={t} onChoose={handleChoose} />
                ))}
              </div>
            )}

            {/* User-saved templates */}
            {userTemplates.length > 0 && (
              <div style={{ marginTop: BUILTIN_TEMPLATES.length > 0 ? 12 : 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-faint)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                  My Templates
                </div>
                {userTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    onChoose={handleChoose}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            )}

            {allTemplatesEmpty && (
              <p style={{ color: "var(--color-text-faint)", fontSize: 13 }}>No templates available.</p>
            )}
          </div>
        ) : (
          /* Post-instantiation: show param checklist */
          <div>
            <div
              style={{
                background: "var(--color-success-bg-soft)",
                border: "1px solid var(--color-success-border-soft)",
                borderRadius: 4,
                padding: 10,
                marginBottom: 12,
                fontSize: 13,
                color: "var(--color-success-text-soft)",
              }}
              data-testid="template-instantiated-banner"
            >
              <strong>{instantiated.name}</strong> has been added to the canvas.
            </div>
            <ParamChecklist params={instantiated.params} />
            <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
              <button
                style={{ ...buttonStyle, background: "var(--color-purple)", color: "var(--color-text-on-accent)", border: "none" }}
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

/**
 * SaveTemplateModal.tsx
 *
 * A modal for saving the current authoring canvas as a reusable template.
 *
 * The user provides:
 *   - Name (required)
 *   - Description (optional)
 *   - A checklist of which literal arg slots to expose as "params" (optional).
 *     Each checked slot gets an editable label and optional hint.
 *
 * On confirm, calls onSave(name, description, paramSelections) so the parent
 * can call graphToTemplate and persist the result via useUserTemplates.
 *
 * Styling mirrors SpecExporter.tsx / TemplateGallery.tsx:
 *   - fixed overlay, background var(--color-overlay), zIndex 100
 *   - elevated modal (var(--color-bg-elevated)), borderRadius 8, padding 24,
 *     width 560, maxHeight 80vh
 */

import { useState, useMemo } from "react";
import type { ContractNodeData } from "../spec/types.js";
import type { ContractFlowNode } from "../hooks/useGraph.js";
import type { ParamSelection } from "../templates/serialize.js";

// ---------------------------------------------------------------------------
// Styles (mirror SpecExporter / TemplateGallery)
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
  width: 560,
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid var(--color-border-strong)",
  borderRadius: 4,
  boxSizing: "border-box",
  background: "var(--color-bg-elevated)",
  color: "var(--color-text)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-text-secondary)",
  marginBottom: 4,
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 16,
};

const slotRowStyle: React.CSSProperties = {
  border: "1px solid var(--color-border-subtle)",
  borderRadius: 6,
  padding: "10px 12px",
  marginBottom: 8,
  background: "var(--color-bg-subtle)",
};

const slotHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 4,
};

// ---------------------------------------------------------------------------
// Candidate slot type (flat list of all literal arg slots across nodes)
// ---------------------------------------------------------------------------

interface CandidateSlot {
  nodeId: string;
  argIndex: number;
  contractName: string;
  deployId: string;
  argName?: string;
  argType?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SaveTemplateModalProps {
  nodes: ContractFlowNode[];
  onSave: (name: string, description: string, params: ParamSelection[]) => void;
  onClose: () => void;
}

export function SaveTemplateModal({ nodes, onSave, onClose }: SaveTemplateModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // For each candidate slot: is it checked? what label/hint?
  // Key: `${nodeId}:${argIndex}`
  const [checkedSlots, setCheckedSlots] = useState<Set<string>>(new Set());
  const [slotLabels, setSlotLabels] = useState<Map<string, string>>(new Map());
  const [slotHints, setSlotHints] = useState<Map<string, string>>(new Map());

  // Enumerate all literal arg slots across all nodes as candidates
  const candidateSlots = useMemo<CandidateSlot[]>(() => {
    const slots: CandidateSlot[] = [];
    for (const node of nodes) {
      const data = node.data as unknown as ContractNodeData;
      for (const slot of data.args) {
        // Show literal slots as candidates (ref slots are wired by edges)
        if (slot.kind === "literal") {
          slots.push({
            nodeId: node.id,
            argIndex: slot.index,
            contractName: data.contractName,
            deployId: data.deployId,
            argName: slot.name,
            argType: slot.type,
          });
        }
      }
    }
    return slots;
  }, [nodes]);

  function slotKey(nodeId: string, argIndex: number): string {
    return `${nodeId}:${argIndex}`;
  }

  function defaultLabel(slot: CandidateSlot): string {
    const contractPart = slot.deployId || slot.contractName || "Contract";
    const argPart = slot.argName ?? `arg ${slot.argIndex}`;
    return `${contractPart} — ${argPart}`;
  }

  function toggleSlot(key: string, slot: CandidateSlot) {
    setCheckedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        // Pre-fill label with a sensible default on first check
        setSlotLabels((labels) => {
          if (!labels.has(key)) {
            const m = new Map(labels);
            m.set(key, defaultLabel(slot));
            return m;
          }
          return labels;
        });
      }
      return next;
    });
  }

  function handleConfirm() {
    if (!name.trim()) return; // button is disabled, but guard anyway

    const params: ParamSelection[] = [];
    for (const slot of candidateSlots) {
      const key = slotKey(slot.nodeId, slot.argIndex);
      if (checkedSlots.has(key)) {
        params.push({
          nodeId: slot.nodeId,
          argIndex: slot.argIndex,
          label: slotLabels.get(key) ?? defaultLabel(slot),
          hint: slotHints.get(key) || undefined,
        });
      }
    }

    onSave(name.trim(), description.trim(), params);
  }

  return (
    <div style={overlayStyle} data-testid="save-template-modal">
      <div style={modalStyle}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, color: "var(--color-text)" }}>Save as Template</h3>
          <button
            style={{ ...buttonStyle, background: "none" }}
            onClick={onClose}
            data-testid="save-template-close"
          >
            ✕ Close
          </button>
        </div>

        {/* Name field */}
        <div style={sectionStyle}>
          <label style={labelStyle} htmlFor="save-template-name-input">
            Template name <span style={{ color: "var(--color-danger-strong)" }}>*</span>
          </label>
          <input
            id="save-template-name-input"
            style={inputStyle}
            type="text"
            placeholder="e.g. My Token Stack"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="save-template-name"
          />
        </div>

        {/* Description field */}
        <div style={sectionStyle}>
          <label style={labelStyle} htmlFor="save-template-desc-input">
            Description
          </label>
          <input
            id="save-template-desc-input"
            style={inputStyle}
            type="text"
            placeholder="Short description of what this template deploys"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="save-template-description"
          />
        </div>

        {/* Param slot checklist */}
        {candidateSlots.length > 0 && (
          <div style={sectionStyle}>
            <label style={labelStyle}>
              Expose as params (optional)
            </label>
            <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: "0 0 8px" }}>
              Check the arg slots users should fill before deploying. Each checked slot
              will appear as a reminder in the template gallery after instantiation.
            </p>
            {candidateSlots.map((slot) => {
              const key = slotKey(slot.nodeId, slot.argIndex);
              const checked = checkedSlots.has(key);
              return (
                <div key={key} style={slotRowStyle}>
                  <div style={slotHeaderStyle}>
                    <input
                      type="checkbox"
                      id={`param-slot-${slot.nodeId}-${slot.argIndex}`}
                      checked={checked}
                      onChange={() => toggleSlot(key, slot)}
                      data-testid={`param-slot-${slot.nodeId}-${slot.argIndex}`}
                    />
                    <label
                      htmlFor={`param-slot-${slot.nodeId}-${slot.argIndex}`}
                      style={{ fontSize: 13, cursor: "pointer" }}
                    >
                      <strong>{slot.deployId || slot.contractName}</strong>
                      {" — "}
                      {slot.argName
                        ? <span>{slot.argName}{slot.argType ? <span style={{ color: "var(--color-text-faint)" }}> ({slot.argType})</span> : null}</span>
                        : <span>arg {slot.argIndex}</span>}
                    </label>
                  </div>
                  {checked && (
                    <div style={{ paddingLeft: 24, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ flex: "2 1 160px" }}>
                        <label style={{ ...labelStyle, marginTop: 4 }}>Label</label>
                        <input
                          style={{ ...inputStyle, fontSize: 12 }}
                          type="text"
                          value={slotLabels.get(key) ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSlotLabels((m) => {
                              const next = new Map(m);
                              next.set(key, val);
                              return next;
                            });
                          }}
                          placeholder="Label"
                        />
                      </div>
                      <div style={{ flex: "1 1 120px" }}>
                        <label style={{ ...labelStyle, marginTop: 4 }}>Hint (optional)</label>
                        <input
                          style={{ ...inputStyle, fontSize: 12 }}
                          type="text"
                          value={slotHints.get(key) ?? ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSlotHints((m) => {
                              const next = new Map(m);
                              next.set(key, val);
                              return next;
                            });
                          }}
                          placeholder="e.g. 18 for standard tokens"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...buttonStyle,
              background: name.trim() ? "var(--color-primary)" : "var(--color-disabled-bg)",
              color: "var(--color-text-on-accent)",
              border: "none",
              cursor: name.trim() ? "pointer" : "not-allowed",
            }}
            onClick={handleConfirm}
            disabled={!name.trim()}
            data-testid="save-template-confirm"
          >
            Save Template
          </button>
        </div>
      </div>
    </div>
  );
}

export default SaveTemplateModal;

/**
 * SaveTemplateModal.test.tsx
 *
 * Component tests for SaveTemplateModal:
 *   1. Renders modal with name/description fields and confirm button.
 *   2. Confirm is disabled when name is empty.
 *   3. Param slots are enumerated from literal arg slots.
 *   4. Toggling a param slot exposes label/hint inputs.
 *   5. onSave is called with correct arguments on confirm.
 *   6. onClose is called when Close / Cancel is clicked.
 *   7. Label and hint values flow into onSave's params.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SaveTemplateModal } from "../src/components/SaveTemplateModal";
import type { ContractFlowNode } from "../src/hooks/useGraph";
import type { ContractNodeData } from "../src/spec/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  deployId: string,
  contractName: string,
  args: ContractNodeData["args"],
): ContractFlowNode {
  const data: ContractNodeData = {
    deployId,
    contractName,
    args,
    after: [],
    configSteps: [],
    onUpdateDeployId: vi.fn(),
    onUpdateContractName: vi.fn(),
    onUpdateArgSlot: vi.fn(),
  };
  return {
    id,
    type: "contractNode",
    position: { x: 100, y: 100 },
    data: data as unknown as Record<string, unknown>,
  };
}

const twoNodes: ContractFlowNode[] = [
  makeNode("node-1", "Token", "ERC20Token", [
    { index: 0, kind: "literal", value: "", name: "name_", type: "string" },
    { index: 1, kind: "literal", value: "", name: "symbol_", type: "string" },
  ]),
  makeNode("node-2", "Vault", "VaultERC4626", [
    { index: 0, kind: "ref", value: "" },          // ref slot — NOT a candidate
    { index: 1, kind: "literal", value: "8" },
  ]),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderModal(
  nodes = twoNodes,
  onSave = vi.fn(),
  onClose = vi.fn(),
) {
  return render(
    <SaveTemplateModal nodes={nodes} onSave={onSave} onClose={onClose} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Rendering
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — rendering", () => {
  it("renders the modal element", () => {
    renderModal();
    expect(screen.getByTestId("save-template-modal")).not.toBeNull();
  });

  it("renders the name input", () => {
    renderModal();
    expect(screen.getByTestId("save-template-name")).not.toBeNull();
  });

  it("renders the confirm button", () => {
    renderModal();
    expect(screen.getByTestId("save-template-confirm")).not.toBeNull();
  });

  it("renders the close button", () => {
    renderModal();
    expect(screen.getByTestId("save-template-close")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Confirm button disabled state
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — confirm disabled when name is empty", () => {
  it("confirm button is disabled initially (no name)", () => {
    renderModal();
    const btn = screen.getByTestId("save-template-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("confirm button is enabled after entering a name", () => {
    renderModal();
    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "My Template" },
    });
    const btn = screen.getByTestId("save-template-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("confirm button is disabled again if name is cleared", () => {
    renderModal();
    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "My Template" },
    });
    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "" },
    });
    const btn = screen.getByTestId("save-template-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Param slot enumeration
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — param slot enumeration", () => {
  it("renders checkboxes for literal arg slots", () => {
    renderModal();
    // twoNodes has 3 literal slots (node-1 arg0, node-1 arg1, node-2 arg1)
    expect(screen.getByTestId("param-slot-node-1-0")).not.toBeNull();
    expect(screen.getByTestId("param-slot-node-1-1")).not.toBeNull();
    expect(screen.getByTestId("param-slot-node-2-1")).not.toBeNull();
  });

  it("does NOT render a checkbox for ref arg slots", () => {
    renderModal();
    // node-2 arg0 is a ref slot — should not appear
    expect(screen.queryByTestId("param-slot-node-2-0")).toBeNull();
  });

  it("renders no param checklist when all nodes have no literal args", () => {
    const refOnlyNode: ContractFlowNode = makeNode("node-ref", "Token", "Token", [
      { index: 0, kind: "ref", value: "" },
    ]);
    renderModal([refOnlyNode]);
    expect(screen.queryByTestId("param-slot-node-ref-0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Toggling a param slot
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — toggling param slots", () => {
  it("checking a slot shows label input", () => {
    renderModal();
    const checkbox = screen.getByTestId("param-slot-node-1-0") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    // After checking, a label input should appear
    // The label input is not individually testid'd, but we can check the input count increased
    const inputs = screen.getAllByRole("textbox");
    // Should have: name, description, + at least 1 label input for the checked slot
    expect(inputs.length).toBeGreaterThanOrEqual(3);
  });

  it("unchecking a slot hides label input", () => {
    renderModal();
    const checkbox = screen.getByTestId("param-slot-node-1-0") as HTMLInputElement;
    fireEvent.click(checkbox); // check
    fireEvent.click(checkbox); // uncheck
    expect(checkbox.checked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. onSave called correctly
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — onSave", () => {
  it("calls onSave with name and description when confirmed with no params", () => {
    const onSave = vi.fn();
    renderModal(twoNodes, onSave);

    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "My Template" },
    });
    fireEvent.change(screen.getByTestId("save-template-description"), {
      target: { value: "My description" },
    });
    fireEvent.click(screen.getByTestId("save-template-confirm"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [name, desc, params] = onSave.mock.calls[0] as [string, string, unknown[]];
    expect(name).toBe("My Template");
    expect(desc).toBe("My description");
    expect(params).toHaveLength(0);
  });

  it("calls onSave with selected param slots", () => {
    const onSave = vi.fn();
    renderModal(twoNodes, onSave);

    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "My Template" },
    });

    // Check the first param slot
    fireEvent.click(screen.getByTestId("param-slot-node-1-0"));

    fireEvent.click(screen.getByTestId("save-template-confirm"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [, , params] = onSave.mock.calls[0] as [string, string, Array<{ nodeId: string; argIndex: number; label: string }>];
    expect(params).toHaveLength(1);
    expect(params[0].nodeId).toBe("node-1");
    expect(params[0].argIndex).toBe(0);
    expect(params[0].label.length).toBeGreaterThan(0);
  });

  it("does not call onSave when name is empty", () => {
    const onSave = vi.fn();
    renderModal(twoNodes, onSave);

    // Try to click without entering a name (button is disabled)
    const btn = screen.getByTestId("save-template-confirm") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("user-typed label flows into onSave params[0].label", () => {
    const onSave = vi.fn();
    renderModal(twoNodes, onSave);

    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "My Template" },
    });

    // Toggle the first param slot on
    fireEvent.click(screen.getByTestId("param-slot-node-1-0"));

    // The label input appears with a default value — change it to a custom label
    // Find label input by placeholder text
    const labelInput = screen.getByPlaceholderText("Label") as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Custom Token Label" } });

    fireEvent.click(screen.getByTestId("save-template-confirm"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [, , params] = onSave.mock.calls[0] as [string, string, Array<{ nodeId: string; argIndex: number; label: string; hint?: string }>];
    expect(params).toHaveLength(1);
    expect(params[0].label).toBe("Custom Token Label");
  });

  it("user-typed hint flows into onSave params[0].hint", () => {
    const onSave = vi.fn();
    renderModal(twoNodes, onSave);

    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "My Template" },
    });

    // Toggle the first param slot on
    fireEvent.click(screen.getByTestId("param-slot-node-1-0"));

    // Change the hint input
    const hintInput = screen.getByPlaceholderText("e.g. 18 for standard tokens") as HTMLInputElement;
    fireEvent.change(hintInput, { target: { value: "e.g. USD Coin" } });

    fireEvent.click(screen.getByTestId("save-template-confirm"));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [, , params] = onSave.mock.calls[0] as [string, string, Array<{ nodeId: string; argIndex: number; label: string; hint?: string }>];
    expect(params).toHaveLength(1);
    expect(params[0].hint).toBe("e.g. USD Coin");
  });
});

// ---------------------------------------------------------------------------
// 6. onClose
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — onClose", () => {
  it("calls onClose when Close button is clicked", () => {
    const onClose = vi.fn();
    renderModal(twoNodes, vi.fn(), onClose);
    fireEvent.click(screen.getByTestId("save-template-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Cancel button is clicked", () => {
    const onClose = vi.fn();
    renderModal(twoNodes, vi.fn(), onClose);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. No nodes
// ---------------------------------------------------------------------------

describe("SaveTemplateModal — empty canvas", () => {
  it("renders without errors when there are no nodes", () => {
    renderModal([]);
    expect(screen.getByTestId("save-template-modal")).not.toBeNull();
  });

  it("can still save a template with no nodes", () => {
    const onSave = vi.fn();
    renderModal([], onSave);
    fireEvent.change(screen.getByTestId("save-template-name"), {
      target: { value: "Empty Template" },
    });
    fireEvent.click(screen.getByTestId("save-template-confirm"));
    expect(onSave).toHaveBeenCalledWith("Empty Template", "", []);
  });
});

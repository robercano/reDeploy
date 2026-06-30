/**
 * ContractNode.test.tsx
 *
 * Render tests for the ContractNode component, covering:
 *
 * 1. The `hasParamInfo` branch in ArgRow — when arg slots carry name/type,
 *    the visible label and type are rendered.
 * 2. Plain slots (no name, no type) — the label spans should NOT be present.
 * 3. Contract Name is read-only (rendered as a label, not an input).
 * 4. Ref slots (bound by a constructorRef edge) display "{sourceDeployId}.address"
 *    as a read-only element instead of an editable input.
 * 5. Literal slots (no incoming edge) remain editable.
 *
 * These tests prove the issue #37 acceptance criterion at the render layer:
 * "constructor arg rows are labeled with real param name and type from the
 * manifest when added via the Contracts Browser".
 *
 * ## Setup note
 * ContractNode receives a NodeProps from React Flow. We pass the minimum props
 * needed (`id`, `data`, `selected`) and wrap with a React Flow Provider so
 * Handle components don't throw.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReactFlowProvider } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { ContractNode } from "../src/components/ContractNode.js";
import type { ContractNodeData } from "../src/spec/types.js";

// ---------------------------------------------------------------------------
// Minimal stub callbacks
// ---------------------------------------------------------------------------

const noop = () => {};

function makeData(overrides: Partial<ContractNodeData> = {}): ContractNodeData {
  return {
    deployId: "",
    contractName: "TestContract",
    args: [],
    after: [],
    configSteps: [],
    onUpdateDeployId: noop,
    onUpdateContractName: noop,
    onUpdateArgSlot: noop,
    ...overrides,
  };
}

/**
 * Render ContractNode with the given data inside a ReactFlowProvider.
 * We pass `id`, `data`, `selected`, and all other NodeProps as stubs.
 */
function renderContractNode(data: ContractNodeData, selected = false) {
  // ContractNode is typed as React Flow's NodeProps (unparameterised).
  // We need to pass the full shape. Only id/data/selected are read in the component.
  const props = {
    id: "test-node",
    data: data as unknown as Record<string, unknown>,
    selected,
    // Required NodeProps fields that ContractNodeInner does not use:
    type: "contractNode",
    zIndex: 0,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };

  return render(
    <ReactFlowProvider>
      <ContractNode {...(props as unknown as NodeProps)} />
    </ReactFlowProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests: hasParamInfo branch (name and type present)
// ---------------------------------------------------------------------------

describe("ContractNode — ArgRow with name and type (hasParamInfo branch)", () => {
  it("renders the param name label when arg has name defined", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          name: "asset_",
          type: "contract IERC20",
        },
      ],
    });

    renderContractNode(data);

    // The param name should appear as a visible label span
    expect(screen.getByText("asset_")).not.toBeNull();
  });

  it("renders the param type when arg has type defined", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          name: "asset_",
          type: "contract IERC20",
        },
      ],
    });

    renderContractNode(data);

    // The param type should appear as a visible span
    expect(screen.getByText("contract IERC20")).not.toBeNull();
  });

  it("renders both name and type for a second arg slot (oracle_)", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          name: "asset_",
          type: "contract IERC20",
        },
        {
          index: 1,
          kind: "literal",
          value: "",
          name: "oracle_",
          type: "contract AggregatorV3Interface",
        },
      ],
    });

    renderContractNode(data);

    expect(screen.getByText("asset_")).not.toBeNull();
    expect(screen.getByText("contract IERC20")).not.toBeNull();
    expect(screen.getByText("oracle_")).not.toBeNull();
    expect(screen.getByText("contract AggregatorV3Interface")).not.toBeNull();
  });

  it("renders name-only when type is undefined", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          name: "amount",
          // type intentionally absent
        },
      ],
    });

    renderContractNode(data);

    expect(screen.getByText("amount")).not.toBeNull();
  });

  it("renders type-only when name is undefined", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          type: "uint256",
          // name intentionally absent
        },
      ],
    });

    renderContractNode(data);

    expect(screen.getByText("uint256")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: plain slots (no name, no type) — label spans absent
// ---------------------------------------------------------------------------

describe("ContractNode — ArgRow without name or type (plain slot)", () => {
  it("does not render any param label or type when arg has neither name nor type", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          // no name, no type
        },
      ],
    });

    renderContractNode(data);

    // The arg input should exist (aria-label "arg-0")
    expect(screen.getByLabelText("arg-0")).not.toBeNull();

    // No label text like "asset_" or type text like "contract IERC20" should appear
    // We check that the only text in the arg area is the index marker and button
    // by asserting no span with param-name-like content renders
    const container = document.querySelector("[data-testid='contract-node-test-node']");
    expect(container).not.toBeNull();
    // The hasParamInfo block should NOT render — no extra label spans
    // The container should NOT contain spans with class info that only appear when
    // hasParamInfo is true. We check by confirming paramTypeStyle (italic) text is absent.
    const allSpans = container!.querySelectorAll("span");
    // The only spans should be the index marker "[0]" and the Handle internals
    // (Handle renders a div, not a span). Check none of them have param-type italic style.
    for (const span of allSpans) {
      // paramTypeStyle has fontStyle: italic
      if (span.style.fontStyle === "italic") {
        throw new Error(`Unexpected italic span found (param type rendered for plain slot): "${span.textContent}"`);
      }
    }
  });

  it("does not render any param label for a literal slot with a value but no name/type", () => {
    const data = makeData({
      args: [
        { index: 0, kind: "literal", value: "someValue" },
      ],
    });

    renderContractNode(data);

    // Input should have the value
    const input = screen.getByLabelText("arg-0") as HTMLInputElement;
    expect(input.value).toBe("someValue");

    // No param name/type labels should be present (no italic spans)
    const container = document.querySelector("[data-testid='contract-node-test-node']")!;
    const italicSpans = Array.from(container.querySelectorAll("span")).filter(
      (s) => s.style.fontStyle === "italic",
    );
    expect(italicSpans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Contract Name is read-only (rendered as a label, not an input)
// ---------------------------------------------------------------------------

describe("ContractNode — Contract Name is read-only", () => {
  it("renders contract name as a static label element, not an input", () => {
    const data = makeData({ contractName: "ERC20Token" });
    renderContractNode(data);

    // The contract name should be visible
    const label = screen.getByLabelText("contract-name");
    expect(label.tagName.toLowerCase()).not.toBe("input");
    expect(label.textContent).toBe("ERC20Token");
  });

  it("shows the contract name text in the node", () => {
    const data = makeData({ contractName: "Registry" });
    renderContractNode(data);

    // Text should appear in the rendered node
    expect(screen.getByText("Registry")).not.toBeNull();
  });

  it("renders deploy-id as an editable input (not read-only)", () => {
    const data = makeData({ deployId: "myToken" });
    renderContractNode(data);

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.tagName.toLowerCase()).toBe("input");
    expect(deployIdInput.value).toBe("myToken");
  });

  it("no editable input with aria-label contract-name exists", () => {
    const data = makeData({ contractName: "Vault" });
    renderContractNode(data);

    // The aria-label should be on a non-input element
    const el = screen.getByLabelText("contract-name");
    // It should NOT be an HTMLInputElement
    expect(el instanceof HTMLInputElement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Ref slots are read-only and display "{sourceDeployId}.address"
// ---------------------------------------------------------------------------

describe("ContractNode — ref slots (bound by constructorRef edge)", () => {
  it("renders a ref slot as a non-editable div showing '{deployId}.address'", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "token"]]),
    });

    renderContractNode(data);

    // The slot should show "token.address"
    const el = screen.getByLabelText("arg-0");
    expect(el.tagName.toLowerCase()).not.toBe("input");
    expect(el.textContent).toBe("token.address");
  });

  it("updates the displayed text when source deployId changes", () => {
    // First render with source "token"
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "token"]]),
    });

    const { rerender } = render(
      <ReactFlowProvider>
        <ContractNode
          {...({
            id: "test-node",
            data: data as unknown as Record<string, unknown>,
            selected: false,
            type: "contractNode",
            zIndex: 0,
            isConnectable: true,
            xPos: 0,
            yPos: 0,
            dragging: false,
            positionAbsoluteX: 0,
            positionAbsoluteY: 0,
          } as unknown as NodeProps)}
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByLabelText("arg-0").textContent).toBe("token.address");

    // Rerender with updated source deployId "myToken"
    const updatedData = makeData({
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "myToken"]]),
    });

    rerender(
      <ReactFlowProvider>
        <ContractNode
          {...({
            id: "test-node",
            data: updatedData as unknown as Record<string, unknown>,
            selected: false,
            type: "contractNode",
            zIndex: 0,
            isConnectable: true,
            xPos: 0,
            yPos: 0,
            dragging: false,
            positionAbsoluteX: 0,
            positionAbsoluteY: 0,
          } as unknown as NodeProps)}
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByLabelText("arg-0").textContent).toBe("myToken.address");
  });

  it("only the ref-bound slot is read-only; other slots remain editable inputs", () => {
    const data = makeData({
      args: [
        { index: 0, kind: "literal", value: "" },   // bound by edge → ref
        { index: 1, kind: "literal", value: "99" },  // not bound → literal input
      ],
      refSourceDeployIds: new Map([[0, "oracle"]]),
    });

    renderContractNode(data);

    // Slot 0: ref display div showing "oracle.address"
    const slot0 = screen.getByLabelText("arg-0");
    expect(slot0.tagName.toLowerCase()).not.toBe("input");
    expect(slot0.textContent).toBe("oracle.address");

    // Slot 1: still an editable input with value "99"
    const slot1 = screen.getByLabelText("arg-1") as HTMLInputElement;
    expect(slot1.tagName.toLowerCase()).toBe("input");
    expect(slot1.value).toBe("99");
  });

  it("when no refSourceDeployIds, all slots are editable inputs", () => {
    const data = makeData({
      args: [
        { index: 0, kind: "literal", value: "" },
        { index: 1, kind: "literal", value: "hello" },
      ],
      // no refSourceDeployIds — means no incoming edges
    });

    renderContractNode(data);

    const slot0 = screen.getByLabelText("arg-0") as HTMLInputElement;
    expect(slot0.tagName.toLowerCase()).toBe("input");

    const slot1 = screen.getByLabelText("arg-1") as HTMLInputElement;
    expect(slot1.tagName.toLowerCase()).toBe("input");
    expect(slot1.value).toBe("hello");
  });

  it("ref slot with name and type still renders the name/type labels alongside the ref display", () => {
    const data = makeData({
      args: [
        {
          index: 0,
          kind: "literal",
          value: "",
          name: "asset_",
          type: "contract IERC20",
        },
      ],
      refSourceDeployIds: new Map([[0, "token"]]),
    });

    renderContractNode(data);

    // The param name label and type should still appear
    expect(screen.getByText("asset_")).not.toBeNull();
    expect(screen.getByText("contract IERC20")).not.toBeNull();

    // The arg slot itself should be the ref display, not an input
    const slot = screen.getByLabelText("arg-0");
    expect(slot.tagName.toLowerCase()).not.toBe("input");
    expect(slot.textContent).toBe("token.address");
  });
});

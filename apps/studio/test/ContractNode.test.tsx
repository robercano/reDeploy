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

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// Tests: field/node-level error highlighting (issue #83)
// ---------------------------------------------------------------------------

describe("ContractNode — error highlighting (issue #83)", () => {
  it("marks the deploy-id input as invalid and shows the message when errors.deployId is set", () => {
    const data = makeData({
      deployId: "",
      errors: { deployId: "contract entry id must be a non-empty string" },
    });

    renderContractNode(data);

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBe("true");
    expect(deployIdInput.style.border).toContain("var(--color-danger)");
    expect(
      screen.getByTestId("node-field-error-deploy-id-test-node").textContent,
    ).toBe("contract entry id must be a non-empty string");
  });

  it("does not mark the deploy-id input as invalid when errors is absent", () => {
    const data = makeData({ deployId: "token" });
    renderContractNode(data);

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByTestId("node-field-error-deploy-id-test-node")).toBeNull();
  });

  it("marks only the arg slot with a matching errors.args entry", () => {
    const data = makeData({
      args: [
        { index: 0, kind: "literal", value: "" },
        { index: 1, kind: "literal", value: "" },
      ],
      errors: { args: { 1: "symbol_ must not be empty" } },
    });

    renderContractNode(data);

    const arg0 = screen.getByLabelText("arg-0") as HTMLInputElement;
    expect(arg0.getAttribute("aria-invalid")).toBeNull();

    const arg1 = screen.getByLabelText("arg-1") as HTMLInputElement;
    expect(arg1.getAttribute("aria-invalid")).toBe("true");
    expect(arg1.style.border).toContain("var(--color-danger)");
    expect(
      screen.getByTestId("node-field-error-arg-1-test-node").textContent,
    ).toBe("symbol_ must not be empty");
  });

  it("red-borders the node container and renders the node-level message when errors.node is set (no field mapping)", () => {
    const data = makeData({ errors: { node: "duplicate deploy id across contracts" } });
    renderContractNode(data);

    const nodeEl = screen.getByTestId("contract-node-test-node");
    expect(nodeEl.getAttribute("data-node-invalid")).toBe("true");
    expect(nodeEl.style.border).toContain("var(--color-danger)");
    expect(screen.getByTestId("node-error-test-node").textContent).toBe(
      "duplicate deploy id across contracts",
    );

    // No field-level highlight — deploy-id remains valid.
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("does not red-border the node container when errors is absent", () => {
    const data = makeData();
    renderContractNode(data);

    const nodeEl = screen.getByTestId("contract-node-test-node");
    expect(nodeEl.getAttribute("data-node-invalid")).toBeNull();
    expect(nodeEl.style.border).not.toContain("var(--color-danger)");
    expect(screen.queryByTestId("node-error-test-node")).toBeNull();
  });

  it("also red-borders the node container when a field-level error is present (deployId)", () => {
    // A field-level error still flags the node itself for discoverability,
    // in addition to highlighting the specific input.
    const data = makeData({ errors: { deployId: "id must be non-empty" } });
    renderContractNode(data);

    const nodeEl = screen.getByTestId("contract-node-test-node");
    expect(nodeEl.getAttribute("data-node-invalid")).toBe("true");
  });

  it("selected takes precedence over the error border color", () => {
    const data = makeData({ errors: { node: "some node-level error" } });
    renderContractNode(data, /* selected */ true);

    const nodeEl = screen.getByTestId("contract-node-test-node");
    // selected primary token wins over the error "danger" token.
    expect(nodeEl.style.border).toContain("var(--color-primary)");
  });
});

// ---------------------------------------------------------------------------
// Tests: per-slot kind selector + per-kind inputs (issue #137)
// ---------------------------------------------------------------------------

describe("ContractNode — ArgRow kind selector (issue #137)", () => {
  it("renders the kind selector with literal selected by default", () => {
    const data = makeData({ args: [{ index: 0, kind: "literal", value: "hello" }] });
    renderContractNode(data);

    const select = screen.getByLabelText("argkind-0") as HTMLSelectElement;
    expect(select.value).toBe("literal");
    // Options present
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(["literal", "param", "expr", "resolver"]);
  });

  it("does not render the kind selector for a slot bound by a constructorRef edge", () => {
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "" }],
      refSourceDeployIds: new Map([[0, "token"]]),
    });
    renderContractNode(data);
    expect(screen.queryByLabelText("argkind-0")).toBeNull();
  });

  it("switching the kind selector to 'param' calls onUpdateArgSlot with {kind:'param'}", () => {
    const onUpdateArgSlot = vi.fn();
    const data = makeData({
      args: [{ index: 0, kind: "literal", value: "" }],
      onUpdateArgSlot,
    });
    renderContractNode(data);

    fireEvent.change(screen.getByLabelText("argkind-0"), { target: { value: "param" } });
    expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, { kind: "param" });
  });

  it("a stale 'ref' kind slot with no bound edge behaves like literal (kind selector shows 'literal')", () => {
    const data = makeData({ args: [{ index: 0, kind: "ref", value: "42" }] });
    renderContractNode(data);

    const select = screen.getByLabelText("argkind-0") as HTMLSelectElement;
    expect(select.value).toBe("literal");
    const input = screen.getByLabelText("arg-0") as HTMLInputElement;
    expect(input.value).toBe("42");
  });

  describe("param kind", () => {
    it("renders a parameter-name input and calls onUpdateArgSlot on change", () => {
      const onUpdateArgSlot = vi.fn();
      const data = makeData({
        args: [{ index: 0, kind: "param", value: "", paramName: "" }],
        onUpdateArgSlot,
      });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.value).toBe("");
      fireEvent.change(input, { target: { value: "initialOwner" } });
      expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, { paramName: "initialOwner" });
    });

    it("flags a blank parameter name as invalid (inline validation, no server errors needed)", () => {
      const data = makeData({ args: [{ index: 0, kind: "param", value: "", paramName: "" }] });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByTestId("node-field-error-arg-0-test-node").textContent).toBe(
        "parameter name must not be empty",
      );
    });

    it("does not flag a non-blank parameter name", () => {
      const data = makeData({ args: [{ index: 0, kind: "param", value: "", paramName: "owner" }] });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.getAttribute("aria-invalid")).toBeNull();
      expect(screen.queryByTestId("node-field-error-arg-0-test-node")).toBeNull();
    });

    it("offers declared parameter names as datalist suggestions when provided via configCallbacks.paramNames", () => {
      const data = {
        ...makeData({ args: [{ index: 0, kind: "param", value: "", paramName: "" }] }),
        configCallbacks: {
          onAddConfigStep: noop,
          onRemoveConfigStep: noop,
          onUpdateSetXStep: noop,
          onUpdateGrantRoleStep: noop,
          deployTargets: [],
          paramNames: ["owner", "cap"],
        },
      };
      renderContractNode(data as unknown as ContractNodeData);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      const listId = input.getAttribute("list");
      expect(listId).not.toBeNull();
      const datalist = document.getElementById(listId!) as HTMLDataListElement;
      const values = Array.from(datalist.options).map((o) => o.value);
      expect(values).toEqual(["owner", "cap"]);
    });
  });

  describe("expr kind", () => {
    it("renders an expression input and calls onUpdateArgSlot on change", () => {
      const onUpdateArgSlot = vi.fn();
      const data = makeData({
        args: [{ index: 0, kind: "expr", value: "", expression: "" }],
        onUpdateArgSlot,
      });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "params.supply * 2n" } });
      expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, { expression: "params.supply * 2n" });
    });

    it("flags a blank expression as invalid", () => {
      const data = makeData({ args: [{ index: 0, kind: "expr", value: "", expression: "   " }] });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByTestId("node-field-error-arg-0-test-node").textContent).toBe(
        "expression must not be empty",
      );
    });

    it("does not flag a non-blank expression", () => {
      const data = makeData({ args: [{ index: 0, kind: "expr", value: "", expression: "1n + 2n" }] });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.getAttribute("aria-invalid")).toBeNull();
    });
  });

  describe("resolver kind", () => {
    it("renders a resolver-name input and a resolver-args input, both wired to onUpdateArgSlot", () => {
      const onUpdateArgSlot = vi.fn();
      const data = makeData({
        args: [{ index: 0, kind: "resolver", value: "", resolverName: "", resolverArgs: [] }],
        onUpdateArgSlot,
      });
      renderContractNode(data);

      const nameInput = screen.getByLabelText("arg-0") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "computeSalt" } });
      expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, { resolverName: "computeSalt" });

      const argsInput = screen.getByLabelText("argresolverargs-0") as HTMLInputElement;
      fireEvent.change(argsInput, { target: { value: "v1, 42, true" } });
      expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, {
        resolverArgs: ["v1", "42", "true"],
      });
    });

    it("clears resolverArgs to an empty array when the args input is cleared", () => {
      const onUpdateArgSlot = vi.fn();
      const data = makeData({
        args: [{ index: 0, kind: "resolver", value: "", resolverName: "computeSalt", resolverArgs: ["v1"] }],
        onUpdateArgSlot,
      });
      renderContractNode(data);

      const argsInput = screen.getByLabelText("argresolverargs-0") as HTMLInputElement;
      expect(argsInput.value).toBe("v1");
      fireEvent.change(argsInput, { target: { value: "" } });
      expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, { resolverArgs: [] });
    });

    it("flags a blank resolver name as invalid", () => {
      const data = makeData({ args: [{ index: 0, kind: "resolver", value: "", resolverName: "" }] });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByTestId("node-field-error-arg-0-test-node").textContent).toBe(
        "resolver name must not be empty",
      );
    });

    it("does not flag a non-blank resolver name", () => {
      const data = makeData({ args: [{ index: 0, kind: "resolver", value: "", resolverName: "computeSalt" }] });
      renderContractNode(data);

      const input = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(input.getAttribute("aria-invalid")).toBeNull();
    });
  });

  it("switching kind to 'literal' updates the slot back to a plain value input", () => {
    const onUpdateArgSlot = vi.fn();
    const data = makeData({
      args: [{ index: 0, kind: "param", value: "", paramName: "owner" }],
      onUpdateArgSlot,
    });
    renderContractNode(data);

    fireEvent.change(screen.getByLabelText("argkind-0"), { target: { value: "literal" } });
    expect(onUpdateArgSlot).toHaveBeenCalledWith("test-node", 0, { kind: "literal" });
  });

  it("server-provided errorMessage takes precedence over the local inline-validation message", () => {
    const data = makeData({
      args: [{ index: 0, kind: "param", value: "", paramName: "" }],
      errors: { args: { 0: "server-side error message" } },
    });
    renderContractNode(data);

    expect(screen.getByTestId("node-field-error-arg-0-test-node").textContent).toBe(
      "server-side error message",
    );
  });
});

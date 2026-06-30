/**
 * ContractNode.test.tsx
 *
 * Render tests for the ContractNode component, covering:
 *
 * 1. The `hasParamInfo` branch in ArgRow — when arg slots carry name/type,
 *    the visible label and type are rendered.
 * 2. Plain slots (no name, no type) — the label spans should NOT be present.
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

/**
 * ConfigPanel.test.tsx
 *
 * Tests for the ConfigPanel component: rendering steps, editing fields,
 * adding and removing steps.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConfigPanel } from "../src/components/ConfigPanel";
import type { ContractNodeData } from "../src/spec/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(overrides: Partial<ContractNodeData> = {}): ContractNodeData {
  return {
    deployId: "vault",
    contractName: "Vault",
    args: [],
    after: [],
    configSteps: [],
    onUpdateDeployId: () => {},
    onUpdateContractName: () => {},
    onUpdateArgSlot: () => {},
    onAddArg: () => {},
    onRemoveArg: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ConfigPanel — rendering", () => {
  it("renders the panel with node deploy id in title", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={makeData()}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByTestId("config-panel")).not.toBeNull();
    expect(screen.getByText(/vault/)).not.toBeNull();
  });

  it("shows '(no id)' when deployId is empty", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={makeData({ deployId: "" })}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByText(/no id/)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adding steps
// ---------------------------------------------------------------------------

describe("ConfigPanel — adding steps", () => {
  it("calls onAddStep with 'setX' when + setX clicked", () => {
    const onAddStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={makeData()}
        onAddStep={onAddStep}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("+ setX"));
    expect(onAddStep).toHaveBeenCalledWith("n1", "setX");
  });

  it("calls onAddStep with 'grantRole' when + grantRole clicked", () => {
    const onAddStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={makeData()}
        onAddStep={onAddStep}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("+ grantRole"));
    expect(onAddStep).toHaveBeenCalledWith("n1", "grantRole");
  });
});

// ---------------------------------------------------------------------------
// setX step rendering and editing
// ---------------------------------------------------------------------------

describe("ConfigPanel — setX step", () => {
  const dataWithSetX = makeData({
    configSteps: [
      {
        kind: "setX",
        id: "step-1",
        functionName: "setFee",
        args: ["100"],
      },
    ],
  });

  it("renders a setX step card", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByTestId("step-step-1")).not.toBeNull();
  });

  it("calls onUpdateSetXStep when function name edited", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const input = screen.getByLabelText("setx-function-n1-step-1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "newFn" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-1", { functionName: "newFn" });
  });

  it("calls onUpdateSetXStep when args edited (comma-separated)", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const input = screen.getByLabelText("setx-args-n1-step-1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a,b,c" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-1", { args: ["a", "b", "c"] });
  });

  it("calls onUpdateSetXStep with empty args when args cleared", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const input = screen.getByLabelText("setx-args-n1-step-1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-1", { args: [] });
  });

  it("calls onRemoveStep when remove button clicked", () => {
    const onRemoveStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        onAddStep={() => {}}
        onRemoveStep={onRemoveStep}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    fireEvent.click(screen.getByTitle("Remove step"));
    expect(onRemoveStep).toHaveBeenCalledWith("n1", "step-1");
  });
});

// ---------------------------------------------------------------------------
// grantRole step rendering and editing
// ---------------------------------------------------------------------------

describe("ConfigPanel — grantRole step", () => {
  const dataWithGrantRole = makeData({
    configSteps: [
      {
        kind: "grantRole",
        id: "step-2",
        role: "ADMIN",
        accountKind: "literal",
        accountValue: "0xabc",
      },
    ],
  });

  it("renders a grantRole step card", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithGrantRole}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByTestId("step-step-2")).not.toBeNull();
  });

  it("calls onUpdateGrantRoleStep when role edited", () => {
    const onUpdateGrantRoleStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithGrantRole}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={onUpdateGrantRoleStep}
      />,
    );
    const input = screen.getByLabelText("grantrole-role-n1-step-2") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "MINTER" } });
    expect(onUpdateGrantRoleStep).toHaveBeenCalledWith("n1", "step-2", { role: "MINTER" });
  });

  it("calls onUpdateGrantRoleStep when account kind changed to ref", () => {
    const onUpdateGrantRoleStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithGrantRole}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={onUpdateGrantRoleStep}
      />,
    );
    const select = screen.getByLabelText("grantrole-acct-kind-n1-step-2") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ref" } });
    expect(onUpdateGrantRoleStep).toHaveBeenCalledWith("n1", "step-2", {
      accountKind: "ref",
    });
  });

  it("calls onUpdateGrantRoleStep when account value edited", () => {
    const onUpdateGrantRoleStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithGrantRole}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={onUpdateGrantRoleStep}
      />,
    );
    const input = screen.getByLabelText("grantrole-acct-val-n1-step-2") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0xnew" } });
    expect(onUpdateGrantRoleStep).toHaveBeenCalledWith("n1", "step-2", {
      accountValue: "0xnew",
    });
  });

  it("calls onRemoveStep when remove button clicked", () => {
    const onRemoveStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithGrantRole}
        onAddStep={() => {}}
        onRemoveStep={onRemoveStep}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    fireEvent.click(screen.getByTitle("Remove step"));
    expect(onRemoveStep).toHaveBeenCalledWith("n1", "step-2");
  });
});

// ---------------------------------------------------------------------------
// grantRole with ref account kind — shows "Contract ID" label
// ---------------------------------------------------------------------------

describe("ConfigPanel — grantRole with ref account", () => {
  it("renders 'Contract ID' label for ref kind", () => {
    const dataWithRef = makeData({
      configSteps: [
        {
          kind: "grantRole",
          id: "step-ref",
          role: "ADMIN",
          accountKind: "ref",
          accountValue: "admin",
        },
      ],
    });
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithRef}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByText("Contract ID")).not.toBeNull();
  });
});

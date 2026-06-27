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
import type { DeployTarget } from "../src/components/ConfigPanel";

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

/** Default empty deploy targets (no target picker shown). */
const NO_TARGETS: DeployTarget[] = [];

/** A pair of deploy targets for the target-picker tests. */
const TOKEN_TARGET: DeployTarget = { deployId: "token", contractName: "Token" };
const VAULT_TARGET: DeployTarget = { deployId: "vault", contractName: "Vault" };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ConfigPanel — rendering", () => {
  it("renders the panel with node deploy id in title", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={makeData()}
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
// setX step — fallback (unknown contractName, no manifest)
// ---------------------------------------------------------------------------

describe("ConfigPanel — setX step (fallback: unknown contract)", () => {
  const dataWithSetX = makeData({
    contractName: "UnknownContract",
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
        deployTargets={NO_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByTestId("step-step-1")).not.toBeNull();
  });

  it("shows the free-text function input when contract is not in manifest", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={NO_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    // The fallback free-text input must exist with the original aria-label.
    const input = screen.getByLabelText("setx-function-n1-step-1") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("setFee");
  });

  it("calls onUpdateSetXStep when function name edited (fallback path)", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
// setX step — manifest-driven (Token contract IS in the manifest)
// ---------------------------------------------------------------------------
// Tests use the real Token contract from src/Token.sol which has:
//   - Group "Token": mint(address to, uint256 amount)
//   - Group "AccessControl": grantRole, revokeRole, renounceRole (nonpayable)
//   - Group "ERC20": transfer, approve, transferFrom (nonpayable)
// view/pure functions (supportsInterface, hasRole, getRoleAdmin, name, symbol,
// decimals, totalSupply, balanceOf, allowance) MUST be excluded from the dropdown.

describe("ConfigPanel — setX step (manifest-driven: Token)", () => {
  const dataWithSetX = makeData({
    deployId: "token",
    contractName: "Token",
    configSteps: [
      {
        kind: "setX",
        id: "step-m1",
        functionName: "",
        args: [],
      },
    ],
  });

  it("renders a function <select> (not free-text) when contract is in manifest", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    // The manifest-driven select must be present.
    expect(screen.getByLabelText("setx-function-select-n1-step-m1")).not.toBeNull();
    // The fallback free-text input must NOT be present.
    expect(() => screen.getByLabelText("setx-function-n1-step-m1")).toThrow();
  });

  it("shows <optgroup> for 'Token' with 'mint' function", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    // optgroup label "Token" must appear.
    const tokenGroup = screen.getByRole("group", { name: "Token" });
    expect(tokenGroup).not.toBeNull();
    // "mint" option must be inside the Token group.
    const mintOption = screen.getByRole("option", { name: /^mint/ });
    expect(mintOption).not.toBeNull();
    expect(tokenGroup.contains(mintOption)).toBe(true);
  });

  it("shows <optgroup> for 'AccessControl' with grantRole function", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const acGroup = screen.getByRole("group", { name: "AccessControl" });
    expect(acGroup).not.toBeNull();
    const grantOption = screen.getByRole("option", { name: /^grantRole/ });
    expect(grantOption).not.toBeNull();
    expect(acGroup.contains(grantOption)).toBe(true);
  });

  it("excludes view/pure functions from the dropdown", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    // These are all view/pure in Token and must NOT be options.
    const viewFns = ["hasRole", "getRoleAdmin", "supportsInterface", "name", "symbol", "decimals", "totalSupply", "balanceOf", "allowance"];
    for (const fn of viewFns) {
      const options = screen.queryAllByRole("option", { name: new RegExp(`^${fn}`) });
      expect(options.length, `${fn} should not appear in function dropdown`).toBe(0);
    }
  });

  it("calls onUpdateSetXStep when a function is selected from the dropdown", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const select = screen.getByLabelText("setx-function-select-n1-step-m1") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "mint" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-m1", { functionName: "mint", args: [] });
  });
});

// ---------------------------------------------------------------------------
// setX step — arg slot labels derived from manifest inputs
// ---------------------------------------------------------------------------

describe("ConfigPanel — setX step (manifest arg labels: Token.mint)", () => {
  // Step with mint selected — has inputs: [to: address, amount: uint256]
  const dataWithMint = makeData({
    deployId: "token",
    contractName: "Token",
    configSteps: [
      {
        kind: "setX",
        id: "step-mint",
        functionName: "mint",
        args: ["0xabc", "1000"],
      },
    ],
  });

  it("renders per-input arg fields with name and type labels when a function is selected", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithMint}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    // Per-input arg fields with aria labels must exist with correct values.
    const arg0 = screen.getByLabelText("setx-arg-n1-step-mint-0") as HTMLInputElement;
    expect(arg0.value).toBe("0xabc");
    expect(arg0.placeholder).toBe("address");
    const arg1 = screen.getByLabelText("setx-arg-n1-step-mint-1") as HTMLInputElement;
    expect(arg1.value).toBe("1000");
    expect(arg1.placeholder).toBe("uint256");
    // Parameter name labels should appear — find the label div for "to" and "amount".
    // Use getAllByText since "to" might appear in other text; pick the first match.
    const toMatches = screen.getAllByText(/\bto\b/);
    expect(toMatches.length).toBeGreaterThan(0);
    const amountMatches = screen.getAllByText(/amount/);
    expect(amountMatches.length).toBeGreaterThan(0);
  });

  it("calls onUpdateSetXStep with updated args array when an individual arg is edited", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithMint}
        deployTargets={[TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const arg0 = screen.getByLabelText("setx-arg-n1-step-mint-0") as HTMLInputElement;
    fireEvent.change(arg0, { target: { value: "0xnew" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-mint", { args: ["0xnew", "1000"] });
  });
});

// ---------------------------------------------------------------------------
// setX step — target picker
// ---------------------------------------------------------------------------

describe("ConfigPanel — setX step (target picker)", () => {
  const dataWithSetX = makeData({
    deployId: "vault",
    contractName: "Vault",
    configSteps: [
      {
        kind: "setX",
        id: "step-t1",
        functionName: "",
        args: [],
      },
    ],
  });

  it("renders a target picker when deployTargets are provided", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[VAULT_TARGET, TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const select = screen.getByLabelText("setx-target-n1-step-t1") as HTMLSelectElement;
    expect(select).not.toBeNull();
    // Both deploy-ids should appear as options.
    expect(screen.getByRole("option", { name: /vault/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /token/ })).not.toBeNull();
  });

  it("does not render a target picker when deployTargets is empty", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={NO_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(() => screen.getByLabelText("setx-target-n1-step-t1")).toThrow();
  });

  it("calls onUpdateSetXStep with new target and cleared functionName when target changes", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[VAULT_TARGET, TOKEN_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const select = screen.getByLabelText("setx-target-n1-step-t1") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "token" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-t1", {
      target: "token",
      functionName: "",
      args: [],
    });
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
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
        deployTargets={NO_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByText("Contract ID")).not.toBeNull();
  });
});

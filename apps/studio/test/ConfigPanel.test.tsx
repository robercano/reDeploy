/**
 * ConfigPanel.test.tsx
 *
 * Tests for the ConfigPanel component: rendering steps, editing fields,
 * adding and removing steps.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
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
  it("renders exactly ONE 'Add config call' button and no old +setX/+grantRole buttons", () => {
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
    expect(screen.getAllByText("Add config call")).toHaveLength(1);
    expect(screen.queryByText("+ setX")).toBeNull();
    expect(screen.queryByText("+ grantRole")).toBeNull();
  });

  it("picker lists the attached contract's REAL state-changing functions (Vault), not synthetic setX/grantRole", () => {
    // data.contractName defaults to "Vault" (makeData()), whose real
    // nonpayable/payable functions are: deposit, withdraw, setFeeBps, pause,
    // unpause, setRegistry, grantRole, revokeRole, renounceRole (in manifest
    // order). view/pure functions (balanceOf, paused, hasRole, ...) and the
    // constructor are never listed. grantRole is NOT special-cased — it just
    // appears because Vault's ABI (via AccessControl) declares it.
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
    fireEvent.click(screen.getByText("Add config call"));
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "deposit(uint256)",
      "withdraw(uint256)",
      "setFeeBps(uint16)",
      "pause()",
      "unpause()",
      "setRegistry(address)",
      "grantRole(bytes32,address)",
      "revokeRole(bytes32,address)",
      "renounceRole(bytes32,address)",
    ]);
    // No literal synthetic "setX" menu entry.
    expect(within(menu).queryByText("setX")).toBeNull();
  });

  it("calls onAddStep with the chosen function's manifest entry when a real function is selected", () => {
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
    fireEvent.click(screen.getByText("Add config call"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "setFeeBps(uint16)" }));
    expect(onAddStep).toHaveBeenCalledTimes(1);
    const [nodeId, fn] = onAddStep.mock.calls[0];
    expect(nodeId).toBe("n1");
    expect(fn.name).toBe("setFeeBps");
    expect(fn.signature).toBe("setFeeBps(uint16)");
    expect(fn.inputs).toEqual([{ name: "bps", type: "uint16" }]);
  });

  it("calls onAddStep with grantRole's manifest entry (real function, not a synthetic kind) when grantRole is selected", () => {
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
    fireEvent.click(screen.getByText("Add config call"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "grantRole(bytes32,address)" }));
    expect(onAddStep).toHaveBeenCalledTimes(1);
    const [nodeId, fn] = onAddStep.mock.calls[0];
    expect(nodeId).toBe("n1");
    expect(fn.name).toBe("grantRole");
    expect(fn.signature).toBe("grantRole(bytes32,address)");
    expect(fn.inputs).toEqual([
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ]);
  });

  it("excludes view/pure functions from the picker", () => {
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
    fireEvent.click(screen.getByText("Add config call"));
    const menu = screen.getByRole("menu");
    for (const viewFn of ["balanceOf", "paused", "hasRole", "getRoleAdmin", "supportsInterface"]) {
      expect(within(menu).queryAllByRole("menuitem", { name: new RegExp(`^${viewFn}\\(`) })).toHaveLength(0);
    }
  });

  it("shows a 'No functions available' empty state and never crashes when the contract isn't in the manifest", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={makeData({ contractName: "UnknownContract" })}
        deployTargets={NO_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Add config call"));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryAllByRole("menuitem")).toHaveLength(0);
    expect(within(menu).getByText("No functions available")).not.toBeNull();
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
    // The select value is now the canonical signature, not the bare name.
    fireEvent.change(select, { target: { value: "mint(address,uint256)" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-m1", {
      functionName: "mint",
      functionSignature: "mint(address,uint256)",
      args: [],
    });
  });
});

// ---------------------------------------------------------------------------
// setX step — arg slot labels derived from manifest inputs
// ---------------------------------------------------------------------------

describe("ConfigPanel — setX step (manifest arg labels: Token.mint)", () => {
  // Step with mint selected — has inputs: [to: address, amount: uint256]
  // The functionSignature must be set to get per-input arg labels.
  const dataWithMint = makeData({
    deployId: "token",
    contractName: "Token",
    configSteps: [
      {
        kind: "setX",
        id: "step-mint",
        functionName: "mint",
        functionSignature: "mint(address,uint256)",
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

  it("defaults target picker to the node's own deployId when step.target is undefined", () => {
    // The node's deployId is "vault"; step.target is undefined — picker should show "vault".
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
    // The picker value must match the node's own deployId ("vault"), matching
    // what graph-to-spec.ts serializes as `step.target ?? targetId`.
    expect(select.value).toBe("vault");
  });
});

// ---------------------------------------------------------------------------
// setX step — default target regression: two nodes with the same contractName
// ---------------------------------------------------------------------------

describe("ConfigPanel — setX step (default target regression: same contractName, two nodes)", () => {
  /**
   * Regression: when two graph nodes share the same contractName (e.g. two Token
   * deploys "token1" and "token2") a contractName-based .find() would always
   * resolve to the FIRST node's deployId. The correct default is the ATTACHED
   * node's own deployId, not a contractName lookup.
   */

  // Two Token deploy targets with different deploy-ids but the same contractName.
  const TOKEN1_TARGET: DeployTarget = { deployId: "token1", contractName: "Token" };
  const TOKEN2_TARGET: DeployTarget = { deployId: "token2", contractName: "Token" };
  const ALL_TARGETS: DeployTarget[] = [TOKEN1_TARGET, TOKEN2_TARGET];

  it("shows the SECOND node's own deployId as default when step is attached to the second node", () => {
    // The step is attached to the node whose deployId is "token2".
    const dataToken2 = makeData({
      deployId: "token2",
      contractName: "Token",
      configSteps: [
        {
          kind: "setX",
          id: "step-reg",
          functionName: "",
          args: [],
          // step.target is intentionally undefined — default must resolve to "token2"
        },
      ],
    });

    render(
      <ConfigPanel
        nodeId="n2"
        data={dataToken2}
        deployTargets={ALL_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );

    const select = screen.getByLabelText("setx-target-n2-step-reg") as HTMLSelectElement;
    // Must be "token2" — NOT "token1" (which is what a contractName-based .find() would return).
    expect(select.value).toBe("token2");
  });

  it("shows the FIRST node's own deployId as default when step is attached to the first node", () => {
    const dataToken1 = makeData({
      deployId: "token1",
      contractName: "Token",
      configSteps: [
        {
          kind: "setX",
          id: "step-reg1",
          functionName: "",
          args: [],
        },
      ],
    });

    render(
      <ConfigPanel
        nodeId="n1"
        data={dataToken1}
        deployTargets={ALL_TARGETS}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );

    const select = screen.getByLabelText("setx-target-n1-step-reg1") as HTMLSelectElement;
    expect(select.value).toBe("token1");
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
// setX step — overloaded function picker (Overloaded contract)
// ---------------------------------------------------------------------------
// Tests use the Overloaded contract from src/Overloaded.sol which has:
//   TWO setLimit overloads: setLimit(uint256) and setLimit(uint256,address).
// When the name is overloaded, the picker must show full signatures as labels
// and use the signature as the option value.

const OVERLOADED_TARGET: DeployTarget = { deployId: "overloaded", contractName: "Overloaded" };

describe("ConfigPanel — setX step (overloaded functions: Overloaded contract)", () => {
  const dataWithSetX = makeData({
    deployId: "overloaded",
    contractName: "Overloaded",
    configSteps: [
      {
        kind: "setX",
        id: "step-ol",
        functionName: "",
        args: [],
      },
    ],
  });

  it("renders a function <select> for Overloaded contract", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[OVERLOADED_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    expect(screen.getByLabelText("setx-function-select-n1-step-ol")).not.toBeNull();
  });

  it("shows both setLimit overloads as distinct options using full signature labels", () => {
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[OVERLOADED_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    // Both full-signature options must be present (overload labels).
    const opt1 = screen.getByRole("option", { name: "setLimit(uint256)" });
    expect(opt1).not.toBeNull();
    const opt2 = screen.getByRole("option", { name: "setLimit(uint256,address)" });
    expect(opt2).not.toBeNull();
  });

  it("selecting setLimit(uint256) calls onUpdateSetXStep with signature", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[OVERLOADED_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const select = screen.getByLabelText("setx-function-select-n1-step-ol") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "setLimit(uint256)" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-ol", {
      functionName: "setLimit",
      functionSignature: "setLimit(uint256)",
      args: [],
    });
  });

  it("selecting setLimit(uint256,address) calls onUpdateSetXStep with that signature", () => {
    const onUpdateSetXStep = vi.fn();
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSetX}
        deployTargets={[OVERLOADED_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={onUpdateSetXStep}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const select = screen.getByLabelText("setx-function-select-n1-step-ol") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "setLimit(uint256,address)" } });
    expect(onUpdateSetXStep).toHaveBeenCalledWith("n1", "step-ol", {
      functionName: "setLimit",
      functionSignature: "setLimit(uint256,address)",
      args: [],
    });
  });

  it("arg labels resolve to correct inputs when setLimit(uint256,address) is selected", () => {
    const dataWithSignature = makeData({
      deployId: "overloaded",
      contractName: "Overloaded",
      configSteps: [
        {
          kind: "setX",
          id: "step-ol2",
          functionName: "setLimit",
          functionSignature: "setLimit(uint256,address)",
          args: ["100", "0xabc"],
        },
      ],
    });
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSignature}
        deployTargets={[OVERLOADED_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const arg0 = screen.getByLabelText("setx-arg-n1-step-ol2-0") as HTMLInputElement;
    expect(arg0.placeholder).toBe("uint256");
    const arg1 = screen.getByLabelText("setx-arg-n1-step-ol2-1") as HTMLInputElement;
    expect(arg1.placeholder).toBe("address");
  });

  it("arg labels resolve to correct inputs when setLimit(uint256) is selected", () => {
    const dataWithSignature = makeData({
      deployId: "overloaded",
      contractName: "Overloaded",
      configSteps: [
        {
          kind: "setX",
          id: "step-ol3",
          functionName: "setLimit",
          functionSignature: "setLimit(uint256)",
          args: ["42"],
        },
      ],
    });
    render(
      <ConfigPanel
        nodeId="n1"
        data={dataWithSignature}
        deployTargets={[OVERLOADED_TARGET]}
        onAddStep={() => {}}
        onRemoveStep={() => {}}
        onUpdateSetXStep={() => {}}
        onUpdateGrantRoleStep={() => {}}
      />,
    );
    const arg0 = screen.getByLabelText("setx-arg-n1-step-ol3-0") as HTMLInputElement;
    expect(arg0.placeholder).toBe("uint256");
    // Only one arg for the one-arg overload.
    expect(() => screen.getByLabelText("setx-arg-n1-step-ol3-1")).toThrow();
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

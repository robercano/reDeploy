/**
 * plan-diff.test.ts
 *
 * Unit tests for the pure dry-run plan/diff module (issue #101).
 */

import { describe, it, expect } from "vitest";
import { computePlan } from "../src/spec/plan-diff";
import type { DeploymentSpec } from "@redeploy/core/spec";
import type { ConfigSpec } from "@redeploy/config/steps";
import type { DeploymentView } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spec(contracts: DeploymentSpec["contracts"]): DeploymentSpec {
  return { version: 1, contracts };
}

function emptyConfig(overrides: Partial<ConfigSpec> = {}): ConfigSpec {
  return { version: 1, steps: [], orderedSteps: [], ...overrides };
}

function view(overrides: Partial<DeploymentView> = {}): DeploymentView {
  return { contracts: [], configSteps: [], warnings: [], ...overrides };
}

// ---------------------------------------------------------------------------
// All-create (current === null)
// ---------------------------------------------------------------------------

describe("computePlan — no current state (current === null)", () => {
  it("marks every contract and config step as create, and sets noCurrentState", () => {
    const desired = spec([
      { id: "token", contract: "Token", args: [{ kind: "literal", value: "MTK" }] },
      { id: "vault", contract: "Vault" },
    ]);
    const config = emptyConfig({
      steps: [{ kind: "setX", id: "set-fee", target: "vault", function: "setFee" }],
    });

    const plan = computePlan(desired, config, null);

    expect(plan.noCurrentState).toBe(true);
    expect(plan.contracts).toEqual([
      { id: "token", contractName: "Token", action: "create" },
      { id: "vault", contractName: "Vault", action: "create" },
    ]);
    expect(plan.configSteps).toEqual([{ id: "set-fee", kind: "setX", action: "create" }]);
    expect(plan.summary).toEqual({
      toCreate: 2,
      toSkip: 0,
      toChange: 0,
      configToCreate: 1,
      configToSkip: 0,
    });
    expect(plan.orphanContracts).toEqual([]);
    expect(plan.orphanConfigSteps).toEqual([]);
  });

  it("handles an empty desired spec cleanly", () => {
    const plan = computePlan(spec([]), emptyConfig(), null);
    expect(plan.contracts).toEqual([]);
    expect(plan.configSteps).toEqual([]);
    expect(plan.summary).toEqual({
      toCreate: 0,
      toSkip: 0,
      toChange: 0,
      configToCreate: 0,
      configToSkip: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// All-skip (identical desired vs. current)
// ---------------------------------------------------------------------------

describe("computePlan — identical desired vs. current", () => {
  it("marks every contract skip when address present and args/name unchanged", () => {
    const desired = spec([
      {
        id: "token",
        contract: "Token",
        args: [
          { kind: "literal", value: "MTK" },
          { kind: "literal", value: 18 },
        ],
      },
    ]);
    const current = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: ["MTK", 18],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);

    expect(plan.contracts).toEqual([{ id: "token", contractName: "Token", action: "skip" }]);
    expect(plan.summary.toSkip).toBe(1);
    expect(plan.summary.toCreate).toBe(0);
    expect(plan.summary.toChange).toBe(0);
    expect(plan.noCurrentState).toBe(false);
  });

  it("marks a config step skip when completed in current", () => {
    const config = emptyConfig({
      steps: [{ kind: "setX", id: "set-fee", target: "vault", function: "setFee" }],
    });
    const current = view({
      configSteps: [{ id: "set-fee", kind: "setX", completed: true, completedAt: "2026-01-01T00:00:00Z" }],
    });

    const plan = computePlan(spec([]), config, current);

    expect(plan.configSteps).toEqual([{ id: "set-fee", kind: "setX", action: "skip" }]);
    expect(plan.summary.configToSkip).toBe(1);
    expect(plan.summary.configToCreate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed create / skip / change
// ---------------------------------------------------------------------------

describe("computePlan — mixed create/skip/change", () => {
  it("classifies each contract correctly in a mixed graph", () => {
    const desired = spec([
      // Not in current at all -> create
      { id: "brandNew", contract: "Widget" },
      // In current, address present, unchanged -> skip
      { id: "stable", contract: "Registry" },
      // In current, but address null (partial deploy) -> create
      { id: "partial", contract: "Vault" },
      // In current, args differ -> change
      { id: "argsChanged", contract: "Token", args: [{ kind: "literal", value: "NEW" }] },
    ]);

    const current = view({
      contracts: [
        {
          id: "stable",
          contractName: "Registry",
          address: "0x1",
          args: [],
          links: { dependencies: [], libraries: {} },
        },
        {
          id: "partial",
          contractName: "Vault",
          address: null,
          args: [],
          links: { dependencies: [], libraries: {} },
        },
        {
          id: "argsChanged",
          contractName: "Token",
          address: "0x2",
          args: ["OLD"],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);

    const byId = new Map(plan.contracts.map((c) => [c.id, c]));
    expect(byId.get("brandNew")?.action).toBe("create");
    expect(byId.get("stable")?.action).toBe("skip");
    expect(byId.get("partial")?.action).toBe("create");
    expect(byId.get("argsChanged")?.action).toBe("change");
    expect(byId.get("argsChanged")?.changes).toEqual(["args[0] changed"]);

    expect(plan.summary).toEqual({
      toCreate: 2,
      toSkip: 1,
      toChange: 1,
      configToCreate: 0,
      configToSkip: 0,
    });
  });

  it("classifies config steps correctly in a mixed set", () => {
    const config = emptyConfig({
      steps: [
        { kind: "setX", id: "done-step", target: "vault", function: "setFee" },
        { kind: "setX", id: "pending-step", target: "vault", function: "setLimit" },
      ],
      orderedSteps: [
        { kind: "wire", id: "wire-step", source: "token", into: "vault", function: "setToken" },
      ],
    });
    const current = view({
      configSteps: [
        { id: "done-step", kind: "setX", completed: true, completedAt: "2026-01-01T00:00:00Z" },
        { id: "pending-step", kind: "setX", completed: false, completedAt: null },
      ],
    });

    const plan = computePlan(spec([]), config, current);

    const byId = new Map(plan.configSteps.map((s) => [s.id, s]));
    expect(byId.get("done-step")?.action).toBe("skip");
    expect(byId.get("pending-step")?.action).toBe("create");
    // Not present in current at all -> create.
    expect(byId.get("wire-step")?.action).toBe("create");

    expect(plan.summary.configToCreate).toBe(2);
    expect(plan.summary.configToSkip).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// contractName changes
// ---------------------------------------------------------------------------

describe("computePlan — contractName changes", () => {
  it("flags a contractName change even when args are unchanged", () => {
    const desired = spec([{ id: "token", contract: "TokenV2" }]);
    const current = view({
      contracts: [
        {
          id: "token",
          contractName: "TokenV1",
          address: "0xabc",
          args: [],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);

    expect(plan.contracts[0].action).toBe("change");
    expect(plan.contracts[0].changes).toEqual([
      'contractName changed: "TokenV1" -> "TokenV2"',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Argument change detection details
// ---------------------------------------------------------------------------

describe("computePlan — argument diff details", () => {
  it("flags an argument count change with a single summary entry", () => {
    const desired = spec([
      {
        id: "token",
        contract: "Token",
        args: [
          { kind: "literal", value: "MTK" },
          { kind: "literal", value: 18 },
        ],
      },
    ]);
    const current = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: ["MTK"],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);
    expect(plan.contracts[0].action).toBe("change");
    expect(plan.contracts[0].changes).toEqual(["argument count changed (1 -> 2)"]);
  });

  it("treats a bigint-tagged current value as equal to a matching literal number/string", () => {
    const desired = spec([
      {
        id: "token",
        contract: "Token",
        args: [{ kind: "literal", value: 1000 }],
      },
    ]);
    const current = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: [{ $bigint: "1000" }],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);
    expect(plan.contracts[0].action).toBe("skip");
  });

  it("flags a bigint current value as changed when the desired literal is not number/string", () => {
    const desired = spec([
      {
        id: "token",
        contract: "Token",
        args: [{ kind: "literal", value: true }],
      },
    ]);
    const current = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: [{ $bigint: "1" }],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);
    expect(plan.contracts[0].action).toBe("change");
    expect(plan.contracts[0].changes).toEqual(["args[0] changed"]);
  });

  it("flags a mismatched bigint value as changed", () => {
    const desired = spec([
      {
        id: "token",
        contract: "Token",
        args: [{ kind: "literal", value: 1000 }],
      },
    ]);
    const current = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: [{ $bigint: "2000" }],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);
    expect(plan.contracts[0].action).toBe("change");
    expect(plan.contracts[0].changes).toEqual(["args[0] changed"]);
  });

  it("compares array-valued literal args element-wise", () => {
    const desired = spec([
      {
        id: "token",
        contract: "Token",
        args: [{ kind: "literal", value: [1, 2, 3] }],
      },
    ]);
    const currentSame = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: [[1, 2, 3]],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });
    const currentDifferent = view({
      contracts: [
        {
          id: "token",
          contractName: "Token",
          address: "0xabc",
          args: [[1, 2, 4]],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    expect(computePlan(desired, emptyConfig(), currentSame).contracts[0].action).toBe("skip");
    expect(computePlan(desired, emptyConfig(), currentDifferent).contracts[0].action).toBe(
      "change",
    );
  });

  it("does not flag non-literal (ref/param/expr/resolver) arg slots as changed", () => {
    const desired = spec([
      {
        id: "vault",
        contract: "Vault",
        args: [
          { kind: "ref", contract: "token" },
          { kind: "param", name: "owner" },
          { kind: "expr", expression: "params.x * 2n" },
          { kind: "resolver", name: "computeSalt" },
        ],
      },
    ]);
    const current = view({
      contracts: [
        {
          id: "vault",
          contractName: "Vault",
          address: "0xabc",
          // Whatever these actually resolved to on-chain — irrelevant, since
          // none of these arg kinds are statically comparable (v1 limitation).
          args: ["0xdeadbeef", "0xowner", { $bigint: "42" }, "some-salt"],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(desired, emptyConfig(), current);
    expect(plan.contracts[0].action).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Orphans — present in current but absent from desired
// ---------------------------------------------------------------------------

describe("computePlan — orphans (present in current, absent from desired)", () => {
  it("surfaces an orphan contract informationally, not as an action", () => {
    const current = view({
      contracts: [
        {
          id: "abandoned",
          contractName: "OldThing",
          address: "0xdead",
          args: [],
          links: { dependencies: [], libraries: {} },
        },
      ],
    });

    const plan = computePlan(spec([]), emptyConfig(), current);

    expect(plan.contracts).toEqual([]);
    expect(plan.orphanContracts).toEqual([
      { id: "abandoned", contractName: "OldThing", address: "0xdead" },
    ]);
    // Orphans never contribute to the actioned summary counts.
    expect(plan.summary).toEqual({
      toCreate: 0,
      toSkip: 0,
      toChange: 0,
      configToCreate: 0,
      configToSkip: 0,
    });
  });

  it("surfaces an orphan config step informationally, not as an action", () => {
    const current = view({
      configSteps: [{ id: "old-step", kind: "setX", completed: true, completedAt: "2026-01-01T00:00:00Z" }],
    });

    const plan = computePlan(spec([]), emptyConfig(), current);

    expect(plan.configSteps).toEqual([]);
    expect(plan.orphanConfigSteps).toEqual([{ id: "old-step", kind: "setX" }]);
  });
});

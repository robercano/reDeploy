import { describe, it, expect } from "vitest";
import type { ConfigStep } from "@redeploy/config";
import { deriveReads } from "../../src/verify/derive-reads.js";

describe("deriveReads", () => {
  it("grantRole steps are always includable, with no read descriptor", () => {
    const step: ConfigStep = {
      kind: "grantRole",
      id: "grant-minter",
      target: "token",
      role: "MINTER_ROLE",
      account: { kind: "ref", contract: "minter" },
    };
    const { includable, reads, skipped } = deriveReads([step]);
    expect(includable).toEqual([step]);
    expect(reads).toEqual({});
    expect(skipped).toEqual([]);
  });

  it("setX with a bare 'setFoo' name and exactly one arg derives 'getFoo'", () => {
    const step: ConfigStep = {
      kind: "setX",
      id: "set-fee",
      target: "feeController",
      function: "setFee",
      args: [{ kind: "literal", value: 500 }],
    };
    const { includable, reads, skipped } = deriveReads([step]);
    expect(includable).toEqual([step]);
    expect(reads).toEqual({ "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } } });
    expect(skipped).toEqual([]);
  });

  it("setX with a canonical signature strips the parameter list before deriving", () => {
    const step: ConfigStep = {
      kind: "setX",
      id: "set-limit",
      target: "vault",
      function: "setLimit(uint256)",
      args: [{ kind: "literal", value: 1000 }],
    };
    const { reads } = deriveReads([step]);
    expect(reads["set-limit"]).toEqual({ function: "getLimit", expected: { kind: "literal", value: 1000 } });
  });

  it("setX with a non-'set' function name is skipped", () => {
    const step: ConfigStep = {
      kind: "setX",
      id: "update-fee",
      target: "feeController",
      function: "updateFee",
      args: [{ kind: "literal", value: 500 }],
    };
    const { includable, skipped } = deriveReads([step]);
    expect(includable).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe("update-fee");
    expect(skipped[0]!.reason).toContain("naming convention");
  });

  it("setX with zero args is skipped (no expected value to derive)", () => {
    const step: ConfigStep = { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" };
    const { includable, skipped } = deriveReads([step]);
    expect(includable).toEqual([]);
    expect(skipped[0]!.reason).toContain("0 argument");
  });

  it("setX with more than one arg is skipped (ambiguous expected value)", () => {
    const step: ConfigStep = {
      kind: "setX",
      id: "set-limit",
      target: "vault",
      function: "setLimit",
      args: [
        { kind: "literal", value: 1000 },
        { kind: "ref", contract: "token" },
      ],
    };
    const { includable, skipped } = deriveReads([step]);
    expect(includable).toEqual([]);
    expect(skipped[0]!.reason).toContain("2 argument");
  });

  it("wire with a bare 'setFoo' name derives 'getFoo' with no expected field", () => {
    const step: ConfigStep = {
      kind: "wire",
      id: "wire-token-into-vault",
      source: "token",
      into: "vault",
      function: "setToken",
    };
    const { includable, reads, skipped } = deriveReads([step]);
    expect(includable).toEqual([step]);
    expect(reads).toEqual({ "wire-token-into-vault": { function: "getToken" } });
    expect(skipped).toEqual([]);
  });

  it("wire with a non-'set' function name is skipped", () => {
    const step: ConfigStep = {
      kind: "wire",
      id: "wire-token-into-vault",
      source: "token",
      into: "vault",
      function: "registerToken",
    };
    const { includable, skipped } = deriveReads([step]);
    expect(includable).toEqual([]);
    expect(skipped[0]!.reason).toContain("naming convention");
  });

  it("mixed batch: partitions includable vs skipped independently per step", () => {
    const steps: ConfigStep[] = [
      { kind: "setX", id: "set-fee", target: "a", function: "setFee", args: [{ kind: "literal", value: 1 }] },
      { kind: "setX", id: "update-x", target: "a", function: "updateX", args: [{ kind: "literal", value: 1 }] },
      { kind: "grantRole", id: "grant", target: "a", role: "R", account: { kind: "literal", value: "0x1" } },
    ];
    const { includable, skipped } = deriveReads(steps);
    expect(includable.map((s) => s.id)).toEqual(["set-fee", "grant"]);
    expect(skipped.map((s) => s.id)).toEqual(["update-x"]);
  });
});

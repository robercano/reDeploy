import { describe, it, expect } from "vitest";
import type { ConfigStep } from "@redeploy/config";
import { collectRequiredIds, findUnresolvedRef } from "../../src/verify/step-refs.js";

describe("collectRequiredIds", () => {
  it("setX: returns target plus any ref args", () => {
    const step: ConfigStep = {
      kind: "setX",
      id: "set-fee",
      target: "feeController",
      function: "setFee",
      args: [
        { kind: "literal", value: 500 },
        { kind: "ref", contract: "treasury" },
      ],
    };
    expect(collectRequiredIds(step)).toEqual(["feeController", "treasury"]);
  });

  it("setX: returns just target when there are no ref args", () => {
    const step: ConfigStep = { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" };
    expect(collectRequiredIds(step)).toEqual(["feeController"]);
  });

  it("grantRole: returns target plus account when account is a ref", () => {
    const step: ConfigStep = {
      kind: "grantRole",
      id: "grant-minter",
      target: "token",
      role: "MINTER_ROLE",
      account: { kind: "ref", contract: "minter" },
    };
    expect(collectRequiredIds(step)).toEqual(["token", "minter"]);
  });

  it("grantRole: returns just target when account is a literal", () => {
    const step: ConfigStep = {
      kind: "grantRole",
      id: "grant-minter",
      target: "token",
      role: "MINTER_ROLE",
      account: { kind: "literal", value: "0xabc" },
    };
    expect(collectRequiredIds(step)).toEqual(["token"]);
  });

  it("wire: returns source and into", () => {
    const step: ConfigStep = {
      kind: "wire",
      id: "wire-token-into-vault",
      source: "token",
      into: "vault",
      function: "setToken",
    };
    expect(collectRequiredIds(step)).toEqual(["token", "vault"]);
  });
});

describe("findUnresolvedRef", () => {
  it("returns null when every referenced id is deployed", () => {
    const step: ConfigStep = { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" };
    expect(findUnresolvedRef(step, { feeController: "0x1" })).toBeNull();
  });

  it("returns the first missing id when target is undeployed", () => {
    const step: ConfigStep = { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" };
    expect(findUnresolvedRef(step, {})).toBe("feeController");
  });

  it("returns the missing ref-arg id when target resolves but an arg ref doesn't", () => {
    const step: ConfigStep = {
      kind: "setX",
      id: "register-token",
      target: "registry",
      function: "register",
      args: [{ kind: "ref", contract: "token" }],
    };
    expect(findUnresolvedRef(step, { registry: "0x1" })).toBe("token");
  });

  it("wire: returns 'into' when source resolves but into doesn't", () => {
    const step: ConfigStep = {
      kind: "wire",
      id: "wire-token-into-vault",
      source: "token",
      into: "vault",
      function: "setToken",
    };
    expect(findUnresolvedRef(step, { token: "0x1" })).toBe("vault");
  });
});

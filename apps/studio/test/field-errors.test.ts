/**
 * field-errors.test.ts
 *
 * Unit tests for the error-path parser and per-node field error mapping
 * (issue #83).
 *
 * Covered:
 * - parseErrorPath: id / arg / bare-contract / after / unmappable paths.
 * - buildNodeFieldErrors: positional contractIndex → nodeId mapping,
 *   multiple errors on the same node, out-of-range indices, unmappable paths.
 */

import { describe, it, expect } from "vitest";
import {
  parseErrorPath,
  buildNodeFieldErrors,
  validateConstructorArgs,
  EMPTY_ARG_CODE,
} from "../src/deploy/field-errors.js";
import type { StructuredDeployError } from "../src/deploy/field-errors.js";
import type { DeploymentSpec } from "@redeploy/core/spec";

// ---------------------------------------------------------------------------
// parseErrorPath
// ---------------------------------------------------------------------------

describe("parseErrorPath", () => {
  it("parses a contracts[i].id path", () => {
    expect(parseErrorPath("contracts[0].id")).toEqual({ kind: "id", contractIndex: 0 });
    expect(parseErrorPath("contracts[3].id")).toEqual({ kind: "id", contractIndex: 3 });
  });

  it("parses a contracts[i].args[j] path", () => {
    expect(parseErrorPath("contracts[2].args[0]")).toEqual({
      kind: "arg",
      contractIndex: 2,
      argIndex: 0,
    });
  });

  it("parses a contracts[i].args[j].contract sub-path as the same arg slot", () => {
    // e.g. an invalid ref arg's target contract — still maps to the arg slot.
    expect(parseErrorPath("contracts[2].args[0].contract")).toEqual({
      kind: "arg",
      contractIndex: 2,
      argIndex: 0,
    });
  });

  it("parses a bare contracts[i] path as node-level", () => {
    expect(parseErrorPath("contracts[5]")).toEqual({ kind: "contract", contractIndex: 5 });
  });

  it("parses a contracts[i].after[k] path as node-level (no more specific field)", () => {
    expect(parseErrorPath("contracts[1].after[1]")).toEqual({
      kind: "contract",
      contractIndex: 1,
    });
  });

  it("returns null for an undefined path", () => {
    expect(parseErrorPath(undefined)).toBeNull();
  });

  it("returns null for an empty string path", () => {
    expect(parseErrorPath("")).toBeNull();
  });

  it("returns null for a path that doesn't start with contracts[", () => {
    expect(parseErrorPath("config.steps[0].function")).toBeNull();
    expect(parseErrorPath("some free-text description")).toBeNull();
  });

  it("prefers the .id classification over the generic contract-index match", () => {
    const parsed = parseErrorPath("contracts[7].id");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("id");
  });

  it("prefers the .args[] classification over the generic contract-index match", () => {
    const parsed = parseErrorPath("contracts[7].args[3]");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("arg");
    if (parsed!.kind === "arg") {
      expect(parsed!.argIndex).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// buildNodeFieldErrors
// ---------------------------------------------------------------------------

describe("buildNodeFieldErrors", () => {
  it("maps a contracts[0].id error to the deployId field of the first node", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].id", message: "contract entry id must be a non-empty string" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a", "node-b"]);

    expect(result.get("node-a")).toEqual({
      deployId: "contract entry id must be a non-empty string",
    });
    expect(result.has("node-b")).toBe(false);
  });

  it("maps a contracts[i].args[j] error to the correct arg slot of the correct node", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[1].args[2]", message: "arg must be a valid literal or ref" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a", "node-b", "node-c"]);

    expect(result.get("node-b")).toEqual({ args: { 2: "arg must be a valid literal or ref" } });
    expect(result.has("node-a")).toBe(false);
    expect(result.has("node-c")).toBe(false);
  });

  it("maps a node-only-mappable error (bare contracts[i]) to the node field", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0]", message: "duplicate deploy id across contracts" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({ node: "duplicate deploy id across contracts" });
  });

  it("maps a contracts[i].after[k] error to the node field (no more specific field)", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].after[1]", message: "after references an unknown contract id" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({ node: "after references an unknown contract id" });
  });

  it("skips errors with an unmappable/absent path (banner-only fallback)", () => {
    const errors: StructuredDeployError[] = [
      { message: "network error: connection refused" },
      { path: "some free-text path", message: "not a contract path" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.size).toBe(0);
  });

  it("skips errors whose contractIndex is out of range for the current nodes array", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[5].id", message: "id must be non-empty" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.size).toBe(0);
  });

  it("merges multiple errors that map to the same node into one entry", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].id", message: "id must be non-empty" },
      { path: "contracts[0].args[0]", message: "arg 0 is invalid" },
      { path: "contracts[0].args[1]", message: "arg 1 is invalid" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({
      deployId: "id must be non-empty",
      args: { 0: "arg 0 is invalid", 1: "arg 1 is invalid" },
    });
  });

  it("keeps the first node-level message when multiple errors map to the same node-level field", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0]", message: "first node-level error" },
      { path: "contracts[0].after[0]", message: "second node-level error" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({ node: "first node-level error" });
  });

  it("maps errors across multiple distinct nodes independently", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].id", message: "token id invalid" },
      { path: "contracts[1].args[0]", message: "vault arg 0 invalid" },
    ];
    const result = buildNodeFieldErrors(errors, ["token", "vault"]);

    expect(result.get("token")).toEqual({ deployId: "token id invalid" });
    expect(result.get("vault")).toEqual({ args: { 0: "vault arg 0 invalid" } });
  });

  it("returns an empty map when given no errors", () => {
    const result = buildNodeFieldErrors([], ["node-a"]);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateConstructorArgs (issue #83 follow-up: empty-arg pre-validation)
// ---------------------------------------------------------------------------

describe("validateConstructorArgs", () => {
  it("flags a literal null arg (what an empty raw input parses to)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "ERC20Token", args: [{ kind: "literal", value: null }] },
      ],
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toEqual([
      {
        code: EMPTY_ARG_CODE,
        path: "contracts[0].args[0]",
        message: "constructor argument must have a value",
      },
    ]);
  });

  it("flags a literal whitespace-only string arg", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "ERC20Token", args: [{ kind: "literal", value: "   " }] },
      ],
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("contracts[0].args[0]");
  });

  it("does not flag a filled literal arg (including falsy-but-real values)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "ERC20Token",
          args: [
            { kind: "literal", value: "USD Coin" },
            { kind: "literal", value: 0 },
            { kind: "literal", value: false },
          ],
        },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });

  it("does not flag a ref (edge-bound) arg regardless of its resolved value", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "ERC20Token" },
        { id: "vault", contract: "Vault", args: [{ kind: "ref", contract: "token" }] },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });

  it("flags multiple empty args across multiple contracts, each with its own path", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "ERC20Token",
          args: [
            { kind: "literal", value: null },
            { kind: "literal", value: "Gold" },
          ],
        },
        {
          id: "vault",
          contract: "Vault",
          args: [
            { kind: "ref", contract: "token" },
            { kind: "literal", value: null },
          ],
        },
      ],
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toEqual([
      {
        code: EMPTY_ARG_CODE,
        path: "contracts[0].args[0]",
        message: "constructor argument must have a value",
      },
      {
        code: EMPTY_ARG_CODE,
        path: "contracts[1].args[1]",
        message: "constructor argument must have a value",
      },
    ]);
  });

  it("returns no errors for contracts with no args", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "token", contract: "ERC20Token" }],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Manifest-anchored arity (issue #83, 2nd follow-up): catch slots MISSING
  // from a node entirely (not just blank literals in slots that exist). Uses
  // the real "Token" manifest entry (constructor: name_, symbol_ — arity 2).
  // -------------------------------------------------------------------------

  it("flags a node-level error when a real manifest contract has FEWER arg slots than its constructor arity", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "literal", value: "MyToken" }], // only 1 of 2 (symbol_ missing)
        },
      ],
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toEqual([
      {
        code: EMPTY_ARG_CODE,
        path: "contracts[0]",
        message: "constructor parameter(s) missing a value",
      },
    ]);
  });

  it("flags a node-level error when a real manifest contract has NO arg slots at all", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "token", contract: "Token" }], // args omitted entirely (arity 2)
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toEqual([
      {
        code: EMPTY_ARG_CODE,
        path: "contracts[0]",
        message: "constructor parameter(s) missing a value",
      },
    ]);
  });

  it("emits only ONE node-level error even when multiple manifest params are missing", () => {
    const spec: DeploymentSpec = {
      version: 1,
      // VaultERC4626's constructor has 4 params; supply none.
      contracts: [{ id: "vault4626", contract: "VaultERC4626" }],
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      code: EMPTY_ARG_CODE,
      path: "contracts[0]",
      message: "constructor parameter(s) missing a value",
    });
  });

  it("does not flag a real manifest contract whose slot count matches its constructor arity with real values", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "literal", value: "MyToken" },
            { kind: "literal", value: "MTK" },
          ],
        },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });

  it("still flags a blank literal within an existing slot for a real manifest contract (field-level, not node-level)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "literal", value: "MyToken" },
            { kind: "literal", value: null }, // symbol_ present but blank
          ],
        },
      ],
    };
    const errors = validateConstructorArgs(spec);
    expect(errors).toEqual([
      {
        code: EMPTY_ARG_CODE,
        path: "contracts[0].args[1]",
        message: "constructor argument must have a value",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// validateConstructorArgs — scripting arg kinds (issue #137)
// ---------------------------------------------------------------------------

describe("validateConstructorArgs — scripting arg kinds (issue #137)", () => {
  // "UnknownManifest" is not in the real contract manifest, so validateConstructorArgs
  // falls back to entry.args.length as the arity (see its doc) — keeps these
  // tests independent of the real fixture contracts' constructor shapes.

  it("flags a param arg with a blank name", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "c1", contract: "UnknownManifest", args: [{ kind: "param", name: "" }] },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([
      { code: EMPTY_ARG_CODE, path: "contracts[0].args[0]", message: "constructor argument must have a value" },
    ]);
  });

  it("does not flag a param arg with a non-blank name", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "c1", contract: "UnknownManifest", args: [{ kind: "param", name: "initialOwner" }] },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });

  it("flags an expr arg with a blank expression", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "c1", contract: "UnknownManifest", args: [{ kind: "expr", expression: "   " }] },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([
      { code: EMPTY_ARG_CODE, path: "contracts[0].args[0]", message: "constructor argument must have a value" },
    ]);
  });

  it("does not flag an expr arg with a non-blank expression", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "c1", contract: "UnknownManifest", args: [{ kind: "expr", expression: "1n + 2n" }] },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });

  it("flags a resolver arg with a blank name", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "c1", contract: "UnknownManifest", args: [{ kind: "resolver", name: "" }] },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([
      { code: EMPTY_ARG_CODE, path: "contracts[0].args[0]", message: "constructor argument must have a value" },
    ]);
  });

  it("does not flag a resolver arg with a non-blank name (with or without args)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c1",
          contract: "UnknownManifest",
          args: [
            { kind: "resolver", name: "readOracleDecimals" },
            { kind: "resolver", name: "computeSalt", args: ["v1", 42] },
          ],
        },
      ],
    };
    expect(validateConstructorArgs(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseErrorPath / buildNodeFieldErrors — deeper arg sub-paths (issue #137)
// ---------------------------------------------------------------------------

describe("parseErrorPath / buildNodeFieldErrors — scripting-kind error paths (issue #137)", () => {
  it("maps a core UNKNOWN_PARAM-style path (contracts[i].args[j].name) to the arg slot", () => {
    // Mirrors the real path shape validateSpec emits for UNKNOWN_PARAM
    // (spec/validate.ts: `${basePath}.args[${j}].name`).
    const parsed = parseErrorPath("contracts[1].args[0].name");
    expect(parsed).toEqual({ kind: "arg", contractIndex: 1, argIndex: 0 });
  });

  it("buildNodeFieldErrors maps an UNKNOWN_PARAM error to the correct node's arg slot", () => {
    const errors: StructuredDeployError[] = [
      {
        code: "UNKNOWN_PARAM",
        path: "contracts[0].args[0].name",
        message: 'references undeclared parameter "foo"',
      },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);
    expect(result.get("node-a")).toEqual({ args: { 0: 'references undeclared parameter "foo"' } });
  });
});

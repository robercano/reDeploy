import { describe, it, expect } from "vitest";
import {
  validateConfig,
  LITERAL_MAX_DEPTH,
} from "../src/index.js";
import type {
  ConfigSpec,
  ConfigResult,
  ConfigError,
} from "../src/index.js";
import type { DeploymentSpec } from "@redeploy/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid ConfigSpec with one of each step kind. */
const fullSpec: ConfigSpec = {
  version: 1,
  steps: [
    {
      kind: "setX",
      id: "set-fee",
      target: "feeController",
      function: "setFee",
      args: [{ kind: "literal", value: 500 }],
    },
    {
      kind: "grantRole",
      id: "grant-minter",
      target: "token",
      role: "MINTER_ROLE",
      account: { kind: "ref", contract: "minterContract" },
    },
    {
      kind: "wire",
      id: "wire-token-into-vault",
      source: "token",
      into: "vault",
      function: "setToken",
    },
  ],
};

/** A deployment spec that knows about the contracts in fullSpec. */
const deployment: DeploymentSpec = {
  version: 1,
  contracts: [
    { id: "feeController", contract: "FeeController" },
    { id: "token", contract: "Token" },
    { id: "minterContract", contract: "Minter" },
    { id: "vault", contract: "Vault" },
  ],
};

function errorCodes(result: ConfigResult): string[] {
  if (result.ok) return [];
  return result.errors.map((e: ConfigError) => e.code);
}

function errorPaths(result: ConfigResult): string[] {
  if (result.ok) return [];
  return result.errors.map((e: ConfigError) => e.path);
}

// ---------------------------------------------------------------------------
// VALID: minimal spec
// ---------------------------------------------------------------------------

describe("validateConfig — valid inputs", () => {
  it("accepts a minimal valid ConfigSpec with only version and empty steps", () => {
    const result = validateConfig({ version: 1, steps: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.version).toBe(1);
      expect(result.spec.steps).toHaveLength(0);
    }
  });

  it("accepts a setX step with no args", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "setX", id: "s1", target: "feeController", function: "setFee" }],
      },
      new Set(["feeController"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a setX step with literal args", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "setX",
            id: "s1",
            target: "feeController",
            function: "setFee",
            args: [{ kind: "literal", value: 500 }],
          },
        ],
      },
      new Set(["feeController"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a setX step with a ref arg that resolves", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "setX",
            id: "s1",
            target: "vault",
            function: "setToken",
            args: [{ kind: "ref", contract: "token" }],
          },
        ],
      },
      new Set(["vault", "token"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a grantRole step with a ref account that resolves", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "grantRole",
            id: "grant-minter",
            target: "token",
            role: "MINTER_ROLE",
            account: { kind: "ref", contract: "minterContract" },
          },
        ],
      },
      new Set(["token", "minterContract"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a grantRole step with a literal account", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "grantRole",
            id: "grant-admin",
            target: "token",
            role: "ADMIN_ROLE",
            account: { kind: "literal", value: "0x1234567890abcdef1234567890abcdef12345678" },
          },
        ],
      },
      new Set(["token"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a wire step with refs that resolve", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "wire", id: "wire1", source: "token", into: "vault", function: "setToken" }],
      },
      new Set(["token", "vault"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts one of each step kind with a DeploymentSpec deployment", () => {
    const result = validateConfig(fullSpec, deployment);
    expect(result.ok).toBe(true);
  });

  it("accepts a DeploymentSpec as the deployment input and resolves refs", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "setX", id: "s1", target: "feeController", function: "setFee" }],
      },
      deployment,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a string array as the deployment input", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "wire", id: "w1", source: "token", into: "vault", function: "setToken" }],
      },
      ["token", "vault"],
    );
    expect(result.ok).toBe(true);
  });

  it("skips ref-resolution when no deployment is provided (shape-only)", () => {
    // target "unknown-contract" does not exist in any deployment,
    // but with no deployment argument shape-only validation should pass.
    const result = validateConfig({
      version: 1,
      steps: [
        { kind: "setX", id: "s1", target: "unknown-contract", function: "setFee" },
        {
          kind: "grantRole",
          id: "s2",
          target: "nonexistent",
          role: "ADMIN",
          account: { kind: "ref", contract: "doesNotExist" },
        },
        { kind: "wire", id: "s3", source: "ghost", into: "phantom", function: "set" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts nested literal arrays up to depth limit", () => {
    // Build a literal with exactly LITERAL_MAX_DEPTH nesting — should be valid.
    let nestedLiteral: unknown = 42;
    for (let d = 0; d < LITERAL_MAX_DEPTH; d++) {
      nestedLiteral = [nestedLiteral];
    }
    const result = validateConfig({
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "s1",
          target: "c",
          function: "f",
          args: [{ kind: "literal", value: nestedLiteral }],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FAILURE MODES
// ---------------------------------------------------------------------------

describe("validateConfig — failure modes", () => {
  // --- Unknown step kind ---

  it("rejects an unknown step kind", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "unknownKind", id: "s1", target: "c", function: "f" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  // --- Missing required fields ---

  it("rejects a setX step missing 'function'", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "setX", id: "s1", target: "c" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects a setX step missing 'target'", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "setX", id: "s1", function: "setFee" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects a grantRole step missing 'role'", () => {
    const result = validateConfig({
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "s1",
          target: "token",
          account: { kind: "literal", value: "0x123" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects a grantRole step missing 'account'", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "grantRole", id: "s1", target: "token", role: "ADMIN" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects a wire step missing 'source'", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "wire", id: "s1", into: "vault", function: "setToken" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects a wire step missing 'into'", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "wire", id: "s1", source: "token", function: "setToken" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects a wire step missing 'function'", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "wire", id: "s1", source: "token", into: "vault" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  // --- Wrong types ---

  it("rejects id as a number instead of string", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "setX", id: 42, target: "c", function: "f" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects steps that is not an array", () => {
    const result = validateConfig({ version: 1, steps: "not-an-array" });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects wrong version number", () => {
    const result = validateConfig({ version: 2, steps: [] });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects null input", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects empty string input", () => {
    const result = validateConfig("");
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  // --- Empty string fields ---

  it("rejects an empty-string id", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "setX", id: "", target: "c", function: "f" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
    const paths = errorPaths(result);
    expect(paths.some((p) => p.includes("id"))).toBe(true);
  });

  it("rejects an empty-string target", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "setX", id: "s1", target: "", function: "f" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects an empty-string function name", () => {
    const result = validateConfig({
      version: 1,
      steps: [{ kind: "setX", id: "s1", target: "c", function: "" }],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("rejects an empty-string role in grantRole", () => {
    const result = validateConfig({
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "s1",
          target: "token",
          role: "",
          account: { kind: "literal", value: "0x123" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  // --- Duplicate step ids ---

  it("rejects duplicate step ids with DUPLICATE_STEP_ID", () => {
    const result = validateConfig({
      version: 1,
      steps: [
        { kind: "setX", id: "step-a", target: "c", function: "f" },
        { kind: "setX", id: "step-a", target: "d", function: "g" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("DUPLICATE_STEP_ID");
    const dupError = (result as { ok: false; errors: ConfigError[] }).errors.find(
      (e) => e.code === "DUPLICATE_STEP_ID",
    );
    expect(dupError?.path).toBe("steps[1].id");
    expect(dupError?.message).toContain("step-a");
  });

  it("collects multiple DUPLICATE_STEP_ID errors for more than two duplicates", () => {
    const result = validateConfig({
      version: 1,
      steps: [
        { kind: "setX", id: "dup", target: "c", function: "f" },
        { kind: "setX", id: "dup", target: "c", function: "f" },
        { kind: "setX", id: "dup", target: "c", function: "f" },
      ],
    });
    expect(result.ok).toBe(false);
    const codes = errorCodes(result);
    expect(codes.filter((c) => c === "DUPLICATE_STEP_ID")).toHaveLength(2);
  });

  // --- MISSING_REF ---

  it("emits MISSING_REF when setX target is not in the deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "setX", id: "s1", target: "unknownContract", function: "setFee" }],
      },
      new Set(["feeController"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_REF");
    const refErr = (result as { ok: false; errors: ConfigError[] }).errors.find(
      (e) => e.code === "MISSING_REF",
    );
    expect(refErr?.path).toBe("steps[0].target");
  });

  it("emits MISSING_REF when setX ref arg is not in the deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "setX",
            id: "s1",
            target: "vault",
            function: "setToken",
            args: [{ kind: "ref", contract: "noSuchToken" }],
          },
        ],
      },
      new Set(["vault"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_REF");
    const refErr = (result as { ok: false; errors: ConfigError[] }).errors.find(
      (e) => e.code === "MISSING_REF",
    );
    expect(refErr?.path).toBe("steps[0].args[0].contract");
  });

  it("emits MISSING_REF when grantRole target is not in the deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "grantRole",
            id: "s1",
            target: "missingToken",
            role: "MINTER",
            account: { kind: "literal", value: "0x123" },
          },
        ],
      },
      new Set(["someOtherContract"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_REF");
    expect(errorPaths(result)).toContain("steps[0].target");
  });

  it("emits MISSING_REF when grantRole account ref is not in the deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "grantRole",
            id: "s1",
            target: "token",
            role: "MINTER",
            account: { kind: "ref", contract: "noSuchMinter" },
          },
        ],
      },
      new Set(["token"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_REF");
    expect(errorPaths(result)).toContain("steps[0].account.contract");
  });

  it("emits MISSING_REF when wire source is not in the deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "wire", id: "w1", source: "noSuchToken", into: "vault", function: "setToken" }],
      },
      new Set(["vault"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_REF");
    expect(errorPaths(result)).toContain("steps[0].source");
  });

  it("emits MISSING_REF when wire into is not in the deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "wire", id: "w1", source: "token", into: "noSuchVault", function: "setToken" }],
      },
      new Set(["token"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_REF");
    expect(errorPaths(result)).toContain("steps[0].into");
  });

  // --- SELF_REFERENCE (wire) ---

  it("emits SELF_REFERENCE when wire source and into are the same id", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "wire", id: "w1", source: "vault", into: "vault", function: "setVault" }],
      },
      new Set(["vault"]),
    );
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("SELF_REFERENCE");
    const selfErr = (result as { ok: false; errors: ConfigError[] }).errors.find(
      (e) => e.code === "SELF_REFERENCE",
    );
    expect(selfErr?.path).toBe("steps[0].into");
  });

  // --- Multiple errors collected ---

  // Shape phase (Zod) collects all structural errors across steps in one pass —
  // it does NOT stop at the first malformed step. Note: when shape validation
  // fails the cross-field phase (duplicate ids, missing refs) is skipped; those
  // are separate phases that run only on a structurally valid spec.
  it("shape phase collects INVALID_SHAPE errors from two independently malformed steps", () => {
    // Both steps have an empty-string target, which violates setX.target min(1).
    // Zod iterates every array element, so both failures are collected.
    const result = validateConfig({
      version: 1,
      steps: [
        { kind: "setX", id: "s1", target: "", function: "f" },
        { kind: "setX", id: "s2", target: "", function: "g" },
      ],
    });
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: ConfigError[] }).errors;
    // Exactly two errors, one per malformed step.
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.code === "INVALID_SHAPE")).toBe(true);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain("steps[0].target");
    expect(paths).toContain("steps[1].target");
  });

  // Cross-field phase collects all cross-field errors across steps in one pass —
  // a DUPLICATE_STEP_ID and a MISSING_REF in the same (shape-valid) config are
  // both returned together, never short-circuiting after the first finding.
  it("cross-field phase collects DUPLICATE_STEP_ID and MISSING_REF together", () => {
    // step1 appears twice (duplicate) and the second occurrence also references
    // an unknown deployed contract (missing ref). Both errors are collected.
    const result = validateConfig(
      {
        version: 1,
        steps: [
          { kind: "setX", id: "step1", target: "knownContract", function: "f" },
          { kind: "setX", id: "step1", target: "unknownContract", function: "g" },
        ],
      },
      new Set(["knownContract"]),
    );
    expect(result.ok).toBe(false);
    const errors = (result as { ok: false; errors: ConfigError[] }).errors;
    // Exactly two errors: one for duplicate id, one for the missing ref.
    expect(errors).toHaveLength(2);
    const codes = errors.map((e) => e.code);
    expect(codes).toContain("DUPLICATE_STEP_ID");
    expect(codes).toContain("MISSING_REF");
  });

  it("collects multiple MISSING_REF errors from different steps", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          { kind: "setX", id: "s1", target: "unknownA", function: "f" },
          { kind: "setX", id: "s2", target: "unknownB", function: "g" },
        ],
      },
      new Set<string>(),
    );
    expect(result.ok).toBe(false);
    const codes = errorCodes(result);
    expect(codes.filter((c) => c === "MISSING_REF")).toHaveLength(2);
  });

  // --- Pathological / deeply-nested literal ---

  it("never throws on a pathological deeply-nested literal value", () => {
    let deep: unknown = 1;
    for (let i = 0; i < LITERAL_MAX_DEPTH + 10; i++) {
      deep = [deep];
    }
    expect(() =>
      validateConfig({
        version: 1,
        steps: [
          {
            kind: "setX",
            id: "s1",
            target: "c",
            function: "f",
            args: [{ kind: "literal", value: deep }],
          },
        ],
      }),
    ).not.toThrow();
    const result = validateConfig({
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "s1",
          target: "c",
          function: "f",
          args: [{ kind: "literal", value: deep }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("INVALID_SHAPE");
  });

  it("never throws on deeply nested non-array object input", () => {
    expect(() => validateConfig({ deeply: { nested: { input: true } } })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema exports
// ---------------------------------------------------------------------------

describe("schema exports", () => {
  it("exports LITERAL_MAX_DEPTH as a positive number", () => {
    expect(typeof LITERAL_MAX_DEPTH).toBe("number");
    expect(LITERAL_MAX_DEPTH).toBeGreaterThan(0);
  });

  it("configSpecSchema parses a valid spec", async () => {
    const { configSpecSchema } = await import("../src/index.js");
    const result = configSpecSchema.safeParse({ version: 1, steps: [] });
    expect(result.success).toBe(true);
  });

  it("configStepSchema rejects an object with unknown kind", async () => {
    const { configStepSchema } = await import("../src/index.js");
    const result = configStepSchema.safeParse({ kind: "bogus", id: "x", target: "y", function: "z" });
    expect(result.success).toBe(false);
  });
});

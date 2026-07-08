/**
 * Tests for simulate() — dry-run / plan-only deployment simulation.
 *
 * Coverage targets:
 *   1. Validation-failure path → ok:false with SimulateError[] (code INVALID_SPEC)
 *   2. Compile-error path (CompileError) → ok:false (code COMPILE_ERROR)
 *   3. Success path → ok:true with steps[] in correct topological order
 *   4. Inter-contract refs → dependency appears before dependent in steps
 *   5. after constraints → dependency appears before dependent in steps
 *   6. dependsOn is correct (refs + after, deduplicated)
 *   7. No chain/fs side effects — no provider/journal needed to call simulate
 *   8. simulate is exported from the package root
 */

import { describe, it, expect, vi } from "vitest";
import {
  simulate,
  CompileError,
} from "../src/index.js";
import type { SimulateResult, PlannedStep, DeploymentSpec } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertOk(result: SimulateResult): PlannedStep[] {
  if (!result.ok) {
    throw new Error(`Expected ok:true but got ok:false: ${JSON.stringify(result.errors)}`);
  }
  return result.steps;
}

function assertFail(result: SimulateResult) {
  if (result.ok) {
    throw new Error(`Expected ok:false but got ok:true`);
  }
  return result.errors;
}

// ---------------------------------------------------------------------------
// 1. Export check
// ---------------------------------------------------------------------------

describe("simulate — package export", () => {
  it("is exported from the package root", () => {
    expect(typeof simulate).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 2. Validation-failure path
// ---------------------------------------------------------------------------

describe("simulate — INVALID_SPEC failures", () => {
  it("returns ok:false for null input", () => {
    const result = simulate(null);
    const errors = assertFail(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code === "INVALID_SPEC")).toBe(true);
  });

  it("returns ok:false for empty object (missing version and contracts)", () => {
    const result = simulate({});
    const errors = assertFail(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code === "INVALID_SPEC")).toBe(true);
  });

  it("returns ok:false for spec with wrong version", () => {
    const result = simulate({ version: 99, contracts: [] });
    const errors = assertFail(result);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code === "INVALID_SPEC")).toBe(true);
  });

  it("returns ok:false for spec with duplicate contract ids", () => {
    const result = simulate({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token" },
      ],
    });
    const errors = assertFail(result);
    expect(errors.some((e) => e.code === "INVALID_SPEC")).toBe(true);
    expect(errors.some((e) => e.message.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("returns ok:false for spec with missing ref target", () => {
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "nonexistent" }],
        },
      ],
    });
    const errors = assertFail(result);
    expect(errors.some((e) => e.code === "INVALID_SPEC")).toBe(true);
    expect(errors.some((e) => e.message.toLowerCase().includes("unknown"))).toBe(true);
  });

  it("returns ok:false for spec with a cycle", () => {
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "a",
          contract: "A",
          args: [{ kind: "ref", contract: "b" }],
        },
        {
          id: "b",
          contract: "B",
          args: [{ kind: "ref", contract: "a" }],
        },
      ],
    });
    const errors = assertFail(result);
    expect(errors.some((e) => e.code === "INVALID_SPEC")).toBe(true);
    expect(errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("collects multiple SpecErrors (not fail-fast)", () => {
    // Two duplicate-id errors and a missing-ref all in one spec
    const result = simulate({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "missing" }],
        },
      ],
    });
    const errors = assertFail(result);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("errors include path and message fields", () => {
    const result = simulate(null);
    const errors = assertFail(result);
    for (const e of errors) {
      expect(typeof e.path).toBe("string");
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Compile-error path (CompileError → ok:false, code COMPILE_ERROR)
// ---------------------------------------------------------------------------

describe("simulate — COMPILE_ERROR path", () => {
  it("returns ok:false with code COMPILE_ERROR when buildCreationOrder throws CompileError", async () => {
    // We simulate a CompileError by mocking buildCreationOrder at the module level.
    // Since we can't easily inject it, we test the wrapping by verifying the
    // internal path: use vi.spyOn on the compile module re-exported from index.
    const compileModule = await import("../src/compile/compile.js");
    const spy = vi.spyOn(compileModule, "buildCreationOrder").mockImplementation(() => {
      throw new CompileError("INTERNAL_INVARIANT", "mocked compile failure", "contracts[0]");
    });

    try {
      const result = simulate({ version: 1, contracts: [{ id: "a", contract: "A" }] });
      const errors = assertFail(result);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("COMPILE_ERROR");
      expect(errors[0]!.message).toBe("mocked compile failure");
      expect(errors[0]!.path).toBe("contracts[0]");
    } finally {
      spy.mockRestore();
    }
  });

  it("COMPILE_ERROR path: non-CompileError (plain Error) also returns ok:false", async () => {
    const compileModule = await import("../src/compile/compile.js");
    const spy = vi.spyOn(compileModule, "buildCreationOrder").mockImplementation(() => {
      throw new Error("unexpected runtime error");
    });

    try {
      const result = simulate({ version: 1, contracts: [{ id: "a", contract: "A" }] });
      const errors = assertFail(result);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("COMPILE_ERROR");
      // String(new Error("msg")) === "Error: msg" in Node.js
      expect(errors[0]!.message).toContain("unexpected runtime error");
      expect(errors[0]!.path).toBe(""); // no path for non-CompileError
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Success path — empty spec
// ---------------------------------------------------------------------------

describe("simulate — success: empty spec", () => {
  it("returns ok:true with empty steps for an empty contracts array", () => {
    const result = simulate({ version: 1, contracts: [] });
    const steps = assertOk(result);
    expect(steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Success path — single contract, no deps
// ---------------------------------------------------------------------------

describe("simulate — success: single contract", () => {
  it("returns one step for a single contract with no args", () => {
    const result = simulate({
      version: 1,
      contracts: [{ id: "registry", contract: "Registry" }],
    });
    const steps = assertOk(result);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe("registry");
    expect(steps[0]!.contract).toBe("Registry");
    expect(steps[0]!.args).toBeUndefined();
    expect(steps[0]!.after).toBeUndefined();
    expect(steps[0]!.dependsOn).toEqual([]);
  });

  it("preserves literal args in the step", () => {
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "literal", value: "My Token" },
            { kind: "literal", value: "MTK" },
          ],
        },
      ],
    });
    const steps = assertOk(result);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.args).toEqual([
      { kind: "literal", value: "My Token" },
      { kind: "literal", value: "MTK" },
    ]);
    expect(steps[0]!.dependsOn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Success path — inter-contract refs, topological order
// ---------------------------------------------------------------------------

describe("simulate — success: topological order with ref dependencies", () => {
  it("places token before vault when vault has a ref to token", () => {
    const result = simulate({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
        },
      ],
    });
    const steps = assertOk(result);
    expect(steps).toHaveLength(2);

    const tokenIdx = steps.findIndex((s) => s.id === "token");
    const vaultIdx = steps.findIndex((s) => s.id === "vault");
    expect(tokenIdx).toBeLessThan(vaultIdx);
  });

  it("vault step has token in dependsOn", () => {
    const result = simulate({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
        },
      ],
    });
    const steps = assertOk(result);
    const vault = steps.find((s) => s.id === "vault")!;
    expect(vault.dependsOn).toContain("token");
  });

  it("vault ref-arg is still { kind: 'ref', contract: 'token' } (no address substitution)", () => {
    const result = simulate({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
        },
      ],
    });
    const steps = assertOk(result);
    const vault = steps.find((s) => s.id === "vault")!;
    expect(vault.args).toEqual([{ kind: "ref", contract: "token" }]);
  });

  it("3-contract chain A → B → C orders them A, B, C", () => {
    // B depends on A; C depends on B
    const result = simulate({
      version: 1,
      contracts: [
        { id: "a", contract: "A" },
        { id: "b", contract: "B", args: [{ kind: "ref", contract: "a" }] },
        { id: "c", contract: "C", args: [{ kind: "ref", contract: "b" }] },
      ],
    });
    const steps = assertOk(result);
    expect(steps).toHaveLength(3);

    const aIdx = steps.findIndex((s) => s.id === "a");
    const bIdx = steps.findIndex((s) => s.id === "b");
    const cIdx = steps.findIndex((s) => s.id === "c");

    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });

  it("handles spec with deps declared AFTER dependents in array (topo-sort fixes order)", () => {
    // vault comes first in the array, token second — topo-sort must correct order
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
        },
        { id: "token", contract: "Token" },
      ],
    });
    const steps = assertOk(result);
    const tokenIdx = steps.findIndex((s) => s.id === "token");
    const vaultIdx = steps.findIndex((s) => s.id === "vault");
    expect(tokenIdx).toBeLessThan(vaultIdx);
  });
});

// ---------------------------------------------------------------------------
// 7. Success path — after constraints
// ---------------------------------------------------------------------------

describe("simulate — success: topological order with after constraints", () => {
  it("places registry before config when config has after:[registry]", () => {
    const result = simulate({
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "config", contract: "Config", after: ["registry"] },
      ],
    });
    const steps = assertOk(result);
    const registryIdx = steps.findIndex((s) => s.id === "registry");
    const configIdx = steps.findIndex((s) => s.id === "config");
    expect(registryIdx).toBeLessThan(configIdx);
  });

  it("config step has registry in dependsOn", () => {
    const result = simulate({
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "config", contract: "Config", after: ["registry"] },
      ],
    });
    const steps = assertOk(result);
    const config = steps.find((s) => s.id === "config")!;
    expect(config.dependsOn).toContain("registry");
    expect(config.after).toEqual(["registry"]);
    // No args → dependsOn comes only from after
    expect(config.args).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Success path — combined ref + after, dependsOn deduplication
// ---------------------------------------------------------------------------

describe("simulate — success: combined ref + after, dependsOn", () => {
  it("Registry+Token+Vault acceptance: vault depends on both token (ref) and registry (after)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "registry",
          contract: "Registry",
          args: [{ kind: "literal", value: "0x0000000000000000000000000000000000000001" }],
        },
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "literal", value: "My Token" },
            { kind: "literal", value: "MTK" },
          ],
        },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
          after: ["registry"],
        },
      ],
    };
    const result = simulate(spec);
    const steps = assertOk(result);
    expect(steps).toHaveLength(3);

    const registryIdx = steps.findIndex((s) => s.id === "registry");
    const tokenIdx = steps.findIndex((s) => s.id === "token");
    const vaultIdx = steps.findIndex((s) => s.id === "vault");

    // vault must come after both registry and token
    expect(registryIdx).toBeLessThan(vaultIdx);
    expect(tokenIdx).toBeLessThan(vaultIdx);

    const vault = steps.find((s) => s.id === "vault")!;
    expect(vault.dependsOn).toContain("token");
    expect(vault.dependsOn).toContain("registry");
    expect(vault.dependsOn).toHaveLength(2); // no duplicate
  });

  it("deduplicates dependsOn when the same id appears in both ref and after", () => {
    // Unusual but technically possible: same id in both args ref and after
    const result = simulate({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
          after: ["token"], // duplicate
        },
      ],
    });
    const steps = assertOk(result);
    const vault = steps.find((s) => s.id === "vault")!;
    // dependsOn must deduplicate — "token" appears only once
    expect(vault.dependsOn.filter((id) => id === "token")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. No chain/fs side effects
// ---------------------------------------------------------------------------

describe("simulate — no chain / fs side effects", () => {
  it("does not require a provider, accounts, deploymentDir, or artifactResolver", () => {
    // Simply calling simulate with a valid spec should succeed without any
    // external resources. If this test runs (no imports fail, no errors are
    // thrown due to missing provider/journal), the contract is satisfied.
    const result = simulate({
      version: 1,
      contracts: [
        { id: "a", contract: "A" },
        { id: "b", contract: "B", args: [{ kind: "ref", contract: "a" }] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("is synchronous — returns a plain value, not a Promise", () => {
    const result = simulate({ version: 1, contracts: [] });
    // If simulate returned a Promise, result.ok would be undefined
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.ok).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// 10. Same artifact, multiple ids
// ---------------------------------------------------------------------------

describe("simulate — same artifact deployed multiple times", () => {
  it("two Token deployments under different ids both appear as steps", () => {
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "tokenA",
          contract: "Token",
          args: [{ kind: "literal", value: "A" }, { kind: "literal", value: "AAA" }],
        },
        {
          id: "tokenB",
          contract: "Token",
          args: [{ kind: "literal", value: "B" }, { kind: "literal", value: "BBB" }],
        },
      ],
    });
    const steps = assertOk(result);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.id)).toContain("tokenA");
    expect(steps.map((s) => s.id)).toContain("tokenB");
    // Both report the same artifact name
    expect(steps.every((s) => s.contract === "Token")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. ResolverArg — plan-only pass-through, never invoked (issue #100, Layer 2)
// ---------------------------------------------------------------------------
//
// simulate() is validate + topo-sort only — it never touches a provider or
// invokes a resolver (there is no `resolvers` registry parameter on simulate()
// at all). A resolver arg must appear in the plan exactly as declared, same
// as ref/param/expr args do today.

describe("simulate — ResolverArg pass-through", () => {
  it("includes a resolver arg unchanged (kind, name, args) in the planned step", () => {
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "resolver", name: "readOracle", args: ["v1", 42] }],
        },
      ],
    });
    const steps = assertOk(result);
    expect(steps[0].args).toEqual([{ kind: "resolver", name: "readOracle", args: ["v1", 42] }]);
  });

  it("does not add a dependency edge for a resolver arg (v1 resolvers have no sibling deps)", () => {
    const result = simulate({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "resolver", name: "readOracle" }],
        },
        { id: "registry", contract: "Registry" },
      ],
    });
    const steps = assertOk(result);
    const vault = steps.find((s) => s.id === "vault")!;
    expect(vault.dependsOn).toEqual([]);
  });

  it("never invokes the resolver — simulate() has no registry parameter and stays synchronous", () => {
    // There is no way to pass a ResolverRegistry to simulate() at all — this
    // test documents that fact via the type signature (simulate(spec) takes
    // exactly one argument) and re-asserts the synchronous, side-effect-free
    // contract already covered by "no chain / fs side effects" above.
    expect(simulate.length).toBe(1);
    const result = simulate({
      version: 1,
      contracts: [{ id: "vault", contract: "Vault", args: [{ kind: "resolver", name: "anything" }] }],
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(assertOk(result)).toHaveLength(1);
  });

  it("mixes a resolver arg with ref/literal/param/expr args in the same step's args list", () => {
    const result = simulate({
      version: 1,
      parameters: { threshold: 1 },
      contracts: [
        { id: "registry", contract: "Registry" },
        {
          id: "vault",
          contract: "Vault",
          args: [
            { kind: "ref", contract: "registry" },
            { kind: "literal", value: "Vault Name" },
            { kind: "param", name: "threshold" },
            { kind: "expr", expression: "1n + 1n" },
            { kind: "resolver", name: "readOracle" },
          ],
        },
      ],
    });
    const steps = assertOk(result);
    const vault = steps.find((s) => s.id === "vault")!;
    expect(vault.args).toHaveLength(5);
    expect(vault.args?.[4]).toEqual({ kind: "resolver", name: "readOracle" });
    // Only the ref contributes a dependency edge.
    expect(vault.dependsOn).toEqual(["registry"]);
  });
});

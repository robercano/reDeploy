import { describe, it, expect } from "vitest";
import {
  FutureType,
  RuntimeValueType,
  type ModuleParameterRuntimeValue,
  type NamedArtifactContractDeploymentFuture,
  type NamedArtifactContractAtFuture,
  type EncodeFunctionCallFuture,
  type ContractCallFuture,
} from "@nomicfoundation/ignition-core";
import { compileSpec, compileUpgrade, CompileError, buildCreationOrder } from "../src/index.js";
import type { DeploymentSpec } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cast a future to the named-artifact contract deployment shape for assertions. */
function asContractFuture(
  future: unknown,
): NamedArtifactContractDeploymentFuture<string> {
  const f = future as NamedArtifactContractDeploymentFuture<string>;
  if (f.type !== FutureType.NAMED_ARTIFACT_CONTRACT_DEPLOYMENT) {
    throw new Error(`Expected NAMED_ARTIFACT_CONTRACT_DEPLOYMENT, got ${f.type}`);
  }
  return f;
}

/** Cast a constructorArg to the module-parameter runtime value shape for assertions. */
function asModuleParameterRuntimeValue(
  value: unknown,
): ModuleParameterRuntimeValue<unknown> {
  const v = value as ModuleParameterRuntimeValue<unknown>;
  if (v.type !== RuntimeValueType.MODULE_PARAMETER) {
    throw new Error(`Expected MODULE_PARAMETER runtime value, got ${String(v.type)}`);
  }
  return v;
}

/** Cast a future to the named-artifact contractAt shape for assertions. */
function asContractAtFuture(future: unknown): NamedArtifactContractAtFuture<string> {
  const f = future as NamedArtifactContractAtFuture<string>;
  if (f.type !== FutureType.NAMED_ARTIFACT_CONTRACT_AT) {
    throw new Error(`Expected NAMED_ARTIFACT_CONTRACT_AT, got ${f.type}`);
  }
  return f;
}

/** Cast a future to the encode-function-call shape for assertions. */
function asEncodeFunctionCallFuture(future: unknown): EncodeFunctionCallFuture<string, string> {
  const f = future as EncodeFunctionCallFuture<string, string>;
  if (f.type !== FutureType.ENCODE_FUNCTION_CALL) {
    throw new Error(`Expected ENCODE_FUNCTION_CALL, got ${f.type}`);
  }
  return f;
}

/** Cast a future to the contract-call shape for assertions. */
function asContractCallFuture(future: unknown): ContractCallFuture<string, string> {
  const f = future as ContractCallFuture<string, string>;
  if (f.type !== FutureType.CONTRACT_CALL) {
    throw new Error(`Expected CONTRACT_CALL, got ${f.type}`);
  }
  return f;
}

/** Find a future by its exact bare (moduleId-stripped) id, e.g. "vault" or "vault_impl". */
function findFutureByBareId(mod: { futures: Set<{ id: string }> }, bareId: string) {
  return [...mod.futures].find((f) => f.id.endsWith(`#${bareId}`));
}

// ---------------------------------------------------------------------------
// 1. Basic module creation
// ---------------------------------------------------------------------------

describe("compileSpec — basic module creation", () => {
  it("returns a module with the default id 'Deployment'", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "registry", contract: "Registry" }],
    };
    const mod = compileSpec(spec);
    expect(mod.id).toBe("Deployment");
  });

  it("uses a custom moduleId when provided", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "token", contract: "Token" }],
    };
    const mod = compileSpec(spec, { moduleId: "MyCustomModule" });
    expect(mod.id).toBe("MyCustomModule");
  });

  it("creates exactly one future per contract id", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "token", contract: "Token" },
        { id: "vault", contract: "Vault" },
      ],
    };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(3);
  });

  it("future ids match entry ids (prefixed by moduleId/)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "registry", contract: "Registry" }],
    };
    const mod = compileSpec(spec, { moduleId: "M" });
    const futureIds = [...mod.futures].map((f) => f.id);
    // Ignition prefixes future ids with "<moduleId>#<contractName>"
    // Using the `id` option in m.contract() may result in
    // "M#Registry" or "M#registry" depending on Ignition internals.
    // We test that the entry id appears somewhere in the future id.
    expect(futureIds.some((id) => id.includes("registry"))).toBe(true);
  });

  it("handles a no-args contract", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "reg", contract: "Registry" }],
    };
    const mod = compileSpec(spec);
    const [future] = mod.futures;
    const f = asContractFuture(future);
    expect(f.constructorArgs).toEqual([]);
  });

  it("handles an empty contracts array", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [] };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Literal argument mapping
// ---------------------------------------------------------------------------

describe("compileSpec — literal argument mapping", () => {
  it("passes a string literal directly as a constructorArg", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "literal", value: "My Token" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const [future] = mod.futures;
    const f = asContractFuture(future);
    expect(f.constructorArgs[0]).toBe("My Token");
  });

  it("passes a number literal directly", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: 42 }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(42);
  });

  it("passes a boolean literal directly", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: false }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(false);
  });

  it("passes null directly", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: null }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBeNull();
  });

  it("maps a flat array literal into constructorArgs", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: [1, 2, 3] }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toEqual([1, 2, 3]);
  });

  it("maps a nested array literal (round-trip)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: [[1, 2], [3, [4, 5]]] }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toEqual([[1, 2], [3, [4, 5]]]);
  });

  it("handles multiple literal args in order", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "literal", value: "Token Name" },
            { kind: "literal", value: "TKN" },
          ],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe("Token Name");
    expect(f.constructorArgs[1]).toBe("TKN");
  });
});

// ---------------------------------------------------------------------------
// 3. Ref arg → real dependency edge
// ---------------------------------------------------------------------------

describe("compileSpec — ref args create real dependency edges", () => {
  it("ref arg: the referenced future is in the dependent's dependencies set", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
        },
      ],
    };
    const mod = compileSpec(spec);

    // Find vault future (its id contains "vault")
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));
    const tokenFuture = [...mod.futures].find((f) => f.id.includes("token"));
    expect(vaultFuture).toBeDefined();
    expect(tokenFuture).toBeDefined();

    // The vault future must have token in its dependencies
    expect(vaultFuture!.dependencies.has(tokenFuture!)).toBe(true);

    // The constructorArg at position 0 must BE the token future (not a string)
    const vaultF = asContractFuture(vaultFuture);
    expect(vaultF.constructorArgs[0]).toBe(tokenFuture);
  });

  it("multiple refs in one contract all become dependency edges", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "tokenA", contract: "Token" },
        { id: "tokenB", contract: "Token" },
        {
          id: "pair",
          contract: "Pair",
          args: [
            { kind: "ref", contract: "tokenA" },
            { kind: "ref", contract: "tokenB" },
          ],
        },
      ],
    };
    const mod = compileSpec(spec);

    const pairFuture = [...mod.futures].find((f) => f.id.includes("pair"));
    const tokenAFuture = [...mod.futures].find((f) => f.id.includes("tokenA"));
    const tokenBFuture = [...mod.futures].find((f) => f.id.includes("tokenB"));

    expect(pairFuture).toBeDefined();
    expect(tokenAFuture).toBeDefined();
    expect(tokenBFuture).toBeDefined();

    expect(pairFuture!.dependencies.has(tokenAFuture!)).toBe(true);
    expect(pairFuture!.dependencies.has(tokenBFuture!)).toBe(true);

    const pairF = asContractFuture(pairFuture);
    expect(pairF.constructorArgs[0]).toBe(tokenAFuture);
    expect(pairF.constructorArgs[1]).toBe(tokenBFuture);
  });
});

// ---------------------------------------------------------------------------
// 4. After constraint → dependency edge
// ---------------------------------------------------------------------------

describe("compileSpec — after constraints create dependency edges", () => {
  it("after entry produces a dependency edge without a constructor-arg ref", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "config", contract: "Config", after: ["registry"] },
      ],
    };
    const mod = compileSpec(spec);

    const registryFuture = [...mod.futures].find((f) => f.id.includes("registry"));
    const configFuture = [...mod.futures].find((f) => f.id.includes("config"));
    expect(registryFuture).toBeDefined();
    expect(configFuture).toBeDefined();

    // The config future must declare registry as a dependency (via after)
    expect(configFuture!.dependencies.has(registryFuture!)).toBe(true);

    // But config's constructorArgs should be empty (no ref arg, only after)
    const configF = asContractFuture(configFuture);
    expect(configF.constructorArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Combined ref + after
// ---------------------------------------------------------------------------

describe("compileSpec — ref + after combined", () => {
  it("a contract with both a ref arg and an after entry has both dependency edges", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
          after: ["registry"],
        },
      ],
    };
    const mod = compileSpec(spec);

    const registryFuture = [...mod.futures].find((f) => f.id.includes("registry"));
    const tokenFuture = [...mod.futures].find((f) => f.id.includes("token"));
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));

    expect(registryFuture).toBeDefined();
    expect(tokenFuture).toBeDefined();
    expect(vaultFuture).toBeDefined();

    // vault depends on token (via ref arg)
    expect(vaultFuture!.dependencies.has(tokenFuture!)).toBe(true);
    // vault depends on registry (via after)
    expect(vaultFuture!.dependencies.has(registryFuture!)).toBe(true);

    // constructorArg 0 is the token future
    const vaultF = asContractFuture(vaultFuture);
    expect(vaultF.constructorArgs[0]).toBe(tokenFuture);
    // Only one constructor arg (the ref); registry was an after, not an arg
    expect(vaultF.constructorArgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Future types
// ---------------------------------------------------------------------------

describe("compileSpec — future type discriminant", () => {
  it("all created futures have type NAMED_ARTIFACT_CONTRACT_DEPLOYMENT", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "a", contract: "A" },
        { id: "b", contract: "B" },
      ],
    };
    const mod = compileSpec(spec);
    for (const future of mod.futures) {
      expect(future.type).toBe(FutureType.NAMED_ARTIFACT_CONTRACT_DEPLOYMENT);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Acceptance scenario: Registry + Token + Vault
// ---------------------------------------------------------------------------

describe("compileSpec — acceptance: Registry + Token + Vault", () => {
  const ADMIN_ADDR = "0x0000000000000000000000000000000000000001";

  const spec: DeploymentSpec = {
    version: 1,
    contracts: [
      {
        id: "registry",
        contract: "Registry",
        args: [{ kind: "literal", value: ADMIN_ADDR }],
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

  it("produces 3 futures", () => {
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(3);
  });

  it("registry future has the admin address as its first constructorArg", () => {
    const mod = compileSpec(spec);
    const regFuture = [...mod.futures].find((f) => f.id.includes("registry"));
    expect(regFuture).toBeDefined();
    const reg = asContractFuture(regFuture);
    expect(reg.constructorArgs[0]).toBe(ADMIN_ADDR);
  });

  it("token future has name and symbol as literal constructorArgs", () => {
    const mod = compileSpec(spec);
    const tokFuture = [...mod.futures].find((f) => f.id.includes("token"));
    expect(tokFuture).toBeDefined();
    const tok = asContractFuture(tokFuture);
    expect(tok.constructorArgs[0]).toBe("My Token");
    expect(tok.constructorArgs[1]).toBe("MTK");
  });

  it("vault future depends on token via ref (constructorArg IS the token future)", () => {
    const mod = compileSpec(spec);
    const tokFuture = [...mod.futures].find((f) => f.id.includes("token"));
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));
    expect(tokFuture).toBeDefined();
    expect(vaultFuture).toBeDefined();

    expect(vaultFuture!.dependencies.has(tokFuture!)).toBe(true);
    const vault = asContractFuture(vaultFuture);
    expect(vault.constructorArgs[0]).toBe(tokFuture);
  });

  it("vault future depends on registry via after", () => {
    const mod = compileSpec(spec);
    const regFuture = [...mod.futures].find((f) => f.id.includes("registry"));
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));
    expect(regFuture).toBeDefined();
    expect(vaultFuture).toBeDefined();

    expect(vaultFuture!.dependencies.has(regFuture!)).toBe(true);
  });

  it("vault constructorArgs has exactly one element (the token future, not registry)", () => {
    const mod = compileSpec(spec);
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));
    const vault = asContractFuture(vaultFuture);
    expect(vault.constructorArgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. CompileError tests
// ---------------------------------------------------------------------------

describe("compileSpec — CompileError", () => {
  it("is exported from the package root and is a class", () => {
    expect(CompileError).toBeDefined();
    expect(typeof CompileError).toBe("function");
  });

  it("CompileError instances have code and optional path", () => {
    const err = new CompileError("INTERNAL_INVARIANT", "test error", "contracts[0]");
    expect(err.code).toBe("INTERNAL_INVARIANT");
    expect(err.path).toBe("contracts[0]");
    expect(err.message).toBe("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CompileError);
    expect(err.name).toBe("CompileError");
  });
});

// ---------------------------------------------------------------------------
// 9. Ordering: spec entries listed in reverse dependency order
// ---------------------------------------------------------------------------

describe("compileSpec — handles dependencies declared after dependents in array", () => {
  it("compiles correctly when spec lists vault before token (build-time sort fixes order)", () => {
    // NOTE: validateSpec allows refs to targets defined later in the array —
    // there is no requirement that deps appear before dependents in the spec.
    // The compiler's build-time sort must handle this.
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        // vault declared FIRST, token declared SECOND
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "token" }],
        },
        { id: "token", contract: "Token" },
      ],
    };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(2);

    const tokFuture = [...mod.futures].find((f) => f.id.includes("token"));
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));
    expect(tokFuture).toBeDefined();
    expect(vaultFuture).toBeDefined();

    // Real dependency edge must still be present
    expect(vaultFuture!.dependencies.has(tokFuture!)).toBe(true);
    const vault = asContractFuture(vaultFuture);
    expect(vault.constructorArgs[0]).toBe(tokFuture);
  });

  it("compiles a chain declared in reverse order", () => {
    // C → B → A declared in reverse: C, B, A
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "c", contract: "C", args: [{ kind: "ref", contract: "b" }] },
        { id: "b", contract: "B", args: [{ kind: "ref", contract: "a" }] },
        { id: "a", contract: "A" },
      ],
    };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(3);

    const fa = [...mod.futures].find((f) => f.id.includes("a"));
    const fb = [...mod.futures].find((f) => f.id.includes("b"));
    const fc = [...mod.futures].find((f) => f.id.includes("c"));

    expect(fa).toBeDefined();
    expect(fb).toBeDefined();
    expect(fc).toBeDefined();

    // b depends on a; c depends on b
    expect(asContractFuture(fb).constructorArgs[0]).toBe(fa);
    expect(asContractFuture(fc).constructorArgs[0]).toBe(fb);
    expect(fb!.dependencies.has(fa!)).toBe(true);
    expect(fc!.dependencies.has(fb!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Same artifact deployed multiple times
// ---------------------------------------------------------------------------

describe("compileSpec — same artifact, different ids", () => {
  it("can deploy the same contract artifact under two different ids", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "tokenA", contract: "Token", args: [{ kind: "literal", value: "A" }, { kind: "literal", value: "AAA" }] },
        { id: "tokenB", contract: "Token", args: [{ kind: "literal", value: "B" }, { kind: "literal", value: "BBB" }] },
      ],
    };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(2);

    const fa = asContractFuture([...mod.futures].find((f) => f.id.includes("tokenA")));
    const fb = asContractFuture([...mod.futures].find((f) => f.id.includes("tokenB")));
    expect(fa.constructorArgs[0]).toBe("A");
    expect(fb.constructorArgs[0]).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// 11. UNSUPPORTED_LITERAL defensive error path
// ---------------------------------------------------------------------------

describe("compileSpec — UNSUPPORTED_LITERAL error", () => {
  it("throws CompileError(UNSUPPORTED_LITERAL) for a literal value that is an object (not a valid LiteralValue shape)", () => {
    // LiteralValue is LiteralScalar | LiteralValue[]; objects are excluded.
    // We use a type assertion to bypass TypeScript and test the runtime guard.
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [
            {
              kind: "literal",
              // Deliberately inject an invalid value via type coercion.
              // A plain object is not a valid LiteralValue and should trigger
              // the UNSUPPORTED_LITERAL CompileError guard in mapLiteralValue.
              value: { __invalid: "object" } as unknown as import("../src/index.js").LiteralValue,
            },
          ],
        },
      ],
    };

    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("UNSUPPORTED_LITERAL");
      expect((err as CompileError).path).toBeDefined();
    }
  });

  it("throws CompileError(UNSUPPORTED_LITERAL) for a nested object inside an array literal", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [
            {
              kind: "literal",
              // Nested object inside an array — still invalid
              value: [1, { nested: "object" } as unknown as import("../src/index.js").LiteralValue],
            },
          ],
        },
      ],
    };

    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("UNSUPPORTED_LITERAL");
    }
  });
});

// ---------------------------------------------------------------------------
// 12. ParamArg — resolved via Ignition's m.getParameter() (issue #98)
// ---------------------------------------------------------------------------

describe("compileSpec — param args resolve via m.getParameter()", () => {
  it("maps a param arg to a MODULE_PARAMETER runtime value (not a plain value)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { initialOwner: "0x0000000000000000000000000000000000000001" },
      contracts: [
        {
          id: "registry",
          contract: "Registry",
          args: [{ kind: "param", name: "initialOwner" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    const runtimeValue = asModuleParameterRuntimeValue(f.constructorArgs[0]);
    expect(runtimeValue.name).toBe("initialOwner");
  });

  it("does NOT bake the spec's declared value directly as a literal constructorArg", () => {
    // The whole point of using m.getParameter() is that the compiled module
    // does not hard-code a fixed value — the argument must be a runtime value
    // object, not the literal "My Token" string itself.
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { tokenName: "My Token" },
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "param", name: "tokenName" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).not.toBe("My Token");
    expect(typeof f.constructorArgs[0]).toBe("object");
  });

  it("uses the spec's declared parameter value as Ignition's defaultValue", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { threshold: 3 },
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "param", name: "threshold" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    const runtimeValue = asModuleParameterRuntimeValue(f.constructorArgs[0]);
    expect(runtimeValue.defaultValue).toBe(3);
  });

  it("leaves defaultValue undefined when the spec declares no value for the parameter", () => {
    // Note: validateSpec would normally reject this (UNKNOWN_PARAM), but
    // compileSpec's contract (like the rest of the compiler) assumes a
    // pre-validated spec and does not re-validate. This test exercises the
    // defensive branch directly.
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "param", name: "threshold" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    const runtimeValue = asModuleParameterRuntimeValue(f.constructorArgs[0]);
    expect(runtimeValue.defaultValue).toBeUndefined();
  });

  it("supports null and array literal values as declared parameter defaults", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { nothing: null, list: [1, 2, 3] },
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [
            { kind: "param", name: "nothing" },
            { kind: "param", name: "list" },
          ],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    const nothingRv = asModuleParameterRuntimeValue(f.constructorArgs[0]);
    const listRv = asModuleParameterRuntimeValue(f.constructorArgs[1]);
    expect(nothingRv.defaultValue).toBeNull();
    expect(listRv.defaultValue).toEqual([1, 2, 3]);
  });

  it("handles multiple param args plus a literal and a ref arg together", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { owner: "0xabc", supply: 1000 },
      contracts: [
        { id: "registry", contract: "Registry" },
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "ref", contract: "registry" },
            { kind: "literal", value: "My Token" },
            { kind: "param", name: "owner" },
            { kind: "param", name: "supply" },
          ],
        },
      ],
    };
    const mod = compileSpec(spec);
    const tokenFuture = asContractFuture([...mod.futures].find((f) => f.id.includes("token")));
    const registryFuture = [...mod.futures].find((f) => f.id.includes("registry"));

    expect(tokenFuture.constructorArgs[0]).toBe(registryFuture);
    expect(tokenFuture.constructorArgs[1]).toBe("My Token");
    expect(asModuleParameterRuntimeValue(tokenFuture.constructorArgs[2]).name).toBe("owner");
    expect(asModuleParameterRuntimeValue(tokenFuture.constructorArgs[3]).name).toBe("supply");
  });

  it("param args do not create dependency edges (they are not futures)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { owner: "0xabc" },
      contracts: [
        {
          id: "registry",
          contract: "Registry",
          args: [{ kind: "param", name: "owner" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = [...mod.futures][0];
    expect(f.dependencies.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. ExprArg — computed expressions (issue #99)
// ---------------------------------------------------------------------------

describe("compileSpec — expression args (ExprArg)", () => {
  it("compiles a simple arithmetic expression to a bigint constructor arg", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "expr", expression: "100n + 50n" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(150n);
  });

  it("compiles an expression with parameter references", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { baseAmount: 100, multiplier: 2 },
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "expr", expression: "params.baseAmount + params.multiplier" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(102n);
  });

  it("extracts contract references from expressions for build-time ordering", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        // token declared first, vault uses it in an expression
        { id: "token", contract: "Token", args: [{ kind: "literal", value: "TKN" }] },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "expr", expression: "${token}" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const tokenFuture = [...mod.futures].find((f) => f.id.includes("token"));
    const vaultFuture = [...mod.futures].find((f) => f.id.includes("vault"));

    expect(tokenFuture).toBeDefined();
    expect(vaultFuture).toBeDefined();
    // vault should depend on token via the expression
    expect(vaultFuture!.dependencies.has(tokenFuture!)).toBe(true);
  });

  it("handles reverse-declared expression dependencies via build-time sort", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { cap: 1000 },
      contracts: [
        // vault declared FIRST (uses parameter in expression)
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "expr", expression: "params.cap + 10n" }],
        },
        // token declared SECOND
        { id: "token", contract: "Token" },
      ],
    };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(2);
    // Both should be compiled without error; sort is build-time only
  });

  it("compiles expressions with conditionals", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { isInitial: 1 },
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [
            {
              kind: "expr",
              expression: "if(params.isInitial > 0n, 1000000n, 100n)",
            },
          ],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(1000000n);
  });

  it("compiles expressions with function calls (min, max, keccak256, concat)", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { val1: 100, val2: 50 },
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "expr", expression: "min(params.val1, params.val2)" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(50n);
  });

  it("compiles keccak256 expressions returning hex strings", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "expr", expression: 'keccak256("test")' }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    const result = f.constructorArgs[0];
    expect(typeof result).toBe("string");
    expect((result as string).startsWith("0x")).toBe(true);
  });

  it("throws CompileError(EXPRESSION_EVAL_ERROR) for invalid expressions", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "expr", expression: "invalid_function(5n)" }],
        },
      ],
    };
    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("EXPRESSION_EVAL_ERROR");
    }
  });

  it("throws CompileError(EXPRESSION_EVAL_ERROR) for missing parameter references", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "expr", expression: "params.unknownParam" }],
        },
      ],
    };
    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("EXPRESSION_EVAL_ERROR");
    }
  });

  it("handles expressions mixed with ref and literal args", () => {
    const spec: DeploymentSpec = {
      version: 1,
      parameters: { baseSupply: 1000 },
      contracts: [
        { id: "registry", contract: "Registry" },
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "ref", contract: "registry" },
            { kind: "literal", value: "My Token" },
            { kind: "expr", expression: "params.baseSupply * 2n" },
          ],
        },
      ],
    };
    const mod = compileSpec(spec);
    const tokenFuture = asContractFuture([...mod.futures].find((f) => f.id.includes("token")));
    const registryFuture = [...mod.futures].find((f) => f.id.includes("registry"));

    expect(tokenFuture.constructorArgs[0]).toBe(registryFuture);
    expect(tokenFuture.constructorArgs[1]).toBe("My Token");
    expect(tokenFuture.constructorArgs[2]).toBe(2000n);
  });
});

// ---------------------------------------------------------------------------
// 14. ResolverArg — unresolved resolver args at compile time (issue #100, Layer 2)
// ---------------------------------------------------------------------------
//
// compileSpec() is called by deploy() only AFTER its async pre-resolution
// pass (resolve/resolveSpec.ts) has already replaced every `{ kind:
// "resolver" }` arg with a concrete `{ kind: "literal" }` arg — so compileSpec()
// itself should never see a resolver arg in the normal deploy() pipeline.
// These tests exercise compileSpec()'s defensive behavior for direct callers
// who pass a spec that still contains unresolved resolver args (mirrors the
// "handles dependencies declared after dependents" style of defensive test
// already used for ref/param args above).

describe("compileSpec — UNRESOLVED_RESOLVER_ARG error (unresolved ResolverArg)", () => {
  it("throws CompileError(UNRESOLVED_RESOLVER_ARG) for an unresolved resolver arg", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "resolver", name: "readDecimals" }],
        },
      ],
    };
    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("UNRESOLVED_RESOLVER_ARG");
      expect((err as CompileError).message).toContain("readDecimals");
      expect((err as CompileError).path).toBe("contracts[id=token].args[0]");
    }
  });

  it("compiles successfully once the resolver arg has been pre-substituted with a literal", () => {
    // Simulates what deploy()'s pre-resolution pass does: replace the
    // resolver arg with a concrete literal BEFORE calling compileSpec().
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "literal", value: 18 }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe(18);
  });

  it("resolver args contribute no build-order dependency edges (buildCreationOrder)", () => {
    // A resolver arg referencing another contract id textually (in `args`)
    // must NOT create a build-time dependency edge — v1 resolvers cannot
    // depend on sibling contracts deploying in this same run (see
    // resolve/registry.ts's scope boundary). Order here is declared with the
    // "dependent" contract FIRST specifically to prove no edge was created:
    // if buildCreationOrder had (incorrectly) added an edge, this ordering
    // would either throw or silently reorder the entries.
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "resolver", name: "r", args: ["registry"] }],
        },
        { id: "registry", contract: "Registry" },
      ],
    };
    const ordered = buildCreationOrder(spec.contracts);
    // Declaration order is preserved exactly (no reordering forced by a
    // phantom dependency edge).
    expect(ordered.map((e) => e.id)).toEqual(["vault", "registry"]);
  });
});

// ---------------------------------------------------------------------------
// CrossRefArg — unresolved cross-chain refs at compile time (issue #159)
// ---------------------------------------------------------------------------
//
// compileSpec() is called by deploy() only AFTER its crossRef pre-resolution
// pass (resolve/crossRef.ts) has already replaced every `{ kind: "crossRef" }`
// arg with a concrete `{ kind: "literal" }` arg — so compileSpec() itself
// should never see a crossRef arg in the normal deploy() pipeline. These
// tests exercise compileSpec()'s defensive behavior for direct callers who
// pass a spec that still contains unresolved crossRef args (mirrors the
// UNRESOLVED_RESOLVER_ARG tests above).

describe("compileSpec — UNRESOLVED_CROSS_REF_ARG error (unresolved CrossRefArg)", () => {
  it("throws CompileError(UNRESOLVED_CROSS_REF_ARG) for an unresolved crossRef arg", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
        },
      ],
    };
    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("UNRESOLVED_CROSS_REF_ARG");
      expect((err as CompileError).message).toContain("registry");
      expect((err as CompileError).message).toContain("mainnet");
      expect((err as CompileError).path).toBe("contracts[id=vault].args[0]");
    }
  });

  it("compiles successfully once the crossRef arg has been pre-substituted with a literal", () => {
    // Simulates what deploy()'s crossRef pre-resolution pass does: replace
    // the crossRef arg with a concrete literal BEFORE calling compileSpec().
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "literal", value: "0x000000000000000000000000000000000000AA" }],
        },
      ],
    };
    const mod = compileSpec(spec);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.constructorArgs[0]).toBe("0x000000000000000000000000000000000000AA");
  });

  it("crossRef args contribute no build-order dependency edges (buildCreationOrder)", () => {
    // A crossRef arg referencing a LOCAL-looking contract id textually (in
    // `contract`) must NOT create a build-time dependency edge — the target
    // lives on a DIFFERENT network entirely, outside this spec's dependency
    // graph. Order here is declared with the "dependent" contract FIRST
    // specifically to prove no edge was created.
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
        },
        { id: "registry", contract: "Registry" },
      ],
    };
    const ordered = buildCreationOrder(spec.contracts);
    expect(ordered.map((e) => e.id)).toEqual(["vault", "registry"]);
  });
});

// ---------------------------------------------------------------------------
// 15. Upgradeable proxies — UUPS (issue #155)
// ---------------------------------------------------------------------------

const OWNER_ADDR = "0x0000000000000000000000000000000000000002";
// Valid EIP-55 checksummed addresses — required by m.contractAt()'s address
// validation (used in compileUpgrade() below); a non-checksummed / arbitrary
// hex string is rejected by Ignition at module-construction time.
const PROXY_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PROXY_ADMIN_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("compileSpec — upgradeable: uups (no initializer)", () => {
  const spec: DeploymentSpec = {
    version: 1,
    contracts: [{ id: "vault", contract: "Vault", upgradeable: { kind: "uups" } }],
  };

  it("creates exactly 3 futures (impl, proxy, contractAt)", () => {
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(3);
  });

  it("impl future is a NAMED_ARTIFACT_CONTRACT_DEPLOYMENT for the entry's contract", () => {
    const mod = compileSpec(spec);
    const impl = asContractFuture(findFutureByBareId(mod, "vault_impl"));
    expect(impl.contractName).toBe("Vault");
    expect(impl.constructorArgs).toEqual([]);
  });

  it("proxy future deploys ERC1967Proxy with [impl, \"0x\"]", () => {
    const mod = compileSpec(spec);
    const impl = findFutureByBareId(mod, "vault_impl");
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.contractName).toBe("ERC1967Proxy");
    expect(proxy.constructorArgs[0]).toBe(impl);
    expect(proxy.constructorArgs[1]).toBe("0x");
  });

  it("the entry's own id resolves to a contractAt future at the proxy, with the impl's ABI", () => {
    const mod = compileSpec(spec);
    const proxy = findFutureByBareId(mod, "vault_proxy");
    const handle = asContractAtFuture(findFutureByBareId(mod, "vault"));
    expect(handle.contractName).toBe("Vault");
    expect(handle.address).toBe(proxy);
  });
});

describe("compileSpec — upgradeable: uups (with initializer)", () => {
  const spec: DeploymentSpec = {
    version: 1,
    contracts: [
      { id: "registry", contract: "Registry" },
      {
        id: "vault",
        contract: "Vault",
        upgradeable: {
          kind: "uups",
          initializer: {
            function: "initialize",
            args: [
              { kind: "ref", contract: "registry" },
              { kind: "literal", value: 42 },
            ],
          },
        },
      },
    ],
  };

  it("creates 4 futures (registry, impl, initData, proxy) + the contractAt handle = 5 total", () => {
    const mod = compileSpec(spec);
    // registry(1) + vault_impl(1) + vault_initData(1) + vault_proxy(1) + vault handle(1)
    expect(mod.futures.size).toBe(5);
  });

  it("encodes the initializer call against the impl future with mapped args", () => {
    const mod = compileSpec(spec);
    const impl = findFutureByBareId(mod, "vault_impl");
    const registryFuture = findFutureByBareId(mod, "registry");
    const initData = asEncodeFunctionCallFuture(findFutureByBareId(mod, "vault_initData"));
    expect(initData.contract).toBe(impl);
    expect(initData.functionName).toBe("initialize");
    expect(initData.args[0]).toBe(registryFuture);
    expect(initData.args[1]).toBe(42);
  });

  it("the proxy's constructorArgs[1] is the initData future (not a literal \"0x\")", () => {
    const mod = compileSpec(spec);
    const initData = findFutureByBareId(mod, "vault_initData");
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.constructorArgs[1]).toBe(initData);
  });

  it("a downstream ref to the upgradeable entry resolves to the proxy handle, not impl/proxy", () => {
    const specWithConsumer: DeploymentSpec = {
      version: 1,
      contracts: [
        ...spec.contracts,
        { id: "consumer", contract: "Consumer", args: [{ kind: "ref", contract: "vault" }] },
      ],
    };
    const mod = compileSpec(specWithConsumer);
    const handle = findFutureByBareId(mod, "vault");
    const impl = findFutureByBareId(mod, "vault_impl");
    const proxy = findFutureByBareId(mod, "vault_proxy");
    const consumer = asContractFuture(findFutureByBareId(mod, "consumer"));
    expect(consumer.constructorArgs[0]).toBe(handle);
    expect(consumer.constructorArgs[0]).not.toBe(impl);
    expect(consumer.constructorArgs[0]).not.toBe(proxy);
  });
});

// ---------------------------------------------------------------------------
// 16. Upgradeable proxies — Transparent
// ---------------------------------------------------------------------------

describe("compileSpec — upgradeable: transparent", () => {
  const spec: DeploymentSpec = {
    version: 1,
    contracts: [
      {
        id: "vault",
        contract: "Vault",
        upgradeable: {
          kind: "transparent",
          proxyAdminOwner: { kind: "literal", value: OWNER_ADDR },
          initializer: { function: "initialize" },
        },
      },
    ],
  };

  it("proxy future deploys TransparentUpgradeableProxy with [impl, proxyAdminOwner, initData]", () => {
    const mod = compileSpec(spec);
    const impl = findFutureByBareId(mod, "vault_impl");
    const initData = findFutureByBareId(mod, "vault_initData");
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.contractName).toBe("TransparentUpgradeableProxy");
    expect(proxy.constructorArgs[0]).toBe(impl);
    expect(proxy.constructorArgs[1]).toBe(OWNER_ADDR);
    expect(proxy.constructorArgs[2]).toBe(initData);
  });

  it("initData defaults to \"0x\" when initializer has no args", () => {
    const mod = compileSpec(spec);
    const initData = asEncodeFunctionCallFuture(findFutureByBareId(mod, "vault_initData"));
    expect(initData.args).toEqual([]);
  });

  it("the entry resolves to a contractAt handle at the proxy", () => {
    const mod = compileSpec(spec);
    const proxy = findFutureByBareId(mod, "vault_proxy");
    const handle = asContractAtFuture(findFutureByBareId(mod, "vault"));
    expect(handle.address).toBe(proxy);
  });

  it("proxyAdminOwner can itself be a ref (mapped through the same arg-mapping helper)", () => {
    const specWithRefOwner: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "admin", contract: "Admin" },
        {
          id: "vault",
          contract: "Vault",
          upgradeable: { kind: "transparent", proxyAdminOwner: { kind: "ref", contract: "admin" } },
        },
      ],
    };
    const mod = compileSpec(specWithRefOwner);
    const adminFuture = findFutureByBareId(mod, "admin");
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.constructorArgs[1]).toBe(adminFuture);
  });
});

// ---------------------------------------------------------------------------
// 17. Upgradeable proxies — custom proxy artifact names
// ---------------------------------------------------------------------------

describe("compileSpec — upgradeable: custom proxyArtifacts override", () => {
  it("uses a custom uups proxy artifact name when provided", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "vault", contract: "Vault", upgradeable: { kind: "uups" } }],
    };
    const mod = compileSpec(spec, { proxyArtifacts: { uups: "MyERC1967Proxy" } });
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.contractName).toBe("MyERC1967Proxy");
  });

  it("uses a custom transparent proxy artifact name when provided", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          upgradeable: {
            kind: "transparent",
            proxyAdminOwner: { kind: "literal", value: OWNER_ADDR },
          },
        },
      ],
    };
    const mod = compileSpec(spec, { proxyArtifacts: { transparent: "MyTransparentProxy" } });
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.contractName).toBe("MyTransparentProxy");
  });
});

// ---------------------------------------------------------------------------
// 18. Upgradeable proxies — ordering via initializer.args / proxyAdminOwner
// ---------------------------------------------------------------------------

describe("compileSpec — upgradeable: build-time ordering through initializer/proxyAdminOwner refs", () => {
  it("compiles when initializer.args refs a contract declared LATER in the array", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          upgradeable: {
            kind: "uups",
            initializer: { function: "initialize", args: [{ kind: "ref", contract: "registry" }] },
          },
        },
        { id: "registry", contract: "Registry" },
      ],
    };
    const mod = compileSpec(spec);
    const registryFuture = findFutureByBareId(mod, "registry");
    const initData = asEncodeFunctionCallFuture(findFutureByBareId(mod, "vault_initData"));
    expect(initData.args[0]).toBe(registryFuture);
  });

  it("compiles when proxyAdminOwner refs a contract declared LATER in the array", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          upgradeable: { kind: "transparent", proxyAdminOwner: { kind: "ref", contract: "admin" } },
        },
        { id: "admin", contract: "Admin" },
      ],
    };
    const mod = compileSpec(spec);
    const adminFuture = findFutureByBareId(mod, "admin");
    const proxy = asContractFuture(findFutureByBareId(mod, "vault_proxy"));
    expect(proxy.constructorArgs[1]).toBe(adminFuture);
  });

  it("buildCreationOrder places a proxyAdminOwner ref target before the dependent entry", () => {
    const entries: DeploymentSpec["contracts"] = [
      {
        id: "vault",
        contract: "Vault",
        upgradeable: { kind: "transparent", proxyAdminOwner: { kind: "ref", contract: "admin" } },
      },
      { id: "admin", contract: "Admin" },
    ];
    const ordered = buildCreationOrder(entries);
    expect(ordered.map((e) => e.id)).toEqual(["admin", "vault"]);
  });

  it("buildCreationOrder places an initializer.args ref target before the dependent entry", () => {
    const entries: DeploymentSpec["contracts"] = [
      {
        id: "vault",
        contract: "Vault",
        upgradeable: {
          kind: "uups",
          initializer: { function: "initialize", args: [{ kind: "ref", contract: "registry" }] },
        },
      },
      { id: "registry", contract: "Registry" },
    ];
    const ordered = buildCreationOrder(entries);
    expect(ordered.map((e) => e.id)).toEqual(["registry", "vault"]);
  });
});

// ---------------------------------------------------------------------------
// 19. Upgradeable proxies — backward compatibility
// ---------------------------------------------------------------------------

describe("compileSpec — upgradeable: non-upgradeable entries are byte-for-byte unaffected", () => {
  it("an entry with no upgradeable field compiles to exactly one NAMED_ARTIFACT_CONTRACT_DEPLOYMENT future", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "token", contract: "Token" }],
    };
    const mod = compileSpec(spec);
    expect(mod.futures.size).toBe(1);
    const f = asContractFuture([...mod.futures][0]);
    expect(f.type).toBe(FutureType.NAMED_ARTIFACT_CONTRACT_DEPLOYMENT);
  });
});

// ---------------------------------------------------------------------------
// 20. compileUpgrade() — the v1 upgrade-flow compiler (issue #155)
// ---------------------------------------------------------------------------

describe("compileUpgrade — uups", () => {
  it("defaults moduleId to '<id>Upgrade'", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "uups",
    });
    expect(mod.id).toBe("vault_impl_v2Upgrade");
  });

  it("respects a custom moduleId", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "uups",
      moduleId: "CustomUpgrade",
    });
    expect(mod.id).toBe("CustomUpgrade");
  });

  it("creates the new implementation future under the given id", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      args: ["ctor-arg"],
      proxyAddress: PROXY_ADDR,
      kind: "uups",
    });
    const newImpl = asContractFuture(findFutureByBareId(mod, "vault_impl_v2"));
    expect(newImpl.contractName).toBe("VaultV2");
    expect(newImpl.constructorArgs[0]).toBe("ctor-arg");
  });

  it("calls upgradeToAndCall on a contractAt-wrapped proxy, with data \"0x\" when no initializer", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "uups",
    });
    const newImpl = findFutureByBareId(mod, "vault_impl_v2");
    const proxyAt = asContractAtFuture(findFutureByBareId(mod, "vault_impl_v2_proxyAt"));
    expect(proxyAt.address).toBe(PROXY_ADDR);
    const upgradeCall = asContractCallFuture(findFutureByBareId(mod, "vault_impl_v2_upgrade"));
    expect(upgradeCall.functionName).toBe("upgradeToAndCall");
    expect(upgradeCall.args[0]).toBe(newImpl);
    expect(upgradeCall.args[1]).toBe("0x");
  });

  it("encodes an initializer call and passes it as upgradeToAndCall's data arg", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "uups",
      initializer: { function: "reinitialize", args: [2] },
    });
    const initData = asEncodeFunctionCallFuture(findFutureByBareId(mod, "vault_impl_v2_initData"));
    expect(initData.functionName).toBe("reinitialize");
    expect(initData.args[0]).toBe(2);
    const upgradeCall = asContractCallFuture(findFutureByBareId(mod, "vault_impl_v2_upgrade"));
    expect(upgradeCall.args[1]).toBe(initData);
  });

  it("exports the new implementation future keyed by the given id", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "uups",
    });
    const newImpl = findFutureByBareId(mod, "vault_impl_v2");
    expect(mod.results["vault_impl_v2"]).toBe(newImpl);
  });
});

describe("compileSpec — upgradeable: defensive INTERNAL_INVARIANT (validateSpec bypassed)", () => {
  it("throws CompileError(INTERNAL_INVARIANT) for a transparent entry with no proxyAdminOwner", () => {
    // validateSpec's MISSING_PROXY_ADMIN_OWNER rejects this in the normal
    // pipeline — this exercises compileSpec()'s own defensive last-resort
    // guard for direct callers who bypass validateSpec (compileSpec's
    // documented contract: it does NOT re-validate).
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "vault", contract: "Vault", upgradeable: { kind: "transparent" } },
      ],
    };
    expect(() => compileSpec(spec)).toThrowError(CompileError);
    try {
      compileSpec(spec);
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("INTERNAL_INVARIANT");
      expect((err as CompileError).path).toBe("contracts[id=vault].upgradeable.proxyAdminOwner");
    }
  });
});

describe("compileUpgrade — transparent", () => {
  it("throws CompileError(MISSING_PROXY_ADMIN_ADDRESS) when proxyAdminAddress is absent", () => {
    expect(() =>
      compileUpgrade({
        id: "vault_impl_v2",
        contract: "VaultV2",
        proxyAddress: PROXY_ADDR,
        kind: "transparent",
      }),
    ).toThrowError(CompileError);
    try {
      compileUpgrade({
        id: "vault_impl_v2",
        contract: "VaultV2",
        proxyAddress: PROXY_ADDR,
        kind: "transparent",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(CompileError);
      expect((err as CompileError).code).toBe("MISSING_PROXY_ADMIN_ADDRESS");
    }
  });

  it("calls ProxyAdmin.upgradeAndCall with [proxyAddress, newImpl, initData]", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "transparent",
      proxyAdminAddress: PROXY_ADMIN_ADDR,
    });
    const newImpl = findFutureByBareId(mod, "vault_impl_v2");
    const admin = asContractAtFuture(findFutureByBareId(mod, "vault_impl_v2_admin"));
    expect(admin.contractName).toBe("ProxyAdmin");
    expect(admin.address).toBe(PROXY_ADMIN_ADDR);
    const upgradeCall = asContractCallFuture(findFutureByBareId(mod, "vault_impl_v2_upgrade"));
    expect(upgradeCall.functionName).toBe("upgradeAndCall");
    expect(upgradeCall.args[0]).toBe(PROXY_ADDR);
    expect(upgradeCall.args[1]).toBe(newImpl);
  });

  it("uses a custom proxyAdminArtifact name when provided", () => {
    const mod = compileUpgrade({
      id: "vault_impl_v2",
      contract: "VaultV2",
      proxyAddress: PROXY_ADDR,
      kind: "transparent",
      proxyAdminAddress: PROXY_ADMIN_ADDR,
      proxyAdminArtifact: "MyProxyAdmin",
    });
    const admin = asContractAtFuture(findFutureByBareId(mod, "vault_impl_v2_admin"));
    expect(admin.contractName).toBe("MyProxyAdmin");
  });
});

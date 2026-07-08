import { describe, it, expect, vi } from "vitest";
import type { EIP1193Provider } from "@nomicfoundation/ignition-core";
import {
  resolveSpecResolverArgs,
  specHasResolverArgs,
  buildResolverParams,
} from "../src/resolve/resolveSpec.js";
import { ResolveError } from "../src/resolve/errors.js";
import type { Resolver, ResolverRegistry } from "../src/resolve/registry.js";
import type { DeploymentSpec } from "../src/spec/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal EIP-1193 provider stub — most resolver tests never call it. */
function makeStubProvider(
  handler?: (args: { method: string; params?: readonly unknown[] | object }) => Promise<unknown>,
): EIP1193Provider {
  return {
    async request(args) {
      if (handler) return handler(args);
      throw new Error(`unexpected provider.request call: ${args.method}`);
    },
  };
}

// ---------------------------------------------------------------------------
// specHasResolverArgs
// ---------------------------------------------------------------------------

describe("specHasResolverArgs", () => {
  it("returns false for a spec with no args at all", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [{ id: "a", contract: "A" }] };
    expect(specHasResolverArgs(spec)).toBe(false);
  });

  it("returns false for a spec with only literal/ref/param/expr args", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "a", contract: "A" },
        {
          id: "b",
          contract: "B",
          args: [
            { kind: "literal", value: "x" },
            { kind: "ref", contract: "a" },
            { kind: "param", name: "p" },
            { kind: "expr", expression: "1n" },
          ],
        },
      ],
      parameters: { p: 1 },
    };
    expect(specHasResolverArgs(spec)).toBe(false);
  });

  it("returns true when any contract has a resolver arg", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "a", contract: "A" },
        { id: "b", contract: "B", args: [{ kind: "resolver", name: "myResolver" }] },
      ],
    };
    expect(specHasResolverArgs(spec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSpecResolverArgs — happy paths
// ---------------------------------------------------------------------------

describe("resolveSpecResolverArgs — happy paths", () => {
  it("returns the SAME spec reference when there are no resolver args (fast path)", async () => {
    const spec: DeploymentSpec = { version: 1, contracts: [{ id: "a", contract: "A" }] };
    const result = await resolveSpecResolverArgs(spec, {
      registry: {},
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result).toBe(spec);
  });

  it("leaves entries with no resolver args untouched (same object reference)", async () => {
    const untouchedEntry = { id: "a", contract: "A" };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        untouchedEntry,
        { id: "b", contract: "B", args: [{ kind: "resolver", name: "r" }] },
      ],
    };
    const registry: ResolverRegistry = { r: () => "resolved" };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result.contracts[0]).toBe(untouchedEntry);
  });

  it("substitutes a synchronous resolver's return value as a literal arg", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "Token", args: [{ kind: "resolver", name: "constName" }] },
      ],
    };
    const registry: ResolverRegistry = { constName: () => "My Token" };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result.contracts[0].args).toEqual([{ kind: "literal", value: "My Token" }]);
  });

  it("awaits an asynchronous resolver's return value", async () => {
    const registry: ResolverRegistry = {
      asyncOne: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return 42;
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "vault", contract: "Vault", args: [{ kind: "resolver", name: "asyncOne" }] }],
    };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result.contracts[0].args).toEqual([{ kind: "literal", value: 42 }]);
  });

  it.each([
    ["string", "hello"],
    ["number", 7],
    ["boolean", true],
    ["null", null],
    ["array", [1, 2, 3]],
  ] as const)("supports a resolver returning a %s LiteralValue", async (_label, value) => {
    const registry: ResolverRegistry = { r: () => value };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "r" }] }],
    };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result.contracts[0].args).toEqual([{ kind: "literal", value }]);
  });

  it("passes ResolverArg.args positionally as the resolver's second parameter", async () => {
    const resolverFn: Resolver = vi.fn((_ctx, args) => `${args[0]}-${args[1]}`);
    const registry: ResolverRegistry = { concat: resolverFn };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "a",
          contract: "A",
          args: [{ kind: "resolver", name: "concat", args: ["v1", 42] }],
        },
      ],
    };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(resolverFn).toHaveBeenCalledWith(expect.anything(), ["v1", 42]);
    expect(result.contracts[0].args).toEqual([{ kind: "literal", value: "v1-42" }]);
  });

  it("defaults ResolverArg.args to an empty array when omitted", async () => {
    const resolverFn: Resolver = vi.fn(() => "x");
    const registry: ResolverRegistry = { r: resolverFn };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "r" }] }],
    };
    await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(resolverFn).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("exposes ctx.params to the resolver", async () => {
    let observedParams: Record<string, bigint> | undefined;
    const registry: ResolverRegistry = {
      r: (ctx) => {
        observedParams = ctx.params;
        return "ok";
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "r" }] }],
    };
    await resolveSpecResolverArgs(spec, {
      registry,
      params: { threshold: 5n },
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(observedParams).toEqual({ threshold: 5n });
  });

  it("exposes ctx.resolvedAddresses to the resolver", async () => {
    let observed: Record<string, string> | undefined;
    const registry: ResolverRegistry = {
      r: (ctx) => {
        observed = ctx.resolvedAddresses;
        return "ok";
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "r" }] }],
    };
    await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: { external: "0xabc" },
      provider: makeStubProvider(),
    });
    expect(observed).toEqual({ external: "0xabc" });
  });

  it("exposes ctx.provider to the resolver and its return value flows through", async () => {
    const provider = makeStubProvider(async ({ method }) => {
      if (method === "eth_getCode") return "0x6001";
      throw new Error(`unexpected: ${method}`);
    });
    const registry: ResolverRegistry = {
      readCode: async (ctx) => {
        const code = (await ctx.provider.request({
          method: "eth_getCode",
          params: ["0x0", "latest"],
        })) as string;
        return code;
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "readCode" }] }],
    };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider,
    });
    expect(result.contracts[0].args).toEqual([{ kind: "literal", value: "0x6001" }]);
  });

  it("resolves multiple resolver args on the same entry independently", async () => {
    const registry: ResolverRegistry = {
      one: () => "first",
      two: () => "second",
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "a",
          contract: "A",
          args: [
            { kind: "resolver", name: "one" },
            { kind: "literal", value: "middle" },
            { kind: "resolver", name: "two" },
          ],
        },
      ],
    };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result.contracts[0].args).toEqual([
      { kind: "literal", value: "first" },
      { kind: "literal", value: "middle" },
      { kind: "literal", value: "second" },
    ]);
  });

  it("resolves resolver args across multiple entries", async () => {
    const registry: ResolverRegistry = { r: () => "x" };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "a", contract: "A", args: [{ kind: "resolver", name: "r" }] },
        { id: "b", contract: "B", args: [{ kind: "resolver", name: "r" }] },
      ],
    };
    const result = await resolveSpecResolverArgs(spec, {
      registry,
      params: {},
      resolvedAddresses: {},
      provider: makeStubProvider(),
    });
    expect(result.contracts[0].args).toEqual([{ kind: "literal", value: "x" }]);
    expect(result.contracts[1].args).toEqual([{ kind: "literal", value: "x" }]);
  });
});

// ---------------------------------------------------------------------------
// resolveSpecResolverArgs — errors
// ---------------------------------------------------------------------------

describe("resolveSpecResolverArgs — errors", () => {
  it("throws ResolveError(UNKNOWN_RESOLVER) when the named resolver is absent from the registry", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "ghost" }] }],
    };
    await expect(
      resolveSpecResolverArgs(spec, {
        registry: {},
        params: {},
        resolvedAddresses: {},
        provider: makeStubProvider(),
      }),
    ).rejects.toThrow(ResolveError);

    try {
      await resolveSpecResolverArgs(spec, {
        registry: {},
        params: {},
        resolvedAddresses: {},
        provider: makeStubProvider(),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolveError);
      const resolveErr = err as ResolveError;
      expect(resolveErr.code).toBe("UNKNOWN_RESOLVER");
      expect(resolveErr.message).toContain("ghost");
      expect(resolveErr.message).toContain('"a"');
    }
  });

  it("throws ResolveError(RESOLVER_ERROR) when a synchronous resolver throws", async () => {
    const registry: ResolverRegistry = {
      boom: () => {
        throw new Error("kaboom");
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "boom" }] }],
    };
    try {
      await resolveSpecResolverArgs(spec, {
        registry,
        params: {},
        resolvedAddresses: {},
        provider: makeStubProvider(),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolveError);
      expect((err as ResolveError).code).toBe("RESOLVER_ERROR");
      expect((err as ResolveError).message).toContain("boom");
      expect((err as ResolveError).message).toContain("kaboom");
    }
  });

  it("throws ResolveError(RESOLVER_ERROR) when an async resolver's promise rejects", async () => {
    const registry: ResolverRegistry = {
      boom: async () => {
        throw new Error("async kaboom");
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "boom" }] }],
    };
    await expect(
      resolveSpecResolverArgs(spec, {
        registry,
        params: {},
        resolvedAddresses: {},
        provider: makeStubProvider(),
      }),
    ).rejects.toMatchObject({ code: "RESOLVER_ERROR" });
  });

  it("wraps a non-Error throw value in the ResolveError message", async () => {
    const registry: ResolverRegistry = {
      boom: () => {
        throw "raw string throw";
      },
    };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "a", contract: "A", args: [{ kind: "resolver", name: "boom" }] }],
    };
    try {
      await resolveSpecResolverArgs(spec, {
        registry,
        params: {},
        resolvedAddresses: {},
        provider: makeStubProvider(),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ResolveError).message).toContain("raw string throw");
    }
  });
});

// ---------------------------------------------------------------------------
// buildResolverParams — bigint coercion rules
// ---------------------------------------------------------------------------

describe("buildResolverParams", () => {
  it("converts number and string spec parameters to bigint", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [],
      parameters: { a: 5, b: "10" },
    };
    const params = buildResolverParams(spec, "Deployment", undefined);
    expect(params).toEqual({ a: 5n, b: 10n });
  });

  it("converts a null spec parameter to 0n", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { a: null } };
    const params = buildResolverParams(spec, "Deployment", undefined);
    expect(params).toEqual({ a: 0n });
  });

  it("passes bigint parameter overrides through unchanged", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { a: 1 } };
    const params = buildResolverParams(spec, "Deployment", {
      Deployment: { a: 99n },
    });
    expect(params).toEqual({ a: 99n });
  });

  it("overrides the spec-declared default with deploymentParameters for the effective moduleId", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { threshold: 1 } };
    const params = buildResolverParams(spec, "MyModule", {
      MyModule: { threshold: 777 },
    });
    expect(params).toEqual({ threshold: 777n });
  });

  it("ignores deploymentParameters for a different moduleId", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { threshold: 1 } };
    const params = buildResolverParams(spec, "Deployment", {
      OtherModule: { threshold: 777 },
    });
    expect(params).toEqual({ threshold: 1n });
  });

  it("returns an empty object when the spec declares no parameters", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [] };
    expect(buildResolverParams(spec, "Deployment", undefined)).toEqual({});
  });

  it("throws ResolveError(RESOLVER_ERROR) for a boolean parameter value", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { flag: true } };
    expect(() => buildResolverParams(spec, "Deployment", undefined)).toThrow(ResolveError);
    try {
      buildResolverParams(spec, "Deployment", undefined);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ResolveError).code).toBe("RESOLVER_ERROR");
      expect((err as ResolveError).message).toContain("flag");
    }
  });

  it("throws ResolveError(RESOLVER_ERROR) for an array parameter value", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { list: [1, 2] } };
    expect(() => buildResolverParams(spec, "Deployment", undefined)).toThrow(ResolveError);
  });

  it("throws ResolveError(RESOLVER_ERROR) for a string that is not BigInt-convertible", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [], parameters: { a: "not-a-number" } };
    expect(() => buildResolverParams(spec, "Deployment", undefined)).toThrow(ResolveError);
  });
});

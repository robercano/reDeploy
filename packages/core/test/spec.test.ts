import { describe, it, expect } from "vitest";
import { validateSpec } from "../src/spec/validate.js";
import { LITERAL_MAX_DEPTH } from "../src/spec/schema.js";
import type { DeploymentSpec } from "../src/spec/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Happy-path spec: registry (no args) + token (two literals) + vault (ref + after).
 * Mirrors the real fixture contracts: Registry, Token(name, symbol), Vault(token).
 */
const happySpec: DeploymentSpec = {
  version: 1,
  contracts: [
    { id: "registry", contract: "Registry" },
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

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("validateSpec — happy path", () => {
  it("returns ok:true for a valid registry+token+vault spec", () => {
    const result = validateSpec(happySpec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.version).toBe(1);
      expect(result.spec.contracts).toHaveLength(3);
    }
  });

  it("accepts a minimal spec with no args or after", () => {
    const result = validateSpec({
      version: 1,
      contracts: [{ id: "registry", contract: "Registry" }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an empty contracts array", () => {
    const result = validateSpec({ version: 1, contracts: [] });
    expect(result.ok).toBe(true);
  });

  it("allows the same contract artifact deployed under two different ids", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "token1", contract: "Token", args: [{ kind: "literal", value: "A" }, { kind: "literal", value: "AA" }] },
        { id: "token2", contract: "Token", args: [{ kind: "literal", value: "B" }, { kind: "literal", value: "BB" }] },
        { id: "vault", contract: "Vault", args: [{ kind: "ref", contract: "token1" }] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts nested array literal values", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "multi",
          contract: "Multi",
          args: [{ kind: "literal", value: [1, [2, 3], null, true] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure: INVALID_SHAPE
// ---------------------------------------------------------------------------

describe("validateSpec — INVALID_SHAPE", () => {
  it("rejects null input", () => {
    const result = validateSpec(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("INVALID_SHAPE");
    }
  });

  it("rejects a string input", () => {
    const result = validateSpec("not a spec");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("INVALID_SHAPE");
    }
  });

  it("rejects an array at the top level", () => {
    const result = validateSpec([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe("INVALID_SHAPE");
    }
  });

  it("rejects missing version field", () => {
    const result = validateSpec({ contracts: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });

  it("rejects wrong version number", () => {
    const result = validateSpec({ version: 2, contracts: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });

  it("rejects missing contracts field", () => {
    const result = validateSpec({ version: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });

  it("rejects a contract entry with empty id", () => {
    const result = validateSpec({
      version: 1,
      contracts: [{ id: "", contract: "Token" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
      expect(result.errors.some((e) => e.path.includes("id"))).toBe(true);
    }
  });

  it("rejects a contract entry with empty contract name", () => {
    const result = validateSpec({
      version: 1,
      contracts: [{ id: "token", contract: "" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });

  it("rejects a malformed arg (bad discriminated union — unknown kind)", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ kind: "unknown", value: "foo" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });

  it("rejects a malformed arg (missing kind field entirely)", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [{ value: "foo" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });

  it("rejects a ref arg with empty contract string", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: DUPLICATE_ID
// ---------------------------------------------------------------------------

describe("validateSpec — DUPLICATE_ID", () => {
  it("rejects two contracts with the same id", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token2" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dupError = result.errors.find((e) => e.code === "DUPLICATE_ID");
      expect(dupError).toBeDefined();
      expect(dupError?.message).toContain("token");
    }
  });

  it("includes the duplicate id name in the error message", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "myVault", contract: "Vault" },
        { id: "myVault", contract: "Vault2" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dupError = result.errors.find((e) => e.code === "DUPLICATE_ID");
      expect(dupError?.message).toContain("myVault");
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: MISSING_REF (in args)
// ---------------------------------------------------------------------------

describe("validateSpec — MISSING_REF in args", () => {
  it("rejects a ref to a non-existent contract id in args", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "nonExistent" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const refError = result.errors.find((e) => e.code === "MISSING_REF");
      expect(refError).toBeDefined();
      expect(refError?.message).toContain("nonExistent");
    }
  });

  it("includes the offending contract id in the error message", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "missingToken" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((e) => e.code === "MISSING_REF");
      expect(e?.message).toContain("missingToken");
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: MISSING_REF (in after)
// ---------------------------------------------------------------------------

describe("validateSpec — MISSING_REF in after", () => {
  it("rejects an after entry referencing a non-existent id", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          after: ["ghostContract"],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const refError = result.errors.find((e) => e.code === "MISSING_REF");
      expect(refError).toBeDefined();
      expect(refError?.message).toContain("ghostContract");
    }
  });

  it("includes the offending id in the path", () => {
    const result = validateSpec({
      version: 1,
      contracts: [{ id: "vault", contract: "Vault", after: ["missing"] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((e) => e.code === "MISSING_REF");
      expect(e?.path).toMatch(/after/);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: SELF_REFERENCE
// ---------------------------------------------------------------------------

describe("validateSpec — SELF_REFERENCE", () => {
  it("rejects a contract that references its own id in args", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "vault" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const selfErr = result.errors.find((e) => e.code === "SELF_REFERENCE");
      expect(selfErr).toBeDefined();
      expect(selfErr?.message).toContain("vault");
    }
  });

  it("rejects a contract that lists itself in after", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          after: ["vault"],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const selfErr = result.errors.find((e) => e.code === "SELF_REFERENCE");
      expect(selfErr).toBeDefined();
      expect(selfErr?.message).toContain("vault");
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: CYCLE — direct 2-cycle (A→B→A)
// ---------------------------------------------------------------------------

describe("validateSpec — CYCLE (2-node A→B→A)", () => {
  it("detects a direct 2-cycle via args refs", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "a", contract: "A", args: [{ kind: "ref", contract: "b" }] },
        { id: "b", contract: "B", args: [{ kind: "ref", contract: "a" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErrors = result.errors.filter((e) => e.code === "CYCLE");
      expect(cycleErrors.length).toBeGreaterThan(0);
      const ids = cycleErrors.map((e) => e.message).join(" ");
      expect(ids).toMatch(/[ab]/);
    }
  });

  it("detects a 2-cycle via after entries", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "a", contract: "A", after: ["b"] },
        { id: "b", contract: "B", after: ["a"] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErrors = result.errors.filter((e) => e.code === "CYCLE");
      expect(cycleErrors.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: CYCLE — indirect 3-cycle (A→B→C→A)
// ---------------------------------------------------------------------------

describe("validateSpec — CYCLE (3-node A→B→C→A)", () => {
  it("detects an indirect 3-node cycle", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "a", contract: "A", args: [{ kind: "ref", contract: "c" }] },
        { id: "b", contract: "B", args: [{ kind: "ref", contract: "a" }] },
        { id: "c", contract: "C", args: [{ kind: "ref", contract: "b" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErrors = result.errors.filter((e) => e.code === "CYCLE");
      expect(cycleErrors.length).toBeGreaterThan(0);
      // All three should be flagged
      const msgs = cycleErrors.map((e) => e.message).join(" ");
      expect(msgs).toMatch(/a/);
      expect(msgs).toMatch(/b/);
      expect(msgs).toMatch(/c/);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure: mixed ref+after cycle
// ---------------------------------------------------------------------------

describe("validateSpec — CYCLE (mixed ref and after edges)", () => {
  it("detects a cycle spanning both ref edges and after edges", () => {
    // a deps on b via ref, b deps on a via after
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "a", contract: "A", args: [{ kind: "ref", contract: "b" }] },
        { id: "b", contract: "B", after: ["a"] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErrors = result.errors.filter((e) => e.code === "CYCLE");
      expect(cycleErrors.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Error collection — multiple errors at once
// ---------------------------------------------------------------------------

describe("validateSpec — collects ALL errors", () => {
  it("reports both duplicate id and missing ref in the same result", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token2" }, // duplicate id
        { id: "vault", contract: "Vault", args: [{ kind: "ref", contract: "ghost" }] }, // missing ref
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_ID");
      expect(codes).toContain("MISSING_REF");
    }
  });
});

// ---------------------------------------------------------------------------
// Large graph — no stack overflow
// ---------------------------------------------------------------------------

describe("validateSpec — large graph (stack overflow safety)", () => {
  it("handles a 1000-node linear chain without stack overflow", () => {
    const n = 1000;
    const contracts = Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      contract: "C",
      ...(i > 0 ? { after: [`c${i - 1}`] } : {}),
    }));
    const result = validateSpec({ version: 1, contracts });
    expect(result.ok).toBe(true);
  });

  it("detects a cycle in a 1000-node chain with one back-edge (c0 depends on last)", () => {
    const n = 1000;
    // Chain: c1 after c0, c2 after c1, ..., c(n-1) after c(n-2)
    // Back-edge: c0 after c(n-1) — creates a full cycle
    const contracts = Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      contract: "C",
      after: i > 0 ? [`c${i - 1}`] : [`c${n - 1}`],
    }));
    const result = validateSpec({ version: 1, contracts });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErrors = result.errors.filter((e) => e.code === "CYCLE");
      expect(cycleErrors.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Literal nesting depth — DoS / stack-overflow safety
// ---------------------------------------------------------------------------

describe("validateSpec — literal nesting depth safety", () => {
  /**
   * Build an array nested `depth` levels deep using an iterative loop.
   * At depth 0 this is the scalar 42; at depth 1 it is [42]; at depth 2 it
   * is [[42]], and so on.  We never recurse here to avoid a stack overflow in
   * the test builder itself.
   */
  function buildNestedArray(depth: number): unknown {
    let current: unknown = 42;
    for (let i = 0; i < depth; i++) {
      current = [current];
    }
    return current;
  }

  it("rejects a deeply nested literal (50_000 levels) without throwing", () => {
    // Build an array nested 50_000 deep using an iterative loop — never recurse.
    const deepValue = buildNestedArray(50_000);
    const spec = {
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: deepValue }],
        },
      ],
    };

    // Must not throw (the documented contract of validateSpec).
    let result!: ReturnType<typeof validateSpec>;
    expect(() => {
      result = validateSpec(spec);
    }).not.toThrow();

    // Must return a structured rejection with INVALID_SHAPE.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const shapeErrors = result.errors.filter((e) => e.code === "INVALID_SHAPE");
      expect(shapeErrors.length).toBeGreaterThan(0);
    }
  });

  it("accepts a literal nested just within the depth cap (depth 10)", () => {
    // Depth 10 is well within LITERAL_MAX_DEPTH (32), so it should pass.
    expect(10).toBeLessThanOrEqual(LITERAL_MAX_DEPTH);
    const nestedValue = buildNestedArray(10);
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [{ kind: "literal", value: nestedValue }],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a literal at exactly LITERAL_MAX_DEPTH + 1 levels", () => {
    // One level beyond the cap should be cleanly rejected.
    const tooDeep = buildNestedArray(LITERAL_MAX_DEPTH + 1);
    let result!: ReturnType<typeof validateSpec>;
    expect(() => {
      result = validateSpec({
        version: 1,
        contracts: [
          {
            id: "c",
            contract: "C",
            args: [{ kind: "literal", value: tooDeep }],
          },
        ],
      });
    }).not.toThrow();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const shapeErrors = result.errors.filter((e) => e.code === "INVALID_SHAPE");
      expect(shapeErrors.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ParamArg — named parameters + per-network overrides (issue #98)
// ---------------------------------------------------------------------------

describe("validateSpec — ParamArg happy path", () => {
  it("accepts a param arg whose name is declared in top-level parameters", () => {
    const result = validateSpec({
      version: 1,
      parameters: { initialOwner: "0x0000000000000000000000000000000000000001" },
      contracts: [
        {
          id: "registry",
          contract: "Registry",
          args: [{ kind: "param", name: "initialOwner" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts multiple param args referencing distinct declared parameters", () => {
    const result = validateSpec({
      version: 1,
      parameters: { name: "My Token", symbol: "MTK" },
      contracts: [
        {
          id: "token",
          contract: "Token",
          args: [
            { kind: "param", name: "name" },
            { kind: "param", name: "symbol" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a mix of literal, ref, and param args in the same contract", () => {
    const result = validateSpec({
      version: 1,
      parameters: { threshold: 3 },
      contracts: [
        { id: "registry", contract: "Registry" },
        {
          id: "vault",
          contract: "Vault",
          args: [
            { kind: "ref", contract: "registry" },
            { kind: "literal", value: "Vault Name" },
            { kind: "param", name: "threshold" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("allows declared parameters that are never referenced by any arg", () => {
    const result = validateSpec({
      version: 1,
      parameters: { unused: "value" },
      contracts: [{ id: "registry", contract: "Registry" }],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateSpec — UNKNOWN_PARAM", () => {
  it("rejects a param arg whose name is not declared anywhere (no parameters block)", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        {
          id: "registry",
          contract: "Registry",
          args: [{ kind: "param", name: "initialOwner" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === "UNKNOWN_PARAM");
      expect(err).toBeDefined();
      expect(err!.path).toBe("contracts[0].args[0].name");
      expect(err!.message).toContain("initialOwner");
    }
  });

  it("rejects a param arg whose name is not among the declared parameters", () => {
    const result = validateSpec({
      version: 1,
      parameters: { owner: "0x1" },
      contracts: [
        {
          id: "registry",
          contract: "Registry",
          args: [{ kind: "param", name: "typoedName" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("UNKNOWN_PARAM");
    }
  });

  it("collects UNKNOWN_PARAM alongside other error kinds in the same result", () => {
    const result = validateSpec({
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token2" }, // duplicate id
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "param", name: "ghostParam" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_ID");
      expect(codes).toContain("UNKNOWN_PARAM");
    }
  });
});

describe("validateSpec — parameters shape", () => {
  it("accepts an empty parameters object", () => {
    const result = validateSpec({
      version: 1,
      parameters: {},
      contracts: [{ id: "registry", contract: "Registry" }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts array and null literal values in parameters", () => {
    const result = validateSpec({
      version: 1,
      parameters: { list: [1, 2, 3], nothing: null },
      contracts: [
        {
          id: "c",
          contract: "C",
          args: [
            { kind: "param", name: "list" },
            { kind: "param", name: "nothing" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a parameters value that is not a valid LiteralValue (e.g. a nested object)", () => {
    const result = validateSpec({
      version: 1,
      parameters: { bad: { nested: "object" } },
      contracts: [{ id: "registry", contract: "Registry" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_SHAPE")).toBe(true);
    }
  });
});

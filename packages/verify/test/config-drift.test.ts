/**
 * Tests for config drift detection (verifyConfig).
 *
 * All tests use a mock ChainReader — no real chain connection.
 *
 * Coverage targets:
 *   - MATCH: all steps return declared values → all "match", clean: true
 *   - DRIFT: one step returns mutated value → that step "drift", others "match"
 *   - grantRole: hasRole true → match; hasRole false → drift
 *   - wire: getter returns source address → match; different address → drift;
 *           differently-cased address → still match (normalization)
 *   - numeric normalization: 500 vs 500n / "500" / "0x1f4" → match; 501 → drift
 *   - ChainReader.call throws → step status "error" (verifyConfig does NOT throw)
 *   - Setup errors: unknown ref → thrown ConfigVerifyError(UNKNOWN_REF)
 *                  missing getter for setX → thrown ConfigVerifyError(MISSING_GETTER_MAPPING)
 *                  missing getter for wire → thrown ConfigVerifyError(MISSING_GETTER_MAPPING)
 *                  malformed spec (empty id) → thrown ConfigVerifyError(MALFORMED_SPEC)
 */

import { describe, it, expect, vi } from "vitest";
import {
  verifyConfig,
  ConfigVerifyError,
  valuesEqual,
} from "../src/index.js";
import type { ChainReader } from "../src/index.js";
import type { ConfigSpec } from "@redeploy/config";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ADDR_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_VAULT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDR_FEE   = "0xcccccccccccccccccccccccccccccccccccccccc";
const ADDR_MINTER = "0xdddddddddddddddddddddddddddddddddddddddd";

/** Deployed address map used across most tests. */
const deployedAddresses: Record<string, string> = {
  token: ADDR_TOKEN,
  vault: ADDR_VAULT,
  feeController: ADDR_FEE,
  minterContract: ADDR_MINTER,
};

/**
 * Create a mock ChainReader that returns a value per (address, function).
 * callMap keys are `${address}::${functionName}`.
 * Unrecognised calls throw with a useful message.
 */
function makeMockReader(
  callMap: Record<string, unknown>,
  overrides: Partial<ChainReader> = {},
): ChainReader {
  return {
    call: vi.fn(async ({ address, function: fn }) => {
      const key = `${address}::${fn}`;
      if (key in callMap) return callMap[key];
      throw new Error(`Unexpected mock call: ${key}`);
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// valuesEqual unit tests
// ---------------------------------------------------------------------------

describe("valuesEqual — normalization helper", () => {
  // Addresses
  it("compares addresses case-insensitively", () => {
    expect(valuesEqual("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
                       "0xabcdef1234567890abcdef1234567890abcdef12")).toBe(true);
    expect(valuesEqual("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                       "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
  });

  it("addresses that differ → false", () => {
    expect(valuesEqual(ADDR_TOKEN, ADDR_VAULT)).toBe(false);
  });

  it("does NOT do case-insensitive compare for non-address strings", () => {
    expect(valuesEqual("Hello", "hello")).toBe(false);
  });

  // Numerics
  it("500 (number) === 500n (bigint)", () => {
    expect(valuesEqual(500, 500n)).toBe(true);
  });

  it("500 (number) === '500' (decimal string)", () => {
    expect(valuesEqual(500, "500")).toBe(true);
  });

  it("500 (number) === '0x1f4' (hex string)", () => {
    expect(valuesEqual(500, "0x1f4")).toBe(true);
  });

  it("500n === '0x1f4'", () => {
    expect(valuesEqual(500n, "0x1f4")).toBe(true);
  });

  it("500 !== 501 (numeric drift)", () => {
    expect(valuesEqual(500, 501)).toBe(false);
  });

  it("500 !== 501n", () => {
    expect(valuesEqual(500, 501n)).toBe(false);
  });

  // Booleans
  it("true === true", () => {
    expect(valuesEqual(true, true)).toBe(true);
  });

  it("true !== false", () => {
    expect(valuesEqual(true, false)).toBe(false);
  });

  // null
  it("null === null", () => {
    expect(valuesEqual(null, null)).toBe(true);
  });

  it("null !== undefined", () => {
    expect(valuesEqual(null, undefined)).toBe(false);
  });

  // Plain strings (non-address)
  it("identical strings === true", () => {
    expect(valuesEqual("MINTER_ROLE", "MINTER_ROLE")).toBe(true);
  });

  it("different strings === false", () => {
    expect(valuesEqual("MINTER_ROLE", "ADMIN_ROLE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MATCH: all steps match
// ---------------------------------------------------------------------------

describe("verifyConfig() — all steps match (clean: true)", () => {
  it("setX step: getter returns declared value → match, clean: true", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: 500n });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "set-fee": {
          function: "getFee",
          expected: { kind: "literal", value: 500 },
        },
      },
    });

    expect(result.clean).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("match");
    expect(result.results[0].id).toBe("set-fee");
  });

  it("grantRole step: hasRole returns true → match, clean: true", async () => {
    const spec: ConfigSpec = {
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
    };

    const reader = makeMockReader({
      [`${ADDR_TOKEN}::hasRole`]: true,
    });

    const result = await verifyConfig({ spec, deployedAddresses, reader });

    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
    expect(result.results[0].expected).toBe(true);
    expect(result.results[0].actual).toBe(true);
  });

  it("wire step: getter returns source address → match, clean: true", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "wire",
          id: "wire-token-into-vault",
          source: "token",
          into: "vault",
          function: "setToken",
        },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_VAULT}::getToken`]: ADDR_TOKEN });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "wire-token-into-vault": { function: "getToken" },
      },
    });

    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
    expect(result.results[0].expected).toBe(ADDR_TOKEN);
    expect(result.results[0].actual).toBe(ADDR_TOKEN);
  });

  it("mixed steps: setX + grantRole + wire, all match → clean: true", async () => {
    const spec: ConfigSpec = {
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

    const reader = makeMockReader({
      [`${ADDR_FEE}::getFee`]: 500n,
      [`${ADDR_TOKEN}::hasRole`]: true,
      [`${ADDR_VAULT}::getToken`]: ADDR_TOKEN,
    });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } },
        "wire-token-into-vault": { function: "getToken" },
      },
    });

    expect(result.clean).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.status === "match")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DRIFT: at least one step drifts
// ---------------------------------------------------------------------------

describe("verifyConfig() — drift cases (clean: false)", () => {
  it("setX drift: getter returns different value → drift for that step, others still match", async () => {
    const spec: ConfigSpec = {
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
      ],
    };

    const reader = makeMockReader({
      [`${ADDR_FEE}::getFee`]: 999n,  // wrong value → drift
      [`${ADDR_TOKEN}::hasRole`]: true, // correct
    });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } },
      },
    });

    expect(result.clean).toBe(false);
    const feeDrift = result.results.find((r) => r.id === "set-fee");
    const grantMatch = result.results.find((r) => r.id === "grant-minter");

    expect(feeDrift?.status).toBe("drift");
    expect(feeDrift?.expected).toBe(500);  // literal 500, not 500n
    expect(feeDrift?.actual).toBe(999n);
    expect(feeDrift?.message).toBeTruthy();

    expect(grantMatch?.status).toBe("match");
  });

  it("grantRole drift: hasRole returns false → drift", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "literal", value: ADDR_MINTER },
        },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_TOKEN}::hasRole`]: false });

    const result = await verifyConfig({ spec, deployedAddresses, reader });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("drift");
    expect(result.results[0].expected).toBe(true);
    expect(result.results[0].actual).toBe(false);
    expect(result.results[0].message).toBeTruthy();
  });

  it("wire drift: getter returns different address → drift", async () => {
    const WRONG_ADDR = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "wire",
          id: "wire-token-into-vault",
          source: "token",
          into: "vault",
          function: "setToken",
        },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_VAULT}::getToken`]: WRONG_ADDR });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: { "wire-token-into-vault": { function: "getToken" } },
    });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("drift");
    expect(result.results[0].expected).toBe(ADDR_TOKEN);
    expect(result.results[0].actual).toBe(WRONG_ADDR);
  });

  it("wire match: getter returns DIFFERENTLY-CASED address → still match (normalization)", async () => {
    // Make it a valid mixed-case address for normalization test
    const CHECKSUMMED = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    const addrMap = { ...deployedAddresses, token: CHECKSUMMED };
    const chainReturns = CHECKSUMMED.toLowerCase();

    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "wire",
          id: "wire-token-into-vault",
          source: "token",
          into: "vault",
          function: "setToken",
        },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_VAULT}::getToken`]: chainReturns });

    const result = await verifyConfig({
      spec,
      deployedAddresses: addrMap,
      reader,
      reads: { "wire-token-into-vault": { function: "getToken" } },
    });

    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
  });

  it("wire match with uppercase source address in deployedAddresses → still match", async () => {
    const ADDR_TOKEN_CHECKSUM = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
    const ADDR_TOKEN_LOWER    = ADDR_TOKEN_CHECKSUM.toLowerCase();

    const addrMap = { ...deployedAddresses, token: ADDR_TOKEN_CHECKSUM };
    const spec: ConfigSpec = {
      version: 1,
      steps: [{ kind: "wire", id: "wire-token", source: "token", into: "vault", function: "getToken" }],
    };

    const reader = makeMockReader({ [`${ADDR_VAULT}::getToken`]: ADDR_TOKEN_LOWER });
    const result = await verifyConfig({
      spec,
      deployedAddresses: addrMap,
      reader,
      reads: { "wire-token": { function: "getToken" } },
    });

    expect(result.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Numeric normalization
// ---------------------------------------------------------------------------

describe("verifyConfig() — numeric normalization", () => {
  function makeSetFeeSpec(): ConfigSpec {
    return {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };
  }

  const reads = {
    "set-fee": {
      function: "getFee",
      expected: { kind: "literal" as const, value: 500 },
    },
  };

  it("expected 500 (number), chain returns 500n → match", async () => {
    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: 500n });
    const result = await verifyConfig({ spec: makeSetFeeSpec(), deployedAddresses, reader, reads });
    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
  });

  it("expected 500 (number), chain returns '500' (decimal string) → match", async () => {
    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: "500" });
    const result = await verifyConfig({ spec: makeSetFeeSpec(), deployedAddresses, reader, reads });
    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
  });

  it("expected 500 (number), chain returns '0x1f4' (hex string) → match", async () => {
    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: "0x1f4" });
    const result = await verifyConfig({ spec: makeSetFeeSpec(), deployedAddresses, reader, reads });
    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
  });

  it("expected 500 (number), chain returns 501 → drift", async () => {
    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: 501 });
    const result = await verifyConfig({ spec: makeSetFeeSpec(), deployedAddresses, reader, reads });
    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("drift");
  });

  it("expected 500 (number), chain returns 501n → drift", async () => {
    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: 501n });
    const result = await verifyConfig({ spec: makeSetFeeSpec(), deployedAddresses, reader, reads });
    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("drift");
  });

  it("expected 0x1f4 literal string, chain returns 500n → match", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [{ kind: "setX", id: "set-fee", target: "feeController", function: "setFee" }],
    };
    const hexReads = {
      "set-fee": {
        function: "getFee",
        expected: { kind: "literal" as const, value: "0x1f4" },
      },
    };
    const reader = makeMockReader({ [`${ADDR_FEE}::getFee`]: 500n });
    const result = await verifyConfig({ spec, deployedAddresses, reader, reads: hexReads });
    expect(result.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ChainReader throws → step status "error"
// ---------------------------------------------------------------------------

describe("verifyConfig() — ChainReader.call throws → status 'error'", () => {
  it("setX: reader throws → step 'error', verifyConfig does NOT throw", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
      ],
    };

    const reader: ChainReader = {
      call: vi.fn().mockRejectedValue(new Error("network timeout")),
    };

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "set-fee": {
          function: "getFee",
          expected: { kind: "literal", value: 500 },
        },
      },
    });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("network timeout");
    expect(result.results[0].actual).toBeUndefined();
    expect(result.results[0].expected).toBe(500);
  });

  it("grantRole: reader throws → step 'error', verifyConfig does NOT throw", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "literal", value: ADDR_MINTER },
        },
      ],
    };

    const reader: ChainReader = {
      call: vi.fn().mockRejectedValue(new Error("revert")),
    };

    const result = await verifyConfig({ spec, deployedAddresses, reader });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("revert");
  });

  it("wire: reader throws → step 'error', verifyConfig does NOT throw", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "wire", id: "wire-token", source: "token", into: "vault", function: "setToken" },
      ],
    };

    const reader: ChainReader = {
      call: vi.fn().mockRejectedValue(new Error("execution reverted")),
    };

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: { "wire-token": { function: "getToken" } },
    });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].expected).toBe(ADDR_TOKEN);
    expect(result.results[0].message).toContain("execution reverted");
  });

  it("non-Error thrown object → step 'error' with string message", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
      ],
    };

    const reader: ChainReader = {
      call: vi.fn().mockRejectedValue("raw string error"),
    };

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: { "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } } },
    });

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toBe("raw string error");
  });

  it("one error step does not abort remaining steps", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "literal", value: ADDR_MINTER },
        },
      ],
    };

    let callCount = 0;
    const reader: ChainReader = {
      call: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first call fails");
        return true; // hasRole returns true
      }),
    };

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: { "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } } },
    });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("error");
    expect(result.results[1].status).toBe("match");
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Setup errors — thrown ConfigVerifyError
// ---------------------------------------------------------------------------

describe("verifyConfig() — setup errors (ConfigVerifyError thrown)", () => {
  it("throws UNKNOWN_REF when target id not in deployedAddresses", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "UNKNOWN_CONTRACT", function: "setFee" },
      ],
    };

    await expect(
      verifyConfig({
        spec,
        deployedAddresses,
        reader: makeMockReader({}),
        reads: { "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } } },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ConfigVerifyError &&
        err.code === "UNKNOWN_REF" &&
        err.name === "ConfigVerifyError"
      );
    });
  });

  it("throws UNKNOWN_REF when ref arg contract id not in deployedAddresses", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "ref", contract: "UNKNOWN_MINTER" },
        },
      ],
    };

    await expect(
      verifyConfig({ spec, deployedAddresses, reader: makeMockReader({}) }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "UNKNOWN_REF";
    });
  });

  it("throws UNKNOWN_REF when wire source not in deployedAddresses", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "wire", id: "wire-tok", source: "UNKNOWN_TOKEN", into: "vault", function: "setToken" },
      ],
    };

    await expect(
      verifyConfig({
        spec,
        deployedAddresses,
        reader: makeMockReader({}),
        reads: { "wire-tok": { function: "getToken" } },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "UNKNOWN_REF";
    });
  });

  it("throws UNKNOWN_REF when wire into not in deployedAddresses", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "wire", id: "wire-tok", source: "token", into: "UNKNOWN_VAULT", function: "setToken" },
      ],
    };

    await expect(
      verifyConfig({
        spec,
        deployedAddresses,
        reader: makeMockReader({}),
        reads: { "wire-tok": { function: "getToken" } },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "UNKNOWN_REF";
    });
  });

  it("throws MISSING_GETTER_MAPPING when setX step has no read descriptor", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
      ],
    };

    await expect(
      verifyConfig({
        spec,
        deployedAddresses,
        reader: makeMockReader({}),
        // reads not provided for "set-fee"
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "MISSING_GETTER_MAPPING";
    });
  });

  it("throws MISSING_GETTER_MAPPING when setX read descriptor is missing 'expected'", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
      ],
    };

    await expect(
      verifyConfig({
        spec,
        deployedAddresses,
        reader: makeMockReader({}),
        reads: { "set-fee": { function: "getFee" } }, // no `expected`
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "MISSING_GETTER_MAPPING";
    });
  });

  it("throws MISSING_GETTER_MAPPING when wire step has no read descriptor", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "wire", id: "wire-token", source: "token", into: "vault", function: "setToken" },
      ],
    };

    await expect(
      verifyConfig({
        spec,
        deployedAddresses,
        reader: makeMockReader({}),
        // no reads provided
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "MISSING_GETTER_MAPPING";
    });
  });

  it("throws MALFORMED_SPEC for a step with an empty id", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "grantRole", id: "", target: "token", role: "MINTER_ROLE",
          account: { kind: "literal", value: ADDR_MINTER } },
      ],
    };

    await expect(
      verifyConfig({ spec, deployedAddresses, reader: makeMockReader({}) }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "MALFORMED_SPEC";
    });
  });

  it("throws MALFORMED_SPEC for empty steps array", async () => {
    const spec: ConfigSpec = { version: 1, steps: [] };

    await expect(
      verifyConfig({ spec, deployedAddresses, reader: makeMockReader({}) }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "MALFORMED_SPEC";
    });
  });

  it("ConfigVerifyError has correct .name and is instanceof Error", async () => {
    const spec: ConfigSpec = { version: 1, steps: [] };

    try {
      await verifyConfig({ spec, deployedAddresses, reader: makeMockReader({}) });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigVerifyError);
      expect(err).toBeInstanceOf(Error);
      expect((err as ConfigVerifyError).name).toBe("ConfigVerifyError");
      expect((err as ConfigVerifyError).code).toBe("MALFORMED_SPEC");
    }
  });
});

// ---------------------------------------------------------------------------
// grantRole — detailed verification
// ---------------------------------------------------------------------------

describe("verifyConfig() — grantRole detail", () => {
  it("grantRole with literal account: hasRole true → match", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-admin",
          target: "token",
          role: "DEFAULT_ADMIN_ROLE",
          account: { kind: "literal", value: ADDR_MINTER },
        },
      ],
    };

    const reader: ChainReader = {
      call: vi.fn(async ({ args }) => {
        // Verify hasRole is called with the right arguments
        expect(args?.[0]).toBe("DEFAULT_ADMIN_ROLE");
        expect(args?.[1]).toBe(ADDR_MINTER);
        return true;
      }),
    };

    const result = await verifyConfig({ spec, deployedAddresses, reader });

    expect(result.clean).toBe(true);
    expect(result.results[0].status).toBe("match");
    expect(reader.call).toHaveBeenCalledWith({
      address: ADDR_TOKEN,
      function: "hasRole",
      args: ["DEFAULT_ADMIN_ROLE", ADDR_MINTER],
    });
  });

  it("grantRole with ref account: resolves address then checks hasRole", async () => {
    const spec: ConfigSpec = {
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
    };

    const reader: ChainReader = {
      call: vi.fn(async ({ args }) => {
        // account arg should be the resolved address
        expect(args?.[1]).toBe(ADDR_MINTER);
        return false; // role not granted
      }),
    };

    const result = await verifyConfig({ spec, deployedAddresses, reader });
    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("drift");
  });
});

// ---------------------------------------------------------------------------
// setX — expected as ref arg
// ---------------------------------------------------------------------------

describe("verifyConfig() — setX with ref expected value", () => {
  it("expected is a ref arg that resolves to token address — chain returns same → match", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-treasury", target: "feeController", function: "setTreasury" },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_FEE}::getTreasury`]: ADDR_TOKEN });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "set-treasury": {
          function: "getTreasury",
          expected: { kind: "ref", contract: "token" },
        },
      },
    });

    expect(result.clean).toBe(true);
    expect(result.results[0].expected).toBe(ADDR_TOKEN);
  });

  it("expected is a ref arg — chain returns different address → drift", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-treasury", target: "feeController", function: "setTreasury" },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_FEE}::getTreasury`]: ADDR_VAULT });

    const result = await verifyConfig({
      spec,
      deployedAddresses,
      reader,
      reads: {
        "set-treasury": {
          function: "getTreasury",
          expected: { kind: "ref", contract: "token" },
        },
      },
    });

    expect(result.clean).toBe(false);
    expect(result.results[0].status).toBe("drift");
    expect(result.results[0].expected).toBe(ADDR_TOKEN);
    expect(result.results[0].actual).toBe(ADDR_VAULT);
  });
});

// ---------------------------------------------------------------------------
// Result ordering
// ---------------------------------------------------------------------------

describe("verifyConfig() — result ordering", () => {
  it("results are returned in the same order as spec.steps", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "grantRole", id: "step-a", target: "token", role: "ROLE_A",
          account: { kind: "literal", value: ADDR_MINTER } },
        { kind: "grantRole", id: "step-b", target: "token", role: "ROLE_B",
          account: { kind: "literal", value: ADDR_MINTER } },
        { kind: "grantRole", id: "step-c", target: "token", role: "ROLE_C",
          account: { kind: "literal", value: ADDR_MINTER } },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_TOKEN}::hasRole`]: true });

    const result = await verifyConfig({ spec, deployedAddresses, reader });

    expect(result.results.map((r) => r.id)).toEqual(["step-a", "step-b", "step-c"]);
  });
});

// ---------------------------------------------------------------------------
// ConfigVerifyErrorCode coverage
// ---------------------------------------------------------------------------

describe("ConfigVerifyError — all codes can be constructed", () => {
  it("constructs with each ConfigVerifyErrorCode", () => {
    const codes = ["UNKNOWN_REF", "MISSING_GETTER_MAPPING", "MALFORMED_SPEC"] as const;
    for (const code of codes) {
      const err = new ConfigVerifyError(code, `test: ${code}`);
      expect(err.code).toBe(code);
      expect(err.name).toBe("ConfigVerifyError");
      expect(err.message).toBe(`test: ${code}`);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// Options.reads is undefined vs empty object
// ---------------------------------------------------------------------------

describe("verifyConfig() — reads map edge cases", () => {
  it("reads = undefined works for grantRole-only spec (grantRole does not need reads)", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "literal", value: ADDR_MINTER },
        },
      ],
    };

    const reader = makeMockReader({ [`${ADDR_TOKEN}::hasRole`]: true });
    const result = await verifyConfig({ spec, deployedAddresses, reader });

    expect(result.clean).toBe(true);
  });

  it("reads = {} throws MISSING_GETTER_MAPPING for setX step", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [{ kind: "setX", id: "set-fee", target: "feeController", function: "setFee" }],
    };

    await expect(
      verifyConfig({ spec, deployedAddresses, reader: makeMockReader({}), reads: {} }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof ConfigVerifyError && err.code === "MISSING_GETTER_MAPPING";
    });
  });
});

// ---------------------------------------------------------------------------
// Exported types can be imported and used (type-level sanity)
// ---------------------------------------------------------------------------

describe("verifyConfig() — exported API surface", () => {
  it("verifyConfig is exported from index.ts", () => {
    expect(typeof verifyConfig).toBe("function");
  });

  it("ConfigVerifyError is exported from index.ts", () => {
    expect(typeof ConfigVerifyError).toBe("function");
    const err = new ConfigVerifyError("UNKNOWN_REF", "test");
    expect(err).toBeInstanceOf(ConfigVerifyError);
  });
});

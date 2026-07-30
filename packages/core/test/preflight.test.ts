/**
 * Unit tests for the PREFLIGHT phase (deploy/preflight.ts).
 *
 * `runPreflight` is tested in isolation against a stub EIP-1193 provider that
 * returns canned `eth_chainId` / `eth_getBalance` / `eth_gasPrice` responses.
 * We assert:
 *   - all-pass (no failures) when every configured check is satisfied.
 *   - each individual check failing on its own.
 *   - multiple simultaneous failures are ALL collected (not fail-fast).
 *   - a policy with no fields set makes ZERO provider calls (the "no-op"
 *     contract that lets deploy() skip the whole phase for free).
 *
 * `mergePreflightPolicies` and `isEmptyPreflightPolicy` (the small helpers
 * deploy() uses to compute the effective policy) are also covered directly.
 */

import { describe, it, expect, vi } from "vitest";
import type { EIP1193Provider } from "@nomicfoundation/ignition-core";
import {
  runPreflight,
  mergePreflightPolicies,
  isEmptyPreflightPolicy,
} from "../src/deploy/preflight.js";
import type { PreflightPolicy } from "../src/deploy/preflight.js";

// ---------------------------------------------------------------------------
// Helpers — stub EIP-1193 provider
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

interface StubRpcResponses {
  eth_chainId?: string;
  eth_getBalance?: string;
  eth_gasPrice?: string;
}

/**
 * Builds a minimal stub EIP1193Provider that answers only the three RPC
 * methods runPreflight can call, each with a canned hex-quantity response.
 * Any other method throws — runPreflight must never call anything else.
 */
function makeStubProvider(responses: StubRpcResponses): {
  provider: EIP1193Provider;
  calls: string[];
} {
  const calls: string[] = [];
  const provider: EIP1193Provider = {
    async request({ method }: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          if (responses.eth_chainId === undefined) throw new Error("unexpected eth_chainId call");
          return responses.eth_chainId;
        case "eth_getBalance":
          if (responses.eth_getBalance === undefined) throw new Error("unexpected eth_getBalance call");
          return responses.eth_getBalance;
        case "eth_gasPrice":
          if (responses.eth_gasPrice === undefined) throw new Error("unexpected eth_gasPrice call");
          return responses.eth_gasPrice;
        default:
          throw new Error(`StubProvider: unhandled method "${method}"`);
      }
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// All-pass
// ---------------------------------------------------------------------------

describe("runPreflight — all checks pass", () => {
  it("returns an empty array when chainId, balance, and gasPrice all satisfy the policy", async () => {
    const { provider, calls } = makeStubProvider({
      eth_chainId: "0x1", // 1
      eth_getBalance: "0xde0b6b3a7640000", // 1e18
      eth_gasPrice: "0x3b9aca00", // 1 gwei
    });

    const policy: PreflightPolicy = {
      expectedChainId: 1,
      minBalanceWei: "1000000000000000000", // exactly 1e18 — >= passes
      maxGasPriceWei: "1000000000", // exactly 1 gwei — <= passes
    };

    const failures = await runPreflight(provider, policy, DEFAULT_ACCOUNT);

    expect(failures).toEqual([]);
    expect(calls).toEqual(["eth_chainId", "eth_getBalance", "eth_gasPrice"]);
  });
});

// ---------------------------------------------------------------------------
// Individual failures
// ---------------------------------------------------------------------------

describe("runPreflight — individual check failures", () => {
  it("reports a chainId failure on mismatch", async () => {
    const { provider } = makeStubProvider({ eth_chainId: "0x2a" }); // 42
    const failures = await runPreflight(provider, { expectedChainId: 1 }, DEFAULT_ACCOUNT);

    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("chainId");
    expect(failures[0].expected).toBe("1");
    expect(failures[0].actual).toBe("42");
    expect(failures[0].message).toContain("42");
    expect(failures[0].message).toContain("1");
  });

  it("reports a balance failure when the account balance is below minBalanceWei", async () => {
    const { provider } = makeStubProvider({ eth_getBalance: "0x1" }); // 1 wei
    const failures = await runPreflight(
      provider,
      { minBalanceWei: "1000000000000000000" }, // 1 ETH
      DEFAULT_ACCOUNT,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("balance");
    expect(failures[0].expected).toBe("1000000000000000000");
    expect(failures[0].actual).toBe("1");
    expect(failures[0].message).toContain(DEFAULT_ACCOUNT);
  });

  it("reports a gasPrice failure when the current gas price exceeds maxGasPriceWei", async () => {
    const { provider } = makeStubProvider({ eth_gasPrice: "0x174876e800" }); // 100 gwei
    const failures = await runPreflight(
      provider,
      { maxGasPriceWei: "1000000000" }, // 1 gwei ceiling
      DEFAULT_ACCOUNT,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("gasPrice");
    expect(failures[0].expected).toBe("1000000000");
    expect(failures[0].actual).toBe("100000000000");
  });

  it("does not report a balance failure when balance exactly equals minBalanceWei (boundary)", async () => {
    const { provider } = makeStubProvider({ eth_getBalance: "0x64" }); // 100
    const failures = await runPreflight(provider, { minBalanceWei: "100" }, DEFAULT_ACCOUNT);
    expect(failures).toEqual([]);
  });

  it("does not report a gasPrice failure when gas price exactly equals maxGasPriceWei (boundary)", async () => {
    const { provider } = makeStubProvider({ eth_gasPrice: "0x64" }); // 100
    const failures = await runPreflight(provider, { maxGasPriceWei: "100" }, DEFAULT_ACCOUNT);
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multiple simultaneous failures
// ---------------------------------------------------------------------------

describe("runPreflight — multiple simultaneous failures", () => {
  it("collects ALL failing checks, not just the first (fail-together, not fail-fast)", async () => {
    const { provider, calls } = makeStubProvider({
      eth_chainId: "0x2a", // 42, expected 1 — fails
      eth_getBalance: "0x0", // 0 wei — fails minBalanceWei
      eth_gasPrice: "0x174876e800", // 100 gwei — fails maxGasPriceWei of 1 gwei
    });

    const policy: PreflightPolicy = {
      expectedChainId: 1,
      minBalanceWei: "1000000000000000000",
      maxGasPriceWei: "1000000000",
    };

    const failures = await runPreflight(provider, policy, DEFAULT_ACCOUNT);

    expect(failures).toHaveLength(3);
    expect(failures.map((f) => f.check).sort()).toEqual(["balance", "chainId", "gasPrice"].sort());
    // All three RPC methods were still called even though the first failed.
    expect(calls).toEqual(["eth_chainId", "eth_getBalance", "eth_gasPrice"]);
  });
});

// ---------------------------------------------------------------------------
// No-op: empty policy makes ZERO provider calls
// ---------------------------------------------------------------------------

describe("runPreflight — empty policy is a true no-op", () => {
  it("makes ZERO provider.request calls when no policy fields are set", async () => {
    const requestSpy = vi.fn(async () => {
      throw new Error("provider.request should never be called for an empty policy");
    });
    const provider: EIP1193Provider = { request: requestSpy as EIP1193Provider["request"] };

    const failures = await runPreflight(provider, {}, DEFAULT_ACCOUNT);

    expect(failures).toEqual([]);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergePreflightPolicies
// ---------------------------------------------------------------------------

describe("mergePreflightPolicies", () => {
  it("returns an empty object when both base and override are undefined", () => {
    expect(mergePreflightPolicies(undefined, undefined)).toEqual({
      expectedChainId: undefined,
      minBalanceWei: undefined,
      maxGasPriceWei: undefined,
    });
  });

  it("falls back to base fields when override is undefined", () => {
    const base: PreflightPolicy = { expectedChainId: 1, minBalanceWei: "5" };
    expect(mergePreflightPolicies(base, undefined)).toEqual({
      expectedChainId: 1,
      minBalanceWei: "5",
      maxGasPriceWei: undefined,
    });
  });

  it("prefers override fields over base fields, per field", () => {
    const base: PreflightPolicy = { expectedChainId: 1, minBalanceWei: "5", maxGasPriceWei: "10" };
    const override: PreflightPolicy = { expectedChainId: 42 };
    expect(mergePreflightPolicies(base, override)).toEqual({
      expectedChainId: 42, // override wins
      minBalanceWei: "5", // falls back to base
      maxGasPriceWei: "10", // falls back to base
    });
  });
});

// ---------------------------------------------------------------------------
// isEmptyPreflightPolicy
// ---------------------------------------------------------------------------

describe("isEmptyPreflightPolicy", () => {
  it("is true for an empty object", () => {
    expect(isEmptyPreflightPolicy({})).toBe(true);
  });

  it.each<[string, PreflightPolicy]>([
    ["expectedChainId", { expectedChainId: 1 }],
    ["minBalanceWei", { minBalanceWei: "1" }],
    ["maxGasPriceWei", { maxGasPriceWei: "1" }],
  ])("is false when %s is set", (_name, policy) => {
    expect(isEmptyPreflightPolicy(policy)).toBe(false);
  });
});

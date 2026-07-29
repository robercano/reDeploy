/**
 * PREFLIGHT phase — declarative, pre-broadcast safety checks for deploy().
 *
 * DESIGN
 * ======
 *
 * A `PreflightPolicy` declares up to three optional checks:
 *   - `expectedChainId`  — the RPC's `eth_chainId` must match exactly.
 *   - `minBalanceWei`    — the deployer account's balance must be >= this.
 *   - `maxGasPriceWei`   — the network's current gas price must be <= this.
 *
 * Every field is OPTIONAL. `runPreflight` performs ONLY the checks whose
 * corresponding policy field is set — this is what lets deploy() skip the
 * whole phase (zero extra RPC calls) when no policy is configured anywhere
 * (see deploy/deploy.ts's step 3.5 for the merge + skip logic).
 *
 * These checks run strictly BEFORE any transaction is broadcast (deploy.ts
 * runs this after spec validation/compile but before ignitionDeploy()), so a
 * misconfigured mainnet deploy (wrong chain, near-empty deployer, gas spike)
 * is caught pre-broadcast with a typed `DeployError("PREFLIGHT_FAILED", ...)`
 * — never after a transaction has already been sent.
 *
 * `runPreflight` itself never throws for a failing check — it COLLECTS every
 * failure and returns them all (mirroring spec/validate.ts's
 * collect-don't-fail-fast style). deploy() is responsible for turning a
 * non-empty failure list into the thrown DeployError.
 */

import type { EIP1193Provider } from "@nomicfoundation/ignition-core";
import type { PreflightPolicy } from "../spec/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// PreflightPolicy is canonically declared in spec/types.ts (a spec-level
// shape shared with the schema/validate layer) and re-exported here as the
// public entry point for the deploy-time preflight API. Every field is
// optional and independent — set only the checks you want enforced. This
// shape is used both as the spec-declared base policy
// (`DeploymentSpec.preflight`) and as the per-call override
// (`DeployOptions.preflight`); the effective policy for a given `deploy()`
// call is a per-field merge of the two (see `mergePreflightPolicies` below
// and deploy/deploy.ts).
export type { PreflightPolicy };

/** Which of the three PreflightPolicy checks failed. */
export type PreflightCheck = "chainId" | "balance" | "gasPrice";

/**
 * A single failed preflight check, as returned by `runPreflight`.
 */
export interface PreflightFailure {
  /** Which check failed. */
  readonly check: PreflightCheck;
  /** The expected value, stringified for display (e.g. a chain id or wei amount). */
  readonly expected: string;
  /** The actual value observed from the RPC, stringified for display. */
  readonly actual: string;
  /** Human-readable description of the failure. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a hex-quantity JSON-RPC result (e.g. `"0x7a69"`) into a bigint.
 * Ignition's EIP1193Provider contract guarantees these RPC methods return
 * hex-quantity strings, so this does not need to handle decimal input.
 */
function hexToBigInt(hex: unknown): bigint {
  if (typeof hex !== "string") {
    throw new Error(`Expected a hex string RPC result, got ${typeof hex}`);
  }
  return BigInt(hex);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the preflight checks declared by `policy` against `provider`, for the
 * deployer account `account`. Performs ONLY the checks whose corresponding
 * policy field is set — a `policy` with no fields set makes ZERO RPC calls.
 *
 * Never sends a transaction. Never logs secrets (the account address is not
 * a secret; no private key ever passes through this module).
 *
 * @returns The list of failures, in check order (chainId, balance, gasPrice).
 *   An empty array means every configured check passed.
 */
export async function runPreflight(
  provider: EIP1193Provider,
  policy: PreflightPolicy,
  account: string,
): Promise<PreflightFailure[]> {
  const failures: PreflightFailure[] = [];

  if (policy.expectedChainId !== undefined) {
    const rawChainId = await provider.request({ method: "eth_chainId" });
    const actualChainId = hexToBigInt(rawChainId);
    const expectedChainId = BigInt(policy.expectedChainId);
    if (actualChainId !== expectedChainId) {
      failures.push({
        check: "chainId",
        expected: expectedChainId.toString(),
        actual: actualChainId.toString(),
        message: `Expected chain id ${expectedChainId.toString()} but the RPC reports chain id ${actualChainId.toString()} — refusing to deploy to the wrong network`,
      });
    }
  }

  if (policy.minBalanceWei !== undefined) {
    const rawBalance = await provider.request({
      method: "eth_getBalance",
      params: [account, "latest"],
    });
    const actualBalance = hexToBigInt(rawBalance);
    const minBalance = BigInt(policy.minBalanceWei);
    if (actualBalance < minBalance) {
      failures.push({
        check: "balance",
        expected: minBalance.toString(),
        actual: actualBalance.toString(),
        message: `Deployer account ${account} has balance ${actualBalance.toString()} wei, below the required minimum of ${minBalance.toString()} wei`,
      });
    }
  }

  if (policy.maxGasPriceWei !== undefined) {
    const rawGasPrice = await provider.request({ method: "eth_gasPrice" });
    const actualGasPrice = hexToBigInt(rawGasPrice);
    const maxGasPrice = BigInt(policy.maxGasPriceWei);
    if (actualGasPrice > maxGasPrice) {
      failures.push({
        check: "gasPrice",
        expected: maxGasPrice.toString(),
        actual: actualGasPrice.toString(),
        message: `Current network gas price ${actualGasPrice.toString()} wei exceeds the configured ceiling of ${maxGasPrice.toString()} wei`,
      });
    }
  }

  return failures;
}

/**
 * Per-field merge of two PreflightPolicy objects: `override` wins per field
 * over `base`, `undefined` fields in `override` fall back to `base`.
 *
 * Used by deploy() to combine `DeploymentSpec.preflight` (the declarative
 * base policy) with `DeployOptions.preflight` (the per-call override, e.g.
 * a deploy-server per-network policy) into the single effective policy.
 */
export function mergePreflightPolicies(
  base: PreflightPolicy | undefined,
  override: PreflightPolicy | undefined,
): PreflightPolicy {
  return {
    expectedChainId: override?.expectedChainId ?? base?.expectedChainId,
    minBalanceWei: override?.minBalanceWei ?? base?.minBalanceWei,
    maxGasPriceWei: override?.maxGasPriceWei ?? base?.maxGasPriceWei,
  };
}

/**
 * True iff `policy` has no fields set — i.e. the effective preflight policy
 * is a no-op. deploy() uses this to skip runPreflight() entirely (zero extra
 * RPC calls) for the common case of no preflight configuration anywhere.
 */
export function isEmptyPreflightPolicy(policy: PreflightPolicy): boolean {
  return (
    policy.expectedChainId === undefined &&
    policy.minBalanceWei === undefined &&
    policy.maxGasPriceWei === undefined
  );
}

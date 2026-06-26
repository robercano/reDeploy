/**
 * Main orchestrator for @redeploy/verify.
 *
 * DESIGN
 * ======
 *
 * verifyDeployment() iterates over a caller-supplied map of deployed contracts
 * and submits each one to the injected VerifierClient. It collects per-contract
 * results and returns an overall success flag.
 *
 * THROW vs. RETURN distinction (mirrors @redeploy/core's deploy.ts)
 * ------------------------------------------------------------------
 * Setup/usage errors are THROWN as typed VerifyErrors:
 *   - Missing API key in the provider config → MISSING_API_KEY
 *   - Empty contracts map → EMPTY_CONTRACT_SET
 *   - Malformed contract entry (missing address, contractName, etc.) →
 *     MALFORMED_CONTRACT_ENTRY
 *   - Entry id referenced but not found → UNKNOWN_CONTRACT_ID (reserved for
 *     future use when verifyDeployment accepts a list of ids to verify)
 *   - Unsupported provider type → UNSUPPORTED_PROVIDER
 *
 * Per-contract provider failures (network error, HTTP non-2xx, provider
 * rejection) are NOT thrown — they are returned as ContractVerifyResult
 * entries with status "failed" and a descriptive message.
 *
 * Already-verified handling
 * -------------------------
 * If the verifier reports a contract is already verified, the result status is
 * "already-verified" and overall success remains true. This is intentional:
 * running verifyDeployment() twice should be idempotent.
 *
 * Polling
 * -------
 * If submit() returns status "pending" AND the client exposes a
 * pollUntilDone(guid) method, verifyDeployment() calls it to drive the
 * pending result to a terminal state. The poll interval and max attempts are
 * configured on the client, not on verifyDeployment() itself — set
 * pollIntervalMs=0 and maxPollAttempts to a small number in tests for
 * instant polling.
 */

import { VerifyError } from "./errors.js";
import type {
  VerifierClient,
  ContractVerifyEntry,
  ContractVerifyResult,
  VerifyDeploymentResult,
  SubmitRequest,
} from "./types.js";

// Re-export errors for convenience
export { VerifyError } from "./errors.js";
export type { VerifyErrorCode } from "./errors.js";

// Re-export all public types
export type {
  VerificationStatus,
  VerifierClient,
  SubmitRequest,
  SubmitResult,
  StatusResult,
  ContractVerifyEntry,
  ContractVerifyResult,
  VerifyDeploymentResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Simple hex address check: 0x followed by 40 hex characters. */
function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Validate a single ContractVerifyEntry. Returns an error message string if
 * the entry is invalid, or null if it is valid.
 */
function validateEntry(entry: ContractVerifyEntry): string | null {
  if (!entry.id || entry.id.trim() === "") {
    return `Contract entry has an empty id`;
  }
  if (!entry.address || !isValidAddress(entry.address)) {
    return `Contract "${entry.id}" has an invalid address: "${entry.address}". Expected 0x-prefixed 40-char hex.`;
  }
  if (!entry.contractName || entry.contractName.trim() === "") {
    return `Contract "${entry.id}" has an empty contractName`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Options type
// ---------------------------------------------------------------------------

/**
 * Options for verifyDeployment().
 *
 * @typeParam TSubmitRequest — The client-specific submit request type.
 *   This is inferred from the `client` parameter.
 */
export interface VerifyDeploymentOptions<TSubmitRequest extends SubmitRequest = SubmitRequest> {
  /**
   * Map of contract id → entry to verify. Must not be empty.
   * Each entry must have a valid address and a non-empty contractName.
   *
   * @throws VerifyError("EMPTY_CONTRACT_SET") if the map has no entries.
   * @throws VerifyError("MALFORMED_CONTRACT_ENTRY") if any entry is invalid.
   */
  readonly contracts: ReadonlyArray<ContractVerifyEntry>;
  /**
   * The verifier client to use. Either an Etherscan client
   * (createEtherscanClient) or a Sourcify client (createSourcifyClient), or a
   * test mock that implements the VerifierClient interface.
   */
  readonly client: VerifierClient<TSubmitRequest>;
  /**
   * A function that maps a ContractVerifyEntry to the client-specific submit
   * request type. This is the seam between the generic orchestrator and each
   * concrete client.
   *
   * @example For Etherscan:
   * ```ts
   * toSubmitRequest: (entry) => ({
   *   address: entry.address,
   *   contractName: entry.contractName,
   *   sourceCode: entry.sourceCode ?? "",
   *   compilerVersion: entry.compilerVersion ?? "v0.8.28+commit.7893614a",
   *   constructorArguments: entry.constructorArguments,
   *   codeFormat: entry.codeFormat,
   * })
   * ```
   */
  readonly toSubmitRequest: (entry: ContractVerifyEntry) => TSubmitRequest;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a set of deployed contracts with the given provider client.
 *
 * Submits each contract in `options.contracts` to the verifier. Per-contract
 * results are collected into ContractVerifyResult entries. If submit() returns
 * "pending" and the client supports pollUntilDone(), the orchestrator polls
 * for a terminal state.
 *
 * @param options - See VerifyDeploymentOptions.
 * @returns A VerifyDeploymentResult with per-contract results and an overall
 *   success flag.
 *
 * @throws VerifyError("EMPTY_CONTRACT_SET") if `contracts` is empty.
 * @throws VerifyError("MALFORMED_CONTRACT_ENTRY") if any entry has an invalid
 *   address or empty contractName.
 *
 * Per-contract provider failures (network errors, HTTP non-2xx, rejected
 * submissions) are NOT thrown — they appear in the results with status
 * "failed" and a descriptive message.
 *
 * Already-verified contracts appear with status "already-verified" and
 * contribute to overall success (same as "verified").
 *
 * @example
 * ```ts
 * const result = await verifyDeployment({
 *   contracts: [
 *     {
 *       id: "token",
 *       address: "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12",
 *       contractName: "Token",
 *       compilerVersion: "v0.8.28+commit.7893614a",
 *       sourceCode: standardJsonInput,
 *     },
 *   ],
 *   client: createEtherscanClient({ apiKey: process.env.ETHERSCAN_API_KEY! }, fetch),
 *   toSubmitRequest: (entry) => ({
 *     address: entry.address,
 *     contractName: entry.contractName,
 *     sourceCode: entry.sourceCode ?? "",
 *     compilerVersion: entry.compilerVersion ?? "",
 *     constructorArguments: entry.constructorArguments,
 *   }),
 * });
 * if (!result.success) {
 *   for (const r of result.results) {
 *     if (r.status === "failed") console.error(r.id, r.message);
 *   }
 * }
 * ```
 */
export async function verifyDeployment<TSubmitRequest extends SubmitRequest>(
  options: VerifyDeploymentOptions<TSubmitRequest>,
): Promise<VerifyDeploymentResult> {
  const { contracts, client, toSubmitRequest } = options;

  // --- 1. Validate input ---------------------------------------------------------

  if (contracts.length === 0) {
    throw new VerifyError(
      "EMPTY_CONTRACT_SET",
      "verifyDeployment() requires at least one contract entry. The contracts array is empty.",
    );
  }

  for (const entry of contracts) {
    const err = validateEntry(entry);
    if (err !== null) {
      throw new VerifyError("MALFORMED_CONTRACT_ENTRY", err);
    }
  }

  // --- 2. Submit each contract and collect results --------------------------------

  const results: ContractVerifyResult[] = [];

  for (const entry of contracts) {
    const submitRequest = toSubmitRequest(entry);
    const submitResult = await client.submit(submitRequest);

    if (submitResult.status === "pending" && submitResult.guid != null && client.pollUntilDone != null) {
      // Drive pending → terminal via polling (pollIntervalMs/maxAttempts configured on client)
      const polled = await client.pollUntilDone(submitResult.guid);
      results.push({
        id: entry.id,
        address: entry.address,
        status: polled.status,
        message: polled.message,
        guid: submitResult.guid,
      });
    } else {
      results.push({
        id: entry.id,
        address: entry.address,
        status: submitResult.status,
        message: submitResult.message,
        guid: submitResult.guid,
      });
    }
  }

  // --- 3. Compute overall success ------------------------------------------------

  const success = results.every(
    (r) => r.status === "verified" || r.status === "already-verified",
  );

  return { success, results };
}

/**
 * Error types for the verify module.
 *
 * VerifyError is thrown by verifyDeployment() for setup/usage conditions that
 * prevent verification from even starting (e.g. missing API key, empty
 * contract set, unknown contract id, malformed input). Per-contract provider
 * failures (HTTP errors, rejected submissions, timeout) are NOT thrown — they
 * are collected as per-contract results with status "failed" in the returned
 * VerifyDeploymentResult, so a single contract failure does not abort the
 * entire batch.
 *
 * This mirrors the distinction in @redeploy/core's deploy.ts:
 *   - Setup/validation errors → throw DeployError (typed, stable code)
 *   - Per-contract execution errors → returned in the result, not thrown
 */

/** Discriminated error codes for VerifyError. */
export type VerifyErrorCode =
  /**
   * The provider configuration is missing a required field.
   * For Etherscan: the `apiKey` must be a non-empty string.
   */
  | "MISSING_API_KEY"
  /**
   * The `contracts` map passed to verifyDeployment() is empty. At least one
   * contract entry is required.
   */
  | "EMPTY_CONTRACT_SET"
  /**
   * A contract id referenced in the input could not be found in the contracts
   * map. This indicates a caller-side bug (e.g. stale id after a rename).
   */
  | "UNKNOWN_CONTRACT_ID"
  /**
   * A contract entry is missing a required field (e.g. address, contractName,
   * compilerVersion) or the address is not a valid hex string.
   */
  | "MALFORMED_CONTRACT_ENTRY"
  /**
   * The provider configuration references an unknown or unsupported provider
   * type. Currently "etherscan" and "sourcify" are supported.
   */
  | "UNSUPPORTED_PROVIDER";

/**
 * Thrown by verifyDeployment() for setup and usage errors that prevent
 * verification from starting.
 *
 * Does NOT represent per-contract provider failures — those are collected into
 * the `results` field of the returned VerifyDeploymentResult with status
 * "failed".
 *
 * @example
 * ```ts
 * try {
 *   await verifyDeployment(options);
 * } catch (err) {
 *   if (err instanceof VerifyError && err.code === "MISSING_API_KEY") {
 *     console.error("Set ETHERSCAN_API_KEY in your environment.");
 *   }
 * }
 * ```
 */
export class VerifyError extends Error {
  readonly code: VerifyErrorCode;

  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
  }
}

/**
 * Error types for the config drift verification sub-system.
 *
 * ConfigVerifyError is thrown by verifyConfig() for setup/usage conditions
 * that prevent verification from starting (e.g. unknown ref id, missing
 * getter mapping, malformed spec). These are programmer errors — the caller
 * should fix them before retrying.
 *
 * Per-step ChainReader.call failures (network errors, reverts) are NOT thrown.
 * They are collected as per-step results with status "error" in the returned
 * ConfigVerifyResult, so a single step failure does not abort the entire check.
 *
 * This mirrors the throw-vs-return split in @redeploy/verify's verifyDeployment()
 * and @redeploy/core's deploy.ts.
 */

/** Discriminated error codes for ConfigVerifyError. */
export type ConfigVerifyErrorCode =
  /**
   * A RefArg or deployment id reference (target, source, into, account) was
   * not found in the deployedAddresses map. Indicates a stale or incorrect
   * spec entry.
   */
  | "UNKNOWN_REF"
  /**
   * A setX or wire step has no read descriptor in options.reads. Without a
   * getter mapping, verifyConfig() cannot determine the live value to compare
   * against. This is a required caller-side input.
   */
  | "MISSING_GETTER_MAPPING"
  /**
   * The ConfigSpec itself is malformed: empty step id, missing required fields,
   * or an unknown step kind.
   */
  | "MALFORMED_SPEC";

/**
 * Thrown by verifyConfig() for setup and usage errors that prevent drift
 * detection from starting.
 *
 * Does NOT represent per-step ChainReader.call failures — those are collected
 * into the `results` field of the returned ConfigVerifyResult with status "error".
 *
 * @example
 * ```ts
 * try {
 *   await verifyConfig(options);
 * } catch (err) {
 *   if (err instanceof ConfigVerifyError && err.code === "UNKNOWN_REF") {
 *     console.error("Fix your deployedAddresses map:", err.message);
 *   }
 * }
 * ```
 */
export class ConfigVerifyError extends Error {
  readonly code: ConfigVerifyErrorCode;

  constructor(code: ConfigVerifyErrorCode, message: string) {
    super(message);
    this.name = "ConfigVerifyError";
    this.code = code;
  }
}

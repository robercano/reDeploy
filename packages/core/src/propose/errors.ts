/**
 * Error types for the propose module (issue #154).
 *
 * Mirrors deploy/errors.ts's DeployError shape and error codes for the parts
 * of the pipeline propose() shares with deploy() (validate -> crossRef ->
 * resolver -> compile — see propose/propose.ts), plus one propose-specific
 * code for failures during the ephemeral collection run itself.
 */

import type { SpecError } from "../spec/validate.js";

/** Discriminated error codes for ProposeError. */
export type ProposeErrorCode =
  /** The DeploymentSpec provided to propose() failed validateSpec(). */
  | "INVALID_SPEC"
  /** An internal invariant was violated during spec compilation. */
  | "COMPILE_ERROR"
  /** A `{ kind: "resolver" }` arg named a resolver absent from `ProposeOptions.resolvers`. */
  | "UNKNOWN_RESOLVER"
  /** A resolver function threw, or a spec parameter could not be coerced. */
  | "RESOLVER_ERROR"
  /** A `{ kind: "crossRef" }` arg named a network absent from `ProposeOptions.crossNetworkJournals`. */
  | "CROSS_REF_ERROR"
  /**
   * The ephemeral collection run did not complete successfully (Ignition
   * reported a non-successful DeploymentResult against the collecting
   * provider — e.g. an unhandled RPC method, or an on-chain-execution
   * future such as a static call that the collecting provider cannot
   * satisfy). Check ProposeError.message for detail.
   */
  | "EXECUTION_FAILED";

/**
 * Thrown by proposeDeploy() when the DeploymentSpec is invalid, cannot be
 * compiled, or the ephemeral collection run fails. Never thrown for "the
 * batch worked but contains a step propose mode can't represent" —
 * see safeBatch.ts's own ProposeError("EXECUTION_FAILED", ...) equivalent,
 * SafeBatchError, for that case.
 */
export class ProposeError extends Error {
  readonly code: ProposeErrorCode;
  /** The raw SpecError list when code === "INVALID_SPEC". Undefined otherwise. */
  readonly specErrors?: SpecError[];

  constructor(code: ProposeErrorCode, message: string, specErrors?: SpecError[]) {
    super(message);
    this.name = "ProposeError";
    this.code = code;
    this.specErrors = specErrors;
  }
}

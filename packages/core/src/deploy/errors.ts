/**
 * Error types for the deploy module.
 *
 * DeployError is thrown when the provided DeploymentSpec fails validation
 * before Ignition's deploy() is called. Errors that occur during on-chain
 * execution are surfaced through the DeployResult type (not thrown), because
 * Ignition uses a discriminated-union result rather than exceptions for
 * execution failures.
 */

import type { SpecError } from "../spec/validate.js";
import type { PreflightFailure } from "./preflight.js";

/** Discriminated error codes for DeployError. */
export type DeployErrorCode =
  /**
   * The DeploymentSpec provided to deploy() failed validateSpec().
   * Check DeployError.specErrors for the full list of SpecErrors.
   */
  | "INVALID_SPEC"
  /**
   * An internal invariant was violated during spec compilation
   * (propagated from CompileError). Should not happen for pre-validated specs.
   */
  | "COMPILE_ERROR"
  /**
   * A `{ kind: "resolver" }` arg named a resolver that is not a key of the
   * injected `DeployOptions.resolvers` registry. NOT caught by validateSpec
   * — validateSpec has no visibility into the injected registry. See
   * resolve/registry.ts for the full Resolver/ResolverRegistry contract.
   */
  | "UNKNOWN_RESOLVER"
  /**
   * A resolver function threw (or its returned Promise rejected) during
   * deploy()'s async pre-resolution pass, or a spec parameter could not be
   * coerced into the bigint shape ResolverContext.params requires. See
   * resolve/resolveSpec.ts.
   */
  | "RESOLVER_ERROR"
  /**
   * A `{ kind: "crossRef" }` arg named a network absent from
   * `DeployOptions.crossNetworkJournals`, or referenced a contract id not
   * present in that network's journal (either the journal doesn't exist yet
   * or the id was never deployed there — deploy that network first). See
   * resolve/crossRef.ts for the full CrossRefError/CrossRefErrorCode detail
   * (CrossRefError.code distinguishes "CROSS_REF_UNKNOWN_NETWORK" from
   * "CROSS_REF_NOT_DEPLOYED", but both re-wrap to this single DeployError
   * code — check `err.message` for which one occurred).
   */
  | "CROSS_REF_ERROR"
  /**
   * The effective PREFLIGHT policy (per-field merge of
   * `DeploymentSpec.preflight` and `DeployOptions.preflight`) failed one or
   * more checks — wrong chain id, insufficient deployer balance, or gas
   * price above the configured ceiling. Thrown BEFORE any on-chain
   * transaction is broadcast. Check DeployError.preflightFailures for the
   * full list of failed checks. See deploy/preflight.ts.
   */
  | "PREFLIGHT_FAILED";

/**
 * Thrown by deploy() when the DeploymentSpec is invalid, cannot be compiled,
 * or fails the PREFLIGHT phase. Does NOT represent on-chain execution
 * failures — those are returned as a DeployResult with type !==
 * SUCCESSFUL_DEPLOYMENT.
 */
export class DeployError extends Error {
  readonly code: DeployErrorCode;
  /**
   * The raw SpecError list when code === "INVALID_SPEC".
   * Undefined for other error codes.
   */
  readonly specErrors?: SpecError[];
  /**
   * The list of failed preflight checks when code === "PREFLIGHT_FAILED".
   * Undefined for other error codes. See deploy/preflight.ts.
   */
  readonly preflightFailures?: PreflightFailure[];

  constructor(
    code: DeployErrorCode,
    message: string,
    specErrors?: SpecError[],
    preflightFailures?: PreflightFailure[],
  ) {
    super(message);
    this.name = "DeployError";
    this.code = code;
    this.specErrors = specErrors;
    this.preflightFailures = preflightFailures;
  }
}

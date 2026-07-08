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
  | "RESOLVER_ERROR";

/**
 * Thrown by deploy() when the DeploymentSpec is invalid or cannot be compiled.
 * Does NOT represent on-chain execution failures — those are returned as a
 * DeployResult with type !== SUCCESSFUL_DEPLOYMENT.
 */
export class DeployError extends Error {
  readonly code: DeployErrorCode;
  /**
   * The raw SpecError list when code === "INVALID_SPEC".
   * Undefined for other error codes.
   */
  readonly specErrors?: SpecError[];

  constructor(code: DeployErrorCode, message: string, specErrors?: SpecError[]) {
    super(message);
    this.name = "DeployError";
    this.code = code;
    this.specErrors = specErrors;
  }
}

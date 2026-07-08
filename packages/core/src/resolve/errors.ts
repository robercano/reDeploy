/**
 * Error types for the resolver pre-resolution pass (resolve/resolveSpec.ts).
 *
 * ResolveError is thrown by resolveSpecResolverArgs() and caught by
 * deploy/deploy.ts, which re-wraps it as a DeployError with a matching code
 * (UNKNOWN_RESOLVER / RESOLVER_ERROR) so callers of deploy() only ever need
 * to catch DeployError. ResolveError itself is not part of the public API
 * surface (see src/index.ts) — it is an internal detail of the resolve
 * module.
 */

/** Discriminated error codes for ResolveError. */
export type ResolveErrorCode =
  /**
   * A `{ kind: "resolver", name: "..." }` arg named a resolver that is not a
   * key of the injected ResolverRegistry (DeployOptions.resolvers). This is
   * NOT caught by validateSpec — validateSpec has no visibility into the
   * injected registry (see spec/validate.ts's module doc).
   */
  | "UNKNOWN_RESOLVER"
  /**
   * The resolver function itself threw (or its returned Promise rejected)
   * during invocation, or a spec parameter could not be coerced into the
   * bigint shape ResolverContext.params requires.
   */
  | "RESOLVER_ERROR";

/**
 * Thrown by resolveSpecResolverArgs() when a resolver arg cannot be resolved.
 */
export class ResolveError extends Error {
  readonly code: ResolveErrorCode;

  constructor(code: ResolveErrorCode, message: string) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
  }
}

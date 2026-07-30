/**
 * Error types for the cross-chain dependency ref pre-resolution pass
 * (resolve/crossRef.ts).
 *
 * CrossRefError is thrown by resolveCrossRefArgs() and caught by
 * deploy/deploy.ts, which re-wraps it as a DeployError with code
 * "CROSS_REF_ERROR" — mirroring how resolve/errors.ts's ResolveError is
 * caught and re-wrapped for `{ kind: "resolver" }` args — so callers of
 * deploy() only ever need to catch DeployError. Unlike ResolveError,
 * CrossRefError IS part of the public API surface (see src/index.ts):
 * resolveCrossRefArgs() is also intended to be called directly by consumers
 * that manage their own multi-network orchestration outside deploy()
 * (e.g. @redeploy/deploy-server wiring per-network journals from its
 * NetworksRegistry).
 */

/** Discriminated error codes for CrossRefError. */
export type CrossRefErrorCode =
  /**
   * A `{ kind: "crossRef", network: "..." }` arg names a network that is not
   * a key of the injected `ResolveCrossRefOptions.journals` map. Core has no
   * network registry of its own (see spec/types.ts's CrossRefArg docs) — the
   * caller must supply a journal location for every network referenced by a
   * crossRef arg.
   */
  | "CROSS_REF_UNKNOWN_NETWORK"
  /**
   * The referenced network's journal exists (or was looked up) but does not
   * contain a deployed address for the requested contract id — either the
   * journal is missing entirely (nothing deployed yet on that network) or
   * the specific contract id was never deployed there. The referenced
   * network's deployment must be COMPLETE before this spec is deployed (see
   * CrossRefArg's v1 scope boundary — no cross-chain orchestrator).
   */
  | "CROSS_REF_NOT_DEPLOYED";

/**
 * Thrown by resolveCrossRefArgs() when a crossRef arg cannot be resolved.
 */
export class CrossRefError extends Error {
  readonly code: CrossRefErrorCode;

  constructor(code: CrossRefErrorCode, message: string) {
    super(message);
    this.name = "CrossRefError";
    this.code = code;
  }
}

/**
 * Error types for the spec compiler.
 *
 * CompileError is thrown ONLY as a last resort for conditions that a
 * pre-validated DeploymentSpec should never produce. If the caller passes a
 * spec that has already been through validateSpec(), these errors should never
 * fire in practice.
 */

/** Discriminated error codes for CompileError. */
export type CompileErrorCode =
  /** A literal value fell outside the supported LiteralValue shape at runtime. */
  | "UNSUPPORTED_LITERAL"
  /** Expression evaluation failed (invalid syntax, unknown references, type errors). */
  | "EXPRESSION_EVAL_ERROR"
  /**
   * An internal invariant was violated — e.g. a ref whose target id was not
   * registered as a future (which implies the caller bypassed validateSpec).
   */
  | "INTERNAL_INVARIANT";

/**
 * Thrown by compileSpec when an unrecoverable condition is detected at
 * compile time. This should never happen for specs that have passed
 * validateSpec().
 */
export class CompileError extends Error {
  readonly code: CompileErrorCode;
  /**
   * JSON-pointer-style path to the offending node, e.g.
   * `contracts[2].args[1]`. Omitted when the error is not tied to a
   * specific location.
   */
  readonly path?: string;

  constructor(code: CompileErrorCode, message: string, path?: string) {
    super(message);
    this.name = "CompileError";
    this.code = code;
    this.path = path;
  }
}

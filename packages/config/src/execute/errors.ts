/**
 * Error types for the config execution module.
 *
 * ConfigExecError is thrown when the provided ConfigSpec fails validation
 * before execution begins, or when a ref cannot be resolved to an address
 * during step execution. Errors that occur during on-chain execution (i.e.
 * thrown by the ConfigExecutor) propagate as-is — the engine does not catch
 * or wrap them, so callers can react to executor failures directly.
 */

import type { ConfigError } from "../steps/validate.js";

/** Discriminated error codes for ConfigExecError. */
export type ConfigExecErrorCode =
  /**
   * The ConfigSpec provided to applyConfig() failed validateConfig().
   * Check ConfigExecError.specErrors for the full list of ConfigErrors.
   */
  | "INVALID_SPEC"
  /**
   * A ref in a step could not be resolved to an address in deployedAddresses.
   * This should not normally occur if the spec was validated against the full
   * set of deployed ids (which applyConfig() does). It is provided as a typed
   * defensive failure for the resolution path at runtime.
   */
  | "UNKNOWN_REF"
  /**
   * The config-state journal file exists but could not be read or parsed.
   * The file may be corrupt or inaccessible. The stateDir path is included in
   * the message.
   */
  | "JOURNAL_ERROR";

/**
 * Thrown by applyConfig() when the ConfigSpec is invalid, when a ref cannot
 * be resolved, or when the journal is unreadable/corrupt.
 *
 * Does NOT represent on-chain execution failures — those are thrown by the
 * ConfigExecutor and propagate directly from applyConfig() without wrapping.
 */
export class ConfigExecError extends Error {
  readonly code: ConfigExecErrorCode;
  /**
   * The raw ConfigError list when code === "INVALID_SPEC".
   * Undefined for other error codes.
   */
  readonly specErrors?: ConfigError[];

  constructor(code: ConfigExecErrorCode, message: string, specErrors?: ConfigError[]) {
    super(message);
    this.name = "ConfigExecError";
    this.code = code;
    this.specErrors = specErrors;
  }
}

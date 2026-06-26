/**
 * Error types for the reader module.
 *
 * ReadError is thrown by readDeployment() for conditions that prevent reading
 * deployment state (e.g. missing directory, unreadable journal). Malformed or
 * unparseable individual journal LINES are NOT thrown — they are collected into
 * the `warnings` field of the returned DeploymentView, so a single corrupt line
 * does not abort the read.
 */

/** Discriminated error codes for ReadError. */
export type ReadErrorCode =
  /**
   * The deploymentDir provided to readDeployment() does not exist or is not a
   * directory. No data can be read.
   */
  | "DEPLOYMENT_DIR_NOT_FOUND"
  /**
   * journal.jsonl exists in deploymentDir but could not be read (e.g. permission
   * denied). This is distinct from malformed lines inside the journal, which are
   * surfaced as warnings rather than thrown.
   */
  | "JOURNAL_READ_ERROR"
  /**
   * config-state.jsonl exists in configStateDir but could not be read (e.g.
   * permission denied). This is distinct from malformed lines inside the config
   * journal, which are surfaced as warnings rather than thrown.
   */
  | "CONFIG_JOURNAL_READ_ERROR";

/**
 * Thrown by readDeployment() when the deployment directory is missing or a
 * journal file cannot be opened for reading.
 *
 * Does NOT represent malformed journal lines — those are collected into the
 * `warnings` field of the returned DeploymentView.
 */
export class ReadError extends Error {
  readonly code: ReadErrorCode;

  constructor(code: ReadErrorCode, message: string) {
    super(message);
    this.name = "ReadError";
    this.code = code;
  }
}

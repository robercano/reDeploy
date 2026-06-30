/**
 * Public types for the config execution engine.
 *
 * These types define the injectable executor abstraction (ConfigExecutor /
 * ConfigCall), the input options (ApplyConfigOptions), and the result shape
 * (ApplyConfigResult).
 */

import type { ConfigSpec, ConfigStep } from "../steps/types.js";

// ---------------------------------------------------------------------------
// ConfigCall — the resolved, chain-agnostic description of a single step
// ---------------------------------------------------------------------------

/**
 * A resolved argument to a config call.
 *
 * All refs have already been resolved to address strings before a ConfigCall
 * is constructed. A ResolvedArg is therefore either a plain address string
 * (resolved from a RefArg) or any JSON-serializable literal value (from a
 * LiteralArg).
 */
export type ResolvedArg = string | number | boolean | null | ResolvedArg[];

/**
 * A resolved, chain-agnostic description of a single configuration step.
 *
 * All contract references have been resolved to their on-chain addresses.
 * The ConfigExecutor receives one ConfigCall per step and is responsible
 * for translating it into an actual on-chain transaction.
 *
 * Step-kind mapping:
 *
 *   setX      → target is the resolved address of the target contract.
 *               function is the setter name. args contains resolved positional
 *               arguments (literal values and/or resolved addresses from refs).
 *
 *   grantRole → target is the resolved address of the access-controlled contract.
 *               function is always "grantRole" (the conventional function name).
 *               role is the role identifier string (e.g. "MINTER_ROLE").
 *               args contains a single element: the resolved account address.
 *
 *   wire      → target is the resolved address of the `into` contract.
 *               function is the setter name on `into`. args contains a single
 *               element: the resolved address of the `source` contract.
 */
export interface ConfigCall {
  /** The unique step id (from ConfigStep.id). */
  readonly stepId: string;
  /** The step kind. */
  readonly kind: ConfigStep["kind"];
  /** Resolved on-chain address of the contract to call. */
  readonly target: string;
  /** Name of the function to call on `target`. */
  readonly function: string;
  /**
   * Role identifier — only present for grantRole steps.
   * Undefined for setX and wire steps.
   */
  readonly role?: string;
  /**
   * Resolved positional arguments for the call.
   * - setX: zero or more resolved values (literals + resolved ref addresses).
   * - grantRole: exactly one element — the resolved account address.
   * - wire: exactly one element — the resolved source contract address.
   */
  readonly args: ResolvedArg[];
}

// ---------------------------------------------------------------------------
// ConfigExecutor — injectable abstraction for on-chain calls
// ---------------------------------------------------------------------------

/**
 * Injectable abstraction for executing on-chain configuration calls.
 *
 * The engine passes one resolved ConfigCall per step to executor.execute().
 * The executor is responsible for:
 *   - Constructing and sending the actual on-chain transaction.
 *   - Awaiting confirmation.
 *   - Throwing if the call fails (the engine will NOT mark the step complete
 *     on a thrown error, preserving resumability).
 *
 * Implementations can be backed by ethers.js, viem, Hardhat's network helpers,
 * or a test double.
 */
export interface ConfigExecutor {
  /**
   * Execute a single resolved configuration call.
   *
   * @param call - The resolved step description.
   * @throws any error if the call fails; the engine will propagate the error
   *         and NOT record the step as complete.
   */
  execute(call: ConfigCall): Promise<void>;
}

// ---------------------------------------------------------------------------
// ApplyConfigOptions
// ---------------------------------------------------------------------------

/**
 * Options for applyConfig().
 *
 * @remarks
 * `stateDir` is REQUIRED for idempotency and resume. The engine writes a
 * per-step journal to `<stateDir>/config-state.jsonl`. On subsequent calls
 * with the same directory, steps already recorded as complete are skipped —
 * the executor is never called for them again. Omitting or changing stateDir
 * between runs means every step executes fresh with no resume capability.
 */
export interface ApplyConfigOptions {
  /**
   * The declarative configuration spec. Will be validated before execution.
   * May be a pre-typed ConfigSpec or an unknown value (e.g. parsed JSON) —
   * validation is always applied before any step is executed.
   */
  spec: ConfigSpec | unknown;
  /**
   * Map of deployed contract ids to their on-chain addresses.
   * Used to resolve RefArg values in step fields (target, source, into,
   * account, and args of kind "ref").
   * Keys must match the `id` values in the deployment.
   */
  deployedAddresses: Record<string, string>;
  /**
   * Injectable executor responsible for performing the actual on-chain calls.
   * The engine calls executor.execute(call) once per non-skipped step and
   * marks the step complete only if execute() resolves without throwing.
   */
  executor: ConfigExecutor;
  /**
   * Directory where the engine will persist the config-state journal.
   * This is what makes re-runs idempotent and partial runs resumable.
   * REQUIRED for idempotency — pass a stable, deployment-specific path.
   */
  stateDir: string;
}

// ---------------------------------------------------------------------------
// ApplyConfigResult
// ---------------------------------------------------------------------------

/**
 * The result of an applyConfig() call.
 */
export interface ApplyConfigResult {
  /**
   * True iff all steps completed successfully (either executed this run
   * or skipped because they were already journaled from a previous run).
   */
  readonly success: boolean;
  /**
   * Ids of steps that were executed (on-chain call made) during THIS run.
   * Includes steps from both the unordered `steps` list and the ordered
   * `orderedSteps` list. Does not include steps that were skipped because
   * they were already in the journal from a previous run.
   */
  readonly executedStepIds: string[];
  /**
   * Ids of steps that were skipped because they were already recorded as
   * complete in the journal (from a previous run). Covers both `steps` and
   * `orderedSteps`.
   */
  readonly skippedStepIds: string[];
  /**
   * Ids of ALL steps that are now complete — the union of executedStepIds
   * and skippedStepIds (plus any previously-journaled steps not in this run's
   * spec, though those are excluded here since we only iterate the spec).
   *
   * Covers both `steps` and `orderedSteps`. This is the full checkpoint set
   * after this run.
   */
  readonly completedStepIds: string[];
}

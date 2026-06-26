/**
 * Idempotent, resumable deployment runner for @redeploy/core.
 *
 * DESIGN
 * ======
 *
 * Idempotency and resume are fully delegated to Hardhat Ignition's journal
 * mechanism. When `deploymentDir` is provided, Ignition writes every
 * execution step to `<deploymentDir>/journal.jsonl`. On subsequent calls with
 * the SAME `deploymentDir`, Ignition replays the journal and skips futures
 * that are already marked complete — those contracts are NOT re-deployed.
 * A partial deployment (interrupted mid-run) will resume from the point it
 * was interrupted, deploying only the contracts whose futures are not yet
 * journaled as complete.
 *
 * This module's responsibility is:
 *   1. Validate the spec (fail fast with a typed DeployError).
 *   2. Compile the spec into an Ignition module.
 *   3. Thread `deploymentDir` through to Ignition's `deploy()` so the journal
 *      persists across calls — do NOT reinvent journaling here.
 *   4. Wrap the raw DeploymentResult with enough accessors to let callers
 *      check success and read deployed addresses.
 */

import {
  deploy as ignitionDeploy,
  DeploymentResultType,
} from "@nomicfoundation/ignition-core";
import type {
  ArtifactResolver,
  DeploymentParameters,
  DeploymentResult,
  EIP1193Provider,
} from "@nomicfoundation/ignition-core";
import type { DeploymentSpec } from "../spec/types.js";
import { validateSpec } from "../spec/validate.js";
import { compileSpec } from "../compile/compile.js";
import { DeployError } from "./errors.js";

// Re-export error types for public API surface
export type { DeployErrorCode } from "./errors.js";
export { DeployError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for deploy().
 *
 * @remarks
 * `deploymentDir` is REQUIRED for idempotency and resume. Ignition writes a
 * journal file to this directory on every run. When the same directory is
 * passed on a subsequent call, Ignition skips futures already recorded as
 * complete — the on-chain contracts are never re-deployed. Omitting
 * `deploymentDir` causes Ignition to use an in-memory ephemeral loader, which
 * means every call is a fresh deployment with no resume capability.
 */
export interface DeployOptions {
  /** The declarative deployment spec. Will be validated before compilation. */
  spec: DeploymentSpec;
  /** An EIP-1193 compatible provider for on-chain interactions. */
  provider: EIP1193Provider;
  /** List of signer accounts (hex addresses). The first account is the default sender. */
  accounts: string[];
  /**
   * Directory where Ignition will persist the deployment journal.
   * This is what makes re-runs idempotent and partial deployments resumable.
   * REQUIRED for idempotency — pass a stable, deployment-specific path.
   */
  deploymentDir: string;
  /** Resolves Solidity artifacts (ABI, bytecode) by contract name. */
  artifactResolver: ArtifactResolver;
  /**
   * Ignition module ID. Defaults to "Deployment".
   * Must be consistent across runs against the same `deploymentDir`.
   */
  moduleId?: string;
  /**
   * Ignition deployment parameters keyed by module ID.
   * See Ignition's DeploymentParameters type.
   */
  deploymentParameters?: DeploymentParameters;
  /**
   * Override the default sender (must be one of `accounts`).
   * Defaults to `accounts[0]`.
   */
  defaultSender?: string;
}

/**
 * The result of a deploy() call.
 *
 * Wraps Ignition's `DeploymentResult` discriminated union and exposes helpers
 * to check success and read deployed addresses without importing from
 * `@nomicfoundation/ignition-core` directly.
 */
export interface DeployResult {
  /**
   * True iff the deployment completed successfully (all futures are done).
   *
   * On a resume run against a fully-journaled deployment this will be true
   * with zero new on-chain transactions sent.
   */
  readonly success: boolean;

  /**
   * Map of contract ids to deployed addresses, populated on success.
   * The keys are the `id` values from the DeploymentSpec entries.
   *
   * On resume, this map also includes contracts deployed in previous runs
   * (their addresses are read from the journal, not from new transactions).
   */
  readonly deployedAddresses: Record<string, string>;

  /** The raw Ignition DeploymentResult for advanced consumers. */
  readonly ignitionResult: DeploymentResult;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deploy a DeploymentSpec idempotently and resumably.
 *
 * Idempotency: passing the same `deploymentDir` on repeated calls causes
 * Ignition's journal to skip contracts that are already deployed. No on-chain
 * transactions are sent for completed futures.
 *
 * Resumability: if a previous run was interrupted, re-running with the same
 * `deploymentDir` will deploy ONLY the contracts whose futures are not yet
 * recorded as complete in the journal.
 *
 * @throws DeployError with code "INVALID_SPEC" if the spec fails validation.
 * @throws DeployError with code "COMPILE_ERROR" if spec compilation fails.
 *
 * On-chain execution errors (e.g. reverted transactions, gas errors) are NOT
 * thrown — they are returned in `result.ignitionResult` with a non-SUCCESSFUL
 * type. Check `result.success` and `result.ignitionResult` for details.
 */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const {
    spec,
    provider,
    accounts,
    deploymentDir,
    artifactResolver,
    moduleId,
    deploymentParameters,
    defaultSender,
  } = options;

  // --- 1. Validate spec -------------------------------------------------------
  const validateResult = validateSpec(spec);
  if (!validateResult.ok) {
    throw new DeployError(
      "INVALID_SPEC",
      `DeploymentSpec validation failed with ${validateResult.errors.length} error(s): ${validateResult.errors.map((e) => e.message).join("; ")}`,
      validateResult.errors,
    );
  }

  // --- 2. Compile spec into an Ignition module --------------------------------
  let ignitionModule;
  try {
    ignitionModule = compileSpec(validateResult.spec, { moduleId });
  } catch (err) {
    // CompileError is a class with a .message — re-wrap for a clean public API
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeployError(
      "COMPILE_ERROR",
      `Failed to compile DeploymentSpec into an Ignition module: ${msg}`,
    );
  }

  // --- 3. Run Ignition deploy — idempotency/resume live here ------------------
  //
  // Ignition's deploy() creates (or reads) a journal at
  // `<deploymentDir>/journal.jsonl`. Futures already recorded as complete are
  // replayed from the journal with zero new on-chain transactions. Futures not
  // yet in the journal are executed and appended to it.
  //
  // We intentionally do NOT touch the journal ourselves — Ignition owns it.
  const ignitionResult = await ignitionDeploy({
    ignitionModule,
    provider,
    accounts,
    deploymentDir,
    artifactResolver,
    deploymentParameters: deploymentParameters ?? {},
    defaultSender,
  });

  // --- 4. Build our result wrapper -------------------------------------------
  const success = ignitionResult.type === DeploymentResultType.SUCCESSFUL_DEPLOYMENT;

  const deployedAddresses: Record<string, string> = {};
  if (success && ignitionResult.type === DeploymentResultType.SUCCESSFUL_DEPLOYMENT) {
    // Ignition prefixes every contract key with "<moduleId>#" (e.g. "Deployment#registry").
    // We strip the prefix so callers can look up addresses by their spec entry id
    // (e.g. deployedAddresses["registry"]) without needing to know the moduleId.
    const resolvedModuleId = ignitionModule.id;
    const prefix = `${resolvedModuleId}#`;
    for (const [key, contract] of Object.entries(ignitionResult.contracts)) {
      const entryId = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      deployedAddresses[entryId] = contract.address;
    }
  }

  return {
    success,
    deployedAddresses,
    ignitionResult,
  };
}

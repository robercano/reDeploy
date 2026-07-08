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
 *   2. Resolve `{ kind: "resolver" }` args against the injected
 *      `DeployOptions.resolvers` registry — an async pre-pass that runs
 *      BEFORE compilation (see resolve/resolveSpec.ts and resolve/registry.ts
 *      for the full Layer 2 "typed resolver escape-hatch" design). This is a
 *      no-op (skipped entirely) for specs that don't use resolver args.
 *   3. Compile the (now fully-resolved) spec into an Ignition module.
 *   4. Thread `deploymentDir` through to Ignition's `deploy()` so the journal
 *      persists across calls — do NOT reinvent journaling here.
 *   5. Wrap the raw DeploymentResult with enough accessors to let callers
 *      check success and read deployed addresses.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  deploy as ignitionDeploy,
  status as ignitionStatus,
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
import type { ResolverRegistry } from "../resolve/registry.js";
import {
  buildResolverParams,
  resolveSpecResolverArgs,
  specHasResolverArgs,
} from "../resolve/resolveSpec.js";
import { ResolveError } from "../resolve/errors.js";

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
  /**
   * Injectable resolver registry for `{ kind: "resolver" }` args (Layer 2
   * typed escape-hatch — see spec/types.ts's ResolverArg). Optional: specs
   * with no resolver args never touch this option. Every resolver name
   * referenced by a `{ kind: "resolver" }` arg anywhere in `spec.contracts`
   * must appear as a key here, or deploy() throws
   * `DeployError("UNKNOWN_RESOLVER")` before any compilation or on-chain
   * activity happens.
   *
   * See resolve/registry.ts for the full `Resolver`/`ResolverContext`
   * contract, the v1 scope boundary (resolvers cannot read sibling-contract
   * addresses from THIS run), and the security/trust-boundary notes
   * (resolvers are trusted, in-repo code — never loaded dynamically).
   */
  resolvers?: ResolverRegistry;
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
// Internal helpers — resolver pre-resolution pass plumbing
// ---------------------------------------------------------------------------

/**
 * Strips Ignition's "<moduleId>#" future-id prefix so callers can index by
 * their spec entry id. Shared between the post-deploy address extraction
 * (step 5 below) and the pre-deploy journal read for
 * `ResolverContext.resolvedAddresses` (step 2 below) so both paths agree on
 * the exact same id shape.
 */
function stripModulePrefix(key: string, moduleId: string): string {
  const prefix = `${moduleId}#`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Best-effort read of addresses already deployed in a PREVIOUS run against
 * `deploymentDir`, for `ResolverContext.resolvedAddresses`. Returns an empty
 * object for a fresh deployment (no journal yet) — that is the documented v1
 * behavior (see resolve/registry.ts's scope-boundary note), not an error.
 *
 * We check for `journal.jsonl`'s existence before calling Ignition's
 * `status()` because `status()` throws an `IgnitionError` for a
 * `deploymentDir` with no journal, and a fresh-deploy resolver run should not
 * depend on parsing/matching that error shape.
 */
async function loadResolvedAddressesFromJournal(
  deploymentDir: string,
  moduleId: string,
): Promise<Record<string, string>> {
  const journalPath = join(deploymentDir, "journal.jsonl");
  if (!existsSync(journalPath)) {
    return {};
  }
  const statusResult = await ignitionStatus(deploymentDir);
  const resolvedAddresses: Record<string, string> = {};
  for (const [key, contract] of Object.entries(statusResult.contracts)) {
    resolvedAddresses[stripModulePrefix(key, moduleId)] = contract.address;
  }
  return resolvedAddresses;
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
 * @throws DeployError with code "UNKNOWN_RESOLVER" if a `{ kind: "resolver" }`
 *   arg names a resolver absent from `DeployOptions.resolvers`.
 * @throws DeployError with code "RESOLVER_ERROR" if a resolver invocation
 *   fails, or a spec parameter cannot be coerced to the bigint shape
 *   `ResolverContext.params` requires.
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

  // --- 2. Resolve `resolver` args (Layer 2 typed escape-hatch) ----------------
  //
  // MUST run before compileSpec() — Ignition's builder has no concept of
  // resolver args; by the time compileSpec() sees the spec, every resolver
  // arg must already be a concrete literal. See resolve/registry.ts for the
  // full design, v1 scope boundary, and security/trust-boundary notes.
  //
  // Skipped entirely (no journal read, no param build, no registry lookup)
  // when the spec has no resolver args — the common case — so deploy() has
  // zero extra cost for specs that don't use this feature.
  const effectiveModuleId = moduleId ?? "Deployment";
  let specForCompile: DeploymentSpec = validateResult.spec;
  if (specHasResolverArgs(specForCompile)) {
    try {
      const resolvedAddresses = await loadResolvedAddressesFromJournal(
        deploymentDir,
        effectiveModuleId,
      );
      const params = buildResolverParams(
        specForCompile,
        effectiveModuleId,
        deploymentParameters,
      );
      specForCompile = await resolveSpecResolverArgs(specForCompile, {
        registry: options.resolvers ?? {},
        params,
        resolvedAddresses,
        provider,
      });
    } catch (err) {
      if (err instanceof ResolveError) {
        throw new DeployError(
          err.code === "UNKNOWN_RESOLVER" ? "UNKNOWN_RESOLVER" : "RESOLVER_ERROR",
          err.message,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new DeployError(
        "RESOLVER_ERROR",
        `Failed to resolve DeploymentSpec resolver args: ${msg}`,
      );
    }
  }

  // --- 3. Compile spec into an Ignition module --------------------------------
  let ignitionModule;
  try {
    ignitionModule = compileSpec(specForCompile, { moduleId });
  } catch (err) {
    // CompileError is a class with a .message — re-wrap for a clean public API
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeployError(
      "COMPILE_ERROR",
      `Failed to compile DeploymentSpec into an Ignition module: ${msg}`,
    );
  }

  // --- 4. Run Ignition deploy — idempotency/resume live here ------------------
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

  // --- 5. Build our result wrapper -------------------------------------------
  const success = ignitionResult.type === DeploymentResultType.SUCCESSFUL_DEPLOYMENT;

  const deployedAddresses: Record<string, string> = {};
  if (success && ignitionResult.type === DeploymentResultType.SUCCESSFUL_DEPLOYMENT) {
    // Ignition prefixes every contract key with "<moduleId>#" (e.g. "Deployment#registry").
    // We strip the prefix so callers can look up addresses by their spec entry id
    // (e.g. deployedAddresses["registry"]) without needing to know the moduleId.
    const resolvedModuleId = ignitionModule.id;
    for (const [key, contract] of Object.entries(ignitionResult.contracts)) {
      const entryId = stripModulePrefix(key, resolvedModuleId);
      deployedAddresses[entryId] = contract.address;
    }
  }

  return {
    success,
    deployedAddresses,
    ignitionResult,
  };
}

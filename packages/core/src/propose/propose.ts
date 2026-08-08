/**
 * Propose execution mode for @redeploy/core (issue #154).
 *
 * `proposeDeploy()` runs the SAME spec-resolution + compilation pipeline as
 * `deploy()` (validate -> resolve crossRef args -> resolve resolver args ->
 * compileSpec), but instead of broadcasting transactions with the real
 * `provider`, it collects the ordered batch of transactions Ignition WOULD
 * have sent (`to`/`data`/`value`, in send order) and returns them — no
 * transaction is ever signed or broadcast by this function.
 *
 * WHY REUSE IGNITION'S ENGINE INSTEAD OF REINVENTING A PLANNER
 * ==============================================================
 * `simulate()` (simulate/simulate.ts) is deliberately chain-free and does
 * NOT compile a real Ignition module or assign addresses — it can't produce
 * real transaction calldata (constructor-arg encoding, proxy expansion,
 * predicted addresses for `ref`-dependent futures). Reimplementing
 * Ignition's constructor-arg encoding / dependency batching / CREATE address
 * prediction here would violate this package's "don't reinvent what
 * Ignition provides" rule (CLAUDE.md) and would drift from Ignition's actual
 * behavior over time.
 *
 * Instead, `proposeDeploy()` runs Ignition's REAL `deploy()` engine against
 * a `collectingProvider` (see propose/collectingProvider.ts) that intercepts
 * `eth_sendTransaction` and never lets it reach a real chain. Everything
 * downstream of "what transaction would Ignition send next" — encoding,
 * ordering, proxy expansion, address prediction — is therefore IDENTICAL to
 * a real `deploy()` run against the same spec.
 *
 * JOURNAL SAFETY (the load-bearing invariant — issue #154, point 4)
 * ====================================================================
 * `proposeDeploy()` NEVER passes the caller's real `deploymentDir` to
 * Ignition's `deploy()`. Instead:
 *
 *   - If `ProposeOptions.deploymentDir` is omitted, Ignition runs against a
 *     throwaway temp directory that is deleted when `proposeDeploy()`
 *     returns. No journal.jsonl is ever created at any caller-visible path.
 *
 *   - If `ProposeOptions.deploymentDir` IS given (the "propose the REMAINING
 *     work of a partially-completed deployment" case — see this package's
 *     README, "Propose mode" section, for the full confirm-then-resume
 *     flow), its `journal.jsonl` is COPIED (read-only on the original) into
 *     the same throwaway temp directory before Ignition runs. Ignition then
 *     sees the real resume state (skips already-COMPLETE futures, exactly
 *     like a normal `deploy()` resume) and only sends — i.e. only collects —
 *     transactions for futures that are NOT yet complete. The throwaway copy
 *     (with whatever new entries Ignition appends to IT during this
 *     ephemeral run) is deleted at the end. The caller's real
 *     `deploymentDir` is opened at most once, for a read, and is NEVER
 *     opened for a write by this function.
 *
 * Either way, a transaction that is only PROPOSED (never signed/broadcast by
 * an external signer or Safe) can never end up recorded as COMPLETE in the
 * real, resumable journal — because that journal is never the one Ignition
 * writes to here. See test/propose.test.ts's "journal invariant" tests for
 * the executable proof.
 *
 * WHAT HAPPENS AFTER THE SAFE EXECUTES THE BATCH (confirm-then-resume)
 * ========================================================================
 * See this package's README ("Propose mode") for the full operator flow.
 * In short: `proposeDeploy()` only PLANS; it never updates the real journal.
 * After the proposed batch is actually executed on-chain (by the Safe's
 * signers, or by an external signer processing the batch one at a time),
 * the operator resumes with a NORMAL `deploy()` call using a `provider`
 * capable of observing that the transactions already succeeded (e.g. a
 * signer whose `accounts[0]` IS the address that actually sent them) so
 * Ignition's own idempotent journal-replay logic takes back over. Bridging
 * "the Safe executed transaction batch X" back into Ignition's own journal
 * format (so a plain `deploy()` resume also works when the SAFE itself —
 * not an EOA the journal already recognizes — was the sender) is explicitly
 * OUT OF SCOPE for this change; see the README for the documented seam.
 */

import { deploy as ignitionDeploy, DeploymentResultType } from "@nomicfoundation/ignition-core";
import type {
  ArtifactResolver,
  DeploymentParameters,
  EIP1193Provider,
} from "@nomicfoundation/ignition-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeploymentSpec } from "../spec/types.js";
import { validateSpec } from "../spec/validate.js";
import { compileSpec } from "../compile/compile.js";
import type { ResolverRegistry } from "../resolve/registry.js";
import {
  buildResolverParams,
  resolveSpecResolverArgs,
  specHasResolverArgs,
} from "../resolve/resolveSpec.js";
import { ResolveError } from "../resolve/errors.js";
import { loadAddressesFromJournal } from "../resolve/journal.js";
import type { CrossNetworkJournal } from "../resolve/crossRef.js";
import { resolveCrossRefArgs, specHasCrossRefArgs } from "../resolve/crossRef.js";
import { CrossRefError } from "../resolve/crossRefErrors.js";
import { ProposeError } from "./errors.js";
import { makeCollectingProvider } from "./collectingProvider.js";
import type { CollectedTransaction } from "./collectingProvider.js";

// Re-export error types for public API surface
export type { ProposeErrorCode } from "./errors.js";
export { ProposeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One proposed transaction, in the order Ignition would have sent it.
 *
 * `to === null` marks a contract-CREATION transaction (Ignition's basic
 * strategy uses raw CREATE — no factory). See safeBatch.ts's module doc for
 * why this specific shape is NOT directly representable in a Safe
 * Transaction Builder batch, and the documented seam for that gap.
 */
export interface ProposedTransaction {
  /** `null` for contract creation; the target contract address for a call. */
  readonly to: string | null;
  /** Calldata — init code + encoded constructor args for creation, or a function call. */
  readonly data: string;
  /** Value in wei, as a decimal string. */
  readonly value: string;
}

/**
 * Options for proposeDeploy(). Mirrors DeployOptions (deploy/deploy.ts) —
 * same injectable seams (`provider`, `accounts`, `resolvers`,
 * `crossNetworkJournals`) — except `deploymentDir` is OPTIONAL and, when
 * given, is used STRICTLY READ-ONLY (see this file's module doc, "JOURNAL
 * SAFETY"). There is no `preflight` option: propose mode never broadcasts,
 * so pre-broadcast safety checks (chain id / balance / gas price) don't
 * apply the same way here — call `runPreflight()` (deploy/preflight.ts)
 * yourself first if you want an equivalent sanity check before proposing.
 */
export interface ProposeOptions {
  /** The declarative deployment spec. Will be validated before compilation. */
  spec: DeploymentSpec;
  /**
   * An EIP-1193 compatible provider for on-chain READS ONLY (current nonce,
   * chain id, and any resolver-arg reads). NEVER used to sign or broadcast —
   * see collectingProvider.ts.
   */
  provider: EIP1193Provider;
  /** List of signer accounts (hex addresses). The first account is the default sender. */
  accounts: string[];
  /** Resolves Solidity artifacts (ABI, bytecode) by contract name. */
  artifactResolver: ArtifactResolver;
  /** Ignition module ID. Defaults to "Deployment". Must match the real deployment's, if resuming. */
  moduleId?: string;
  /** Ignition deployment parameters keyed by module ID. */
  deploymentParameters?: DeploymentParameters;
  /** Override the default sender (must be one of `accounts`). Defaults to `accounts[0]`. */
  defaultSender?: string;
  /** Injectable resolver registry for `{ kind: "resolver" }` args. See DeployOptions.resolvers. */
  resolvers?: ResolverRegistry;
  /** Injected map of network name -> journal location, for `{ kind: "crossRef" }` args. */
  crossNetworkJournals?: Record<string, CrossNetworkJournal>;
  /**
   * OPTIONAL path to an EXISTING real deployment's directory. When given,
   * its `journal.jsonl` is read (NEVER written) to determine which futures
   * are already complete, so proposeDeploy() only proposes the REMAINING
   * work — the "propose mode as a resume step" case. Omit this to propose a
   * fresh deployment from scratch.
   */
  deploymentDir?: string;
}

/** The result of a proposeDeploy() call. */
export interface ProposeResult {
  /** The ordered batch of transactions Ignition would have sent, never broadcast. */
  readonly transactions: ProposedTransaction[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a DeploymentSpec's transactions WITHOUT broadcasting or signing any of
 * them, and WITHOUT ever marking any future complete in a real, resumable
 * journal — see this file's module doc for the full design and the
 * "JOURNAL SAFETY" invariant.
 *
 * @throws ProposeError mirroring DeployError's codes for the shared
 *   validate/resolve/compile pipeline (INVALID_SPEC, UNKNOWN_RESOLVER,
 *   RESOLVER_ERROR, CROSS_REF_ERROR, COMPILE_ERROR), plus EXECUTION_FAILED
 *   if the ephemeral collection run itself does not complete successfully.
 */
export async function proposeDeploy(options: ProposeOptions): Promise<ProposeResult> {
  const {
    spec,
    provider,
    accounts,
    artifactResolver,
    moduleId,
    deploymentParameters,
    defaultSender,
    deploymentDir,
  } = options;

  // --- 1. Validate spec -------------------------------------------------------
  const validateResult = validateSpec(spec);
  if (!validateResult.ok) {
    throw new ProposeError(
      "INVALID_SPEC",
      `DeploymentSpec validation failed with ${validateResult.errors.length} error(s): ${validateResult.errors.map((e) => e.message).join("; ")}`,
      validateResult.errors,
    );
  }

  const effectiveModuleId = moduleId ?? "Deployment";
  let specForCompile: DeploymentSpec = validateResult.spec;

  // --- 2. Resolve `crossRef` args (mirrors deploy.ts step 2) ------------------
  if (specHasCrossRefArgs(specForCompile)) {
    try {
      specForCompile = await resolveCrossRefArgs(specForCompile, {
        journals: options.crossNetworkJournals ?? {},
      });
    } catch (err) {
      if (err instanceof CrossRefError) {
        throw new ProposeError("CROSS_REF_ERROR", err.message);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProposeError(
        "CROSS_REF_ERROR",
        `Failed to resolve DeploymentSpec crossRef args: ${msg}`,
      );
    }
  }

  // --- 3. Resolve `resolver` args (mirrors deploy.ts step 3) ------------------
  //
  // Uses the REAL `provider` for any on-chain reads a resolver performs, and
  // (if resuming) the REAL deploymentDir's journal for already-known
  // addresses — both READ-ONLY, same as deploy(). This runs BEFORE the
  // collecting provider even exists.
  if (specHasResolverArgs(specForCompile)) {
    try {
      const resolvedAddresses = deploymentDir
        ? await loadAddressesFromJournal(deploymentDir, effectiveModuleId)
        : {};
      const params = buildResolverParams(specForCompile, effectiveModuleId, deploymentParameters);
      specForCompile = await resolveSpecResolverArgs(specForCompile, {
        registry: options.resolvers ?? {},
        params,
        resolvedAddresses,
        provider,
      });
    } catch (err) {
      if (err instanceof ResolveError) {
        throw new ProposeError(
          err.code === "UNKNOWN_RESOLVER" ? "UNKNOWN_RESOLVER" : "RESOLVER_ERROR",
          err.message,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProposeError(
        "RESOLVER_ERROR",
        `Failed to resolve DeploymentSpec resolver args: ${msg}`,
      );
    }
  }

  // --- 4. Compile spec into an Ignition module --------------------------------
  let ignitionModule;
  try {
    ignitionModule = compileSpec(specForCompile, { moduleId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProposeError(
      "COMPILE_ERROR",
      `Failed to compile DeploymentSpec into an Ignition module: ${msg}`,
    );
  }

  // --- 5. Ephemeral collection run — see "JOURNAL SAFETY" in the module doc ---
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-propose-"));
  try {
    if (deploymentDir !== undefined) {
      const realJournalPath = path.join(deploymentDir, "journal.jsonl");
      if (fs.existsSync(realJournalPath)) {
        // READ-ONLY on the caller's real deploymentDir: copy it into the
        // throwaway tmpDir. Every subsequent read/write for THIS run targets
        // ONLY tmpDir — the original path is never opened for writing.
        fs.cpSync(deploymentDir, tmpDir, { recursive: true });
      }
    }

    const { provider: collectingProvider, transactions } = makeCollectingProvider({
      realProvider: provider,
    });

    const ignitionResult = await ignitionDeploy({
      ignitionModule,
      provider: collectingProvider,
      accounts,
      deploymentDir: tmpDir,
      artifactResolver,
      deploymentParameters: deploymentParameters ?? {},
      defaultSender,
    });

    if (ignitionResult.type !== DeploymentResultType.SUCCESSFUL_DEPLOYMENT) {
      throw new ProposeError(
        "EXECUTION_FAILED",
        `Propose-mode collection run did not complete successfully (Ignition result type: ${ignitionResult.type}). ` +
          `This usually means a future in the spec could not be planned by the ephemeral collecting provider.`,
      );
    }

    return {
      transactions: transactions.map(
        (tx: CollectedTransaction): ProposedTransaction => ({
          to: tx.to,
          data: tx.data,
          value: tx.value,
        }),
      ),
    };
  } finally {
    // ALWAYS discard the throwaway directory — this run's state (and the
    // copied journal snapshot, if any) never persists anywhere.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

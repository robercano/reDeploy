/**
 * Resumable, idempotent config execution engine for @redeploy/config.
 *
 * DESIGN
 * ======
 *
 * Unlike deployment (where idempotency is delegated to Hardhat Ignition's
 * journal), post-deployment configuration is executed by an injected
 * ConfigExecutor — there is no Ignition wrapper here. This module provides
 * its OWN per-step journal so that partial config runs can be resumed:
 *
 *   Journal file: `<stateDir>/config-state.jsonl`
 *   Format: one JSON record per line — { id, kind, completedAt }
 *
 * RESUME SEMANTICS (at-least-once per step)
 * ==========================================
 *
 *   1. Before executing, we read the journal to learn which steps are already
 *      complete (from a previous run).
 *   2. We iterate spec.steps IN ORDER.
 *   3. Steps whose id is already in the journal are SKIPPED — the executor is
 *      never called for them again.
 *   4. For each remaining step we:
 *        a. Resolve all refs to addresses (throws UNKNOWN_REF on unknown ids).
 *        b. Build a resolved ConfigCall.
 *        c. Call executor.execute(call) and await it.
 *        d. ONLY on success: append a completion record to the journal.
 *   5. If the executor throws, the error propagates immediately. The journal
 *      retains only the steps that completed before the failure. Re-running
 *      with the same stateDir resumes from the first un-journaled step.
 *
 * At-least-once: if the process crashes AFTER the on-chain call succeeds but
 * BEFORE the journal append completes, the step will be re-executed on the
 * next run. On-chain idempotency of re-execution is out of scope — callers
 * should design their contracts accordingly.
 *
 * STEP-KIND → ConfigCall MAPPING
 * ================================
 *
 *   setX      → target  = deployedAddresses[step.target]
 *               function = step.function
 *               args     = step.args (each ref resolved to its address)
 *
 *   grantRole → target  = deployedAddresses[step.target]
 *               function = "grantRole"
 *               role     = step.role
 *               args     = [resolvedAccountAddress]
 *
 *   wire      → target  = deployedAddresses[step.into]
 *               function = step.function
 *               args     = [deployedAddresses[step.source]]
 */

import { validateConfig } from "../steps/validate.js";
import { ConfigExecError } from "./errors.js";
import { readCompletedStepIds, appendCompletedStep } from "./journal.js";
import type {
  ApplyConfigOptions,
  ApplyConfigResult,
  ConfigCall,
  ResolvedArg,
} from "./types.js";
import type { ConfigSpec, ConfigStep, ConfigArg } from "../steps/types.js";

// Re-export for convenient public API access from this module
export type { ApplyConfigOptions, ApplyConfigResult, ConfigCall, ResolvedArg } from "./types.js";
export { ConfigExecError } from "./errors.js";
export type { ConfigExecErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a single ConfigArg to a ResolvedArg.
 *
 * - Literal args pass through unchanged.
 * - Ref args are looked up in `deployedAddresses`; throws UNKNOWN_REF if the
 *   id is not present.
 */
function resolveArg(
  arg: ConfigArg,
  deployedAddresses: Record<string, string>,
  contextLabel: string,
): ResolvedArg {
  if (arg.kind === "literal") {
    return arg.value as ResolvedArg;
  }
  // arg.kind === "ref"
  const address = deployedAddresses[arg.contract];
  if (address === undefined) {
    throw new ConfigExecError(
      "UNKNOWN_REF",
      `${contextLabel}: ref "${arg.contract}" could not be resolved — not found in deployedAddresses`,
    );
  }
  return address;
}

/**
 * Resolve a named contract id to its deployed address.
 * Throws UNKNOWN_REF if not found.
 */
function resolveContractId(
  id: string,
  deployedAddresses: Record<string, string>,
  contextLabel: string,
): string {
  const address = deployedAddresses[id];
  if (address === undefined) {
    throw new ConfigExecError(
      "UNKNOWN_REF",
      `${contextLabel}: contract id "${id}" could not be resolved — not found in deployedAddresses`,
    );
  }
  return address;
}

/**
 * Build a resolved ConfigCall from a ConfigStep.
 *
 * All refs in the step are resolved to addresses before this function returns.
 * Throws ConfigExecError("UNKNOWN_REF") for any unresolvable ref.
 */
function buildConfigCall(
  step: ConfigStep,
  deployedAddresses: Record<string, string>,
): ConfigCall {
  const stepLabel = `step "${step.id}" (${step.kind})`;

  switch (step.kind) {
    case "setX": {
      const target = resolveContractId(step.target, deployedAddresses, stepLabel);
      const args: ResolvedArg[] = (step.args ?? []).map((arg, i) =>
        resolveArg(arg, deployedAddresses, `${stepLabel} args[${i}]`),
      );
      return {
        stepId: step.id,
        kind: step.kind,
        target,
        function: step.function,
        args,
      };
    }

    case "grantRole": {
      const target = resolveContractId(step.target, deployedAddresses, stepLabel);
      const accountAddress = resolveArg(
        step.account,
        deployedAddresses,
        `${stepLabel} account`,
      );
      return {
        stepId: step.id,
        kind: step.kind,
        target,
        function: "grantRole",
        role: step.role,
        args: [accountAddress],
      };
    }

    case "wire": {
      // The `into` contract receives the call; `source` is the argument.
      const target = resolveContractId(step.into, deployedAddresses, stepLabel);
      const sourceAddress = resolveContractId(step.source, deployedAddresses, stepLabel);
      return {
        stepId: step.id,
        kind: step.kind,
        target,
        function: step.function,
        args: [sourceAddress],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a ConfigSpec idempotently and resumably against a set of deployed
 * contracts.
 *
 * Idempotency: passing the same `stateDir` on repeated calls causes the
 * engine to skip steps that are already recorded in the journal. The executor
 * is never called for already-complete steps.
 *
 * Resumability: if a previous run was interrupted (executor threw, process
 * crashed), re-running with the same `stateDir` will execute ONLY the steps
 * not yet recorded in the journal.
 *
 * @throws ConfigExecError with code "INVALID_SPEC" if the spec fails
 *   validateConfig() (checked against deployedAddresses keys).
 * @throws ConfigExecError with code "UNKNOWN_REF" if a ref cannot be
 *   resolved during step execution (defensive; normally caught by INVALID_SPEC).
 * @throws ConfigExecError with code "JOURNAL_ERROR" if the journal file
 *   exists but cannot be read.
 * @throws any error thrown by executor.execute() — NOT wrapped.
 */
export async function applyConfig(options: ApplyConfigOptions): Promise<ApplyConfigResult> {
  const { spec, deployedAddresses, executor, stateDir } = options;

  // --- 1. Validate the spec FIRST (fail fast) --------------------------------
  //
  // Pass Object.keys(deployedAddresses) so validateConfig can check that all
  // refs in the spec (target, source, into, account, args refs) resolve to
  // known deployed ids. A MISSING_REF here surfaces as INVALID_SPEC, not
  // UNKNOWN_REF — the spec is considered invalid if it references unknown ids.
  const validateResult = validateConfig(spec, Object.keys(deployedAddresses));
  if (!validateResult.ok) {
    throw new ConfigExecError(
      "INVALID_SPEC",
      `ConfigSpec validation failed with ${validateResult.errors.length} error(s): ${validateResult.errors.map((e) => e.message).join("; ")}`,
      validateResult.errors,
    );
  }

  const validatedSpec: ConfigSpec = validateResult.spec;

  // --- 2. Read the journal — learn which steps are already complete ----------
  const alreadyCompleted = readCompletedStepIds(stateDir);

  // --- 3. Execute each step in order ----------------------------------------
  const executedStepIds: string[] = [];
  const skippedStepIds: string[] = [];

  for (const step of validatedSpec.steps) {
    if (alreadyCompleted.has(step.id)) {
      // Already journaled from a previous run — skip.
      skippedStepIds.push(step.id);
      continue;
    }

    // Resolve refs and build the ConfigCall.
    // UNKNOWN_REF here is defensive (INVALID_SPEC above should catch missing
    // refs), but we keep it for correctness when deployedAddresses diverges.
    const call = buildConfigCall(step, deployedAddresses);

    // Execute the call. If it throws, the error propagates immediately.
    // We do NOT catch it — the journal keeps its current state so the next
    // run resumes from this step.
    await executor.execute(call);

    // Only on success: append to the journal.
    appendCompletedStep(stateDir, {
      id: step.id,
      kind: step.kind,
      completedAt: new Date().toISOString(),
    });

    executedStepIds.push(step.id);
    alreadyCompleted.add(step.id);
  }

  // --- 4. Build and return the result ----------------------------------------
  const completedStepIds = validatedSpec.steps
    .map((s) => s.id)
    .filter((id) => alreadyCompleted.has(id));

  return {
    success: true,
    executedStepIds,
    skippedStepIds,
    completedStepIds,
  };
}

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
 * ORDERED vs. UNORDERED STEPS
 * ============================
 *
 * A ConfigSpec has two step lists:
 *
 *   spec.steps        — unordered per-node steps. Executed first, in array
 *                       order (but callers must not rely on the order between
 *                       steps; it may become parallel in the future).
 *
 *   spec.orderedSteps — globally ordered steps. Executed in strict array-
 *                       index order AFTER all unordered steps complete. Step
 *                       N+1 never starts until step N has been journaled.
 *
 * Both lists share the same step-id journal. Resume picks up from the first
 * un-journaled step in each list (steps first, then orderedSteps).
 *
 * RESUME SEMANTICS (at-least-once per step)
 * ==========================================
 *
 *   1. Build a safe Map<string,string> from own-enumerable entries of
 *      deployedAddresses (defence-in-depth against prototype-key mis-reads).
 *   2. Validate the spec (fail fast — INVALID_SPEC if any ref is unknown).
 *   3. Read the journal to learn which steps are already complete (from a
 *      previous run).
 *   4. Iterate spec.steps IN ORDER. Steps already in the journal are SKIPPED.
 *   5. Iterate spec.orderedSteps IN STRICT ARRAY ORDER. Steps already in the
 *      journal are SKIPPED. Each step waits for the previous to complete.
 *   6. For each remaining step (in either list):
 *        a. Resolve all refs to addresses via the safe Map (throws UNKNOWN_REF
 *           on unknown or prototype-key ids).
 *        b. Build a resolved ConfigCall.
 *        c. Call executor.execute(call) and await it.
 *        d. ONLY on success: append a completion record to the journal.
 *   7. If the executor throws, the error propagates immediately. The journal
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
 *   setX      → target  = safeAddresses.get(step.target)
 *               function = step.function
 *               args     = step.args (each ref resolved to its address)
 *
 *   grantRole → target  = safeAddresses.get(step.target)
 *               function = "grantRole"
 *               role     = step.role
 *               args     = [resolvedAccountAddress]
 *
 *   wire      → target  = safeAddresses.get(step.into)
 *               function = step.function
 *               args     = [safeAddresses.get(step.source)]
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
 * - Ref args are looked up in `safeAddresses` (a Map built from own-enumerable
 *   entries of deployedAddresses at the start of applyConfig); throws
 *   UNKNOWN_REF if the id is absent from the Map. Using a Map makes the lookup
 *   intrinsically safe: prototype keys such as "constructor", "__proto__", and
 *   "toString" are never present in the Map and therefore always throw
 *   UNKNOWN_REF, even if they somehow bypassed upstream validation.
 */
function resolveArg(
  arg: ConfigArg,
  safeAddresses: Map<string, string>,
  contextLabel: string,
): ResolvedArg {
  if (arg.kind === "literal") {
    return arg.value as ResolvedArg;
  }
  // arg.kind === "ref"
  const address = safeAddresses.get(arg.contract);
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
 *
 * Uses `safeAddresses` (a Map built from own-enumerable entries of
 * deployedAddresses) so prototype keys ("constructor", "__proto__",
 * "toString", etc.) are never matched and always raise UNKNOWN_REF.
 */
function resolveContractId(
  id: string,
  safeAddresses: Map<string, string>,
  contextLabel: string,
): string {
  const address = safeAddresses.get(id);
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
 *
 * @param safeAddresses - A Map built exclusively from own-enumerable entries of
 *   deployedAddresses (see applyConfig). Using a Map rather than the raw
 *   Record prevents prototype-key mis-resolution.
 */
function buildConfigCall(
  step: ConfigStep,
  safeAddresses: Map<string, string>,
): ConfigCall {
  const stepLabel = `step "${step.id}" (${step.kind})`;

  switch (step.kind) {
    case "setX": {
      const target = resolveContractId(step.target, safeAddresses, stepLabel);
      const args: ResolvedArg[] = (step.args ?? []).map((arg, i) =>
        resolveArg(arg, safeAddresses, `${stepLabel} args[${i}]`),
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
      const target = resolveContractId(step.target, safeAddresses, stepLabel);
      const accountAddress = resolveArg(
        step.account,
        safeAddresses,
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
      const target = resolveContractId(step.into, safeAddresses, stepLabel);
      const sourceAddress = resolveContractId(step.source, safeAddresses, stepLabel);
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

  // --- 1. Build a safe address lookup (defence-in-depth) --------------------
  //
  // Convert deployedAddresses to a Map using only own-enumerable entries.
  // This makes all subsequent ref lookups intrinsically safe: prototype keys
  // ("constructor", "__proto__", "toString", etc.) are never present in the
  // Map and always raise UNKNOWN_REF rather than returning an inherited value.
  // The Map is built once here and passed down to all resolver helpers.
  const safeAddresses = new Map<string, string>(Object.entries(deployedAddresses));

  // --- 2. Validate the spec FIRST (fail fast) --------------------------------
  //
  // Pass the same keys (from the Map) so validateConfig can check that all
  // refs in the spec (target, source, into, account, args refs) resolve to
  // known deployed ids. A MISSING_REF here surfaces as INVALID_SPEC, not
  // UNKNOWN_REF — the spec is considered invalid if it references unknown ids.
  const validateResult = validateConfig(spec, [...safeAddresses.keys()]);
  if (!validateResult.ok) {
    throw new ConfigExecError(
      "INVALID_SPEC",
      `ConfigSpec validation failed with ${validateResult.errors.length} error(s): ${validateResult.errors.map((e) => e.message).join("; ")}`,
      validateResult.errors,
    );
  }

  const validatedSpec: ConfigSpec = validateResult.spec;

  // --- 3. Read the journal — learn which steps are already complete ----------
  const alreadyCompleted = readCompletedStepIds(stateDir);

  // --- 4. Execute each step in order ----------------------------------------
  const executedStepIds: string[] = [];
  const skippedStepIds: string[] = [];

  /**
   * Execute a single step: skip if already journaled, otherwise resolve refs,
   * call executor, and journal on success. Mutates `executedStepIds`,
   * `skippedStepIds`, and `alreadyCompleted` in place.
   */
  async function executeStep(step: ConfigStep): Promise<void> {
    if (alreadyCompleted.has(step.id)) {
      // Already journaled from a previous run — skip.
      skippedStepIds.push(step.id);
      return;
    }

    // Resolve refs and build the ConfigCall.
    // UNKNOWN_REF here is defensive (INVALID_SPEC above should catch missing
    // refs), but we keep it for correctness when deployedAddresses diverges,
    // and to guard against prototype-key refs that bypassed validation.
    const call = buildConfigCall(step, safeAddresses);

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

  // Execute unordered steps (spec.steps) first — current array order is used
  // but callers must not depend on inter-step ordering here.
  for (const step of validatedSpec.steps) {
    await executeStep(step);
  }

  // Execute globally ordered steps (spec.orderedSteps) in strict array order.
  // Each step must complete (or be skipped as already-journaled) before the
  // next one starts. This guarantees that orderedSteps[N+1] never runs before
  // orderedSteps[N] has been recorded in the journal.
  const orderedSteps = validatedSpec.orderedSteps ?? [];
  for (const step of orderedSteps) {
    await executeStep(step);
  }

  // --- 5. Build and return the result ----------------------------------------
  // Collect all step ids in both lists; filter to those already journaled.
  const allStepIds = [
    ...validatedSpec.steps.map((s) => s.id),
    ...orderedSteps.map((s) => s.id),
  ];
  const completedStepIds = allStepIds.filter((id) => alreadyCompleted.has(id));

  return {
    success: true,
    executedStepIds,
    skippedStepIds,
    completedStepIds,
  };
}

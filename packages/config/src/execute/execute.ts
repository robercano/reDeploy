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
 *   4. Iterate spec.steps IN ORDER. Steps already in the journal are SKIPPED
 *      — the step's args are never resolved and NO read arg is ever invoked
 *      for a skipped step.
 *   5. Iterate spec.orderedSteps IN STRICT ARRAY ORDER. Steps already in the
 *      journal are SKIPPED (same no-read guarantee as above). Each step
 *      waits for the previous to complete.
 *   6. For each remaining (non-skipped) step (in either list):
 *        a. Resolve all refs to addresses via the safe Map (throws UNKNOWN_REF
 *           on unknown or prototype-key ids).
 *        b. Resolve any `read` args by calling `executor.read()` (throws
 *           READ_UNSUPPORTED if the executor has no `read` method) — this is
 *           the ONLY point at which a read (`eth_call`) is ever performed.
 *        c. Build a resolved ConfigCall.
 *        d. Call executor.execute(call) and await it.
 *        e. ONLY on success: append a completion record to the journal.
 *   7. If the executor throws, the error propagates immediately. The journal
 *      retains only the steps that completed before the failure. Re-running
 *      with the same stateDir resumes from the first un-journaled step.
 *
 * At-least-once: if the process crashes AFTER the on-chain call succeeds but
 * BEFORE the journal append completes, the step will be re-executed on the
 * next run. On-chain idempotency of re-execution is out of scope — callers
 * should design their contracts accordingly.
 *
 * READ ARGS AND ORDERING
 * ========================
 *
 * The source contract for a `read` arg is always already deployed by the
 * time `applyConfig` runs (all deploys precede all config). If the value
 * being read depends on the EFFECT of an earlier config step, place the
 * reading step in `orderedSteps` AFTER that step — there is no separate
 * dependency graph for config steps; ordering is expressed purely by list
 * placement (see ORDERED vs. UNORDERED STEPS above).
 *
 * STEP-KIND → ConfigCall MAPPING
 * ================================
 *
 *   setX      → target  = safeAddresses.get(step.target)
 *               function = step.function
 *               args     = step.args (each ref resolved to its address, each
 *                          read resolved via executor.read())
 *
 *   grantRole → target  = safeAddresses.get(step.target)
 *               function = "grantRole"
 *               role     = step.role
 *               args     = [resolvedAccountAddress] (account may be a ref,
 *                          literal, or read)
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
  ConfigExecutor,
  ResolvedArg,
} from "./types.js";
import type { ConfigSpec, ConfigStep, ConfigArg, RefArg, LiteralArg } from "../steps/types.js";

// Re-export for convenient public API access from this module
export type {
  ApplyConfigOptions,
  ApplyConfigResult,
  ConfigCall,
  ReadCall,
  ResolvedArg,
} from "./types.js";
export { ConfigExecError } from "./errors.js";
export type { ConfigExecErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
 * Resolve a `ref | literal` arg (i.e. a `ReadCallArg`, or the `ref`/`literal`
 * branches of a `ConfigArg`) to a `ResolvedArg`. Synchronous — neither branch
 * needs the executor.
 *
 * - Literal args pass through unchanged.
 * - Ref args are looked up in `safeAddresses` (a Map built from own-enumerable
 *   entries of deployedAddresses at the start of applyConfig); throws
 *   UNKNOWN_REF if the id is absent from the Map. Using a Map makes the lookup
 *   intrinsically safe: prototype keys such as "constructor", "__proto__", and
 *   "toString" are never present in the Map and therefore always throw
 *   UNKNOWN_REF, even if they somehow bypassed upstream validation.
 */
function resolveSimpleArg(
  arg: RefArg | LiteralArg,
  safeAddresses: Map<string, string>,
  contextLabel: string,
): ResolvedArg {
  if (arg.kind === "literal") {
    return arg.value as ResolvedArg;
  }
  // arg.kind === "ref"
  return resolveContractId(arg.contract, safeAddresses, contextLabel);
}

/**
 * Resolve a single ConfigArg (`ref | literal | read`) to a ResolvedArg.
 *
 * - `ref` / `literal` — delegated to `resolveSimpleArg` (synchronous).
 * - `read` — resolves the read's source `contract` to an address, resolves
 *   its own (ref/literal-only) `args`, then AWAITS `executor.read()`. Throws
 *   `ConfigExecError("READ_UNSUPPORTED", ...)` if the executor has no `read`
 *   method — this check happens BEFORE the read is attempted, so a
 *   read-unsupported executor's `execute()` is never reached with
 *   unresolved/partial data for this step.
 *
 * This function is async ONLY because of the `read` branch; `applyConfig`
 * only calls it for steps that are actually being executed this run (never
 * for steps skipped because they are already journaled), so a resumed run
 * performs NO reads for skipped steps.
 */
async function resolveArg(
  arg: ConfigArg,
  safeAddresses: Map<string, string>,
  contextLabel: string,
  executor: ConfigExecutor,
): Promise<ResolvedArg> {
  if (arg.kind !== "read") {
    return resolveSimpleArg(arg, safeAddresses, contextLabel);
  }

  // arg.kind === "read"
  const target = resolveContractId(
    arg.contract,
    safeAddresses,
    `${contextLabel} read source`,
  );
  const readArgs: ResolvedArg[] = (arg.args ?? []).map((readArg, i) =>
    resolveSimpleArg(readArg, safeAddresses, `${contextLabel} read-args[${i}]`),
  );

  if (!executor.read) {
    throw new ConfigExecError(
      "READ_UNSUPPORTED",
      `${contextLabel}: read arg targets "${arg.contract}"."${arg.function}" but the injected executor does not implement read()`,
    );
  }

  return executor.read({ target, function: arg.function, args: readArgs });
}

/**
 * Build a resolved ConfigCall from a ConfigStep.
 *
 * All refs in the step are resolved to addresses, and all `read` args are
 * resolved via `executor.read()`, before this function's promise resolves.
 * Throws ConfigExecError("UNKNOWN_REF") for any unresolvable ref, or
 * ConfigExecError("READ_UNSUPPORTED") if a `read` arg is present but the
 * executor has no `read` method.
 *
 * @param safeAddresses - A Map built exclusively from own-enumerable entries of
 *   deployedAddresses (see applyConfig). Using a Map rather than the raw
 *   Record prevents prototype-key mis-resolution.
 * @param executor - The injected ConfigExecutor; only needed for its optional
 *   `read` method (invoked for any `read` arg encountered in the step).
 */
async function buildConfigCall(
  step: ConfigStep,
  safeAddresses: Map<string, string>,
  executor: ConfigExecutor,
): Promise<ConfigCall> {
  const stepLabel = `step "${step.id}" (${step.kind})`;

  switch (step.kind) {
    case "setX": {
      const target = resolveContractId(step.target, safeAddresses, stepLabel);
      const args: ResolvedArg[] = await Promise.all(
        (step.args ?? []).map((arg, i) =>
          resolveArg(arg, safeAddresses, `${stepLabel} args[${i}]`, executor),
        ),
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
      const accountAddress = await resolveArg(
        step.account,
        safeAddresses,
        `${stepLabel} account`,
        executor,
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
 * @throws ConfigExecError with code "READ_UNSUPPORTED" if a step's args
 *   contain a `read` arg and the injected executor has no `read` method.
 * @throws ConfigExecError with code "JOURNAL_ERROR" if the journal file
 *   exists but cannot be read.
 * @throws any error thrown by executor.execute() or executor.read() — NOT
 *   wrapped.
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
   * Execute a single step: skip if already journaled, otherwise resolve refs
   * (including any `read` args, via executor.read()), call executor, and
   * journal on success. Mutates `executedStepIds`, `skippedStepIds`, and
   * `alreadyCompleted` in place.
   *
   * IMPORTANT: the already-journaled check happens BEFORE `buildConfigCall`
   * is called, so a skipped (already-complete) step's `read` args are NEVER
   * resolved and `executor.read()` is NEVER invoked for it — resuming a
   * partially-applied spec performs no reads for the steps it skips.
   */
  async function executeStep(step: ConfigStep): Promise<void> {
    if (alreadyCompleted.has(step.id)) {
      // Already journaled from a previous run — skip. No ref/read resolution
      // and no executor call of any kind happens for a skipped step.
      skippedStepIds.push(step.id);
      return;
    }

    // Resolve refs (and any `read` args, via executor.read()) and build the
    // ConfigCall. UNKNOWN_REF here is defensive (INVALID_SPEC above should
    // catch missing refs), but we keep it for correctness when
    // deployedAddresses diverges, and to guard against prototype-key refs
    // that bypassed validation. READ_UNSUPPORTED is thrown here if the step
    // has a `read` arg but the executor has no `read` method.
    const call = await buildConfigCall(step, safeAddresses, executor);

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

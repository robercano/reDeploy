/**
 * Dry-run / plan-only deployment simulation for @redeploy/core.
 *
 * DESIGN
 * ======
 *
 * simulate() is the plan-only counterpart to deploy(). It validates the spec
 * and resolves the topological creation order WITHOUT touching any chain,
 * provider, journal, or filesystem. No transactions are broadcast; no addresses
 * are assigned.
 *
 * Pipeline:
 *   1. validateSpec(spec)    — structural + cross-field validation
 *   2. buildCreationOrder()  — Kahn's BFS topo-sort (reused from compile.ts)
 *   3. Map ordered entries → PlannedStep[]
 *
 * This deliberately does NOT call compileSpec() / Ignition's buildModule()
 * because those construct a live IgnitionModule with ContractFuture objects,
 * which is unnecessary overhead for a plan-only view. buildCreationOrder() is
 * the compile pipeline's topo-sort step and can throw CompileError on internal
 * invariant violations — simulate() catches those and returns ok:false.
 *
 * The result is a discriminated union:
 *   { ok: true,  steps: PlannedStep[] }
 *   { ok: false, errors: SimulateError[] }
 *
 * where SimulateError wraps either a SpecError (from validateSpec) or a
 * CompileError message (from buildCreationOrder) under a single type.
 */

import type { DeploymentSpec, ContractArg } from "../spec/types.js";
import { validateSpec } from "../spec/validate.js";
import type { SpecError } from "../spec/validate.js";
import { buildCreationOrder } from "../compile/compile.js";
import { CompileError } from "../compile/errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stable error codes for SimulateError.
 *
 * - `"INVALID_SPEC"`  — the spec failed validateSpec() (structural or cross-field).
 * - `"COMPILE_ERROR"` — buildCreationOrder() threw an internal CompileError.
 */
export type SimulateErrorCode = "INVALID_SPEC" | "COMPILE_ERROR";

/**
 * A single error returned by simulate() on failure.
 *
 * On an INVALID_SPEC failure the array mirrors SpecError[] from validateSpec().
 * On a COMPILE_ERROR failure there is exactly one entry with the compiler message.
 */
export interface SimulateError {
  /** Stable code for programmatic handling. */
  readonly code: SimulateErrorCode;
  /**
   * JSON-pointer-ish path to the offending node.
   * Empty string when the error is not tied to a specific location.
   */
  readonly path: string;
  /** Human-readable description. */
  readonly message: string;
}

/**
 * A single planned deployment step — one contract to be deployed, in execution
 * order determined by the topological sort.
 *
 * NO addresses are assigned (nothing is deployed). This is purely a plan.
 */
export interface PlannedStep {
  /** The unique deployment id from the spec (ContractEntry.id). */
  readonly id: string;
  /**
   * The Solidity artifact / contract name (ContractEntry.contract).
   * The same artifact may appear in multiple steps under different ids.
   */
  readonly contract: string;
  /**
   * Constructor arguments as declared in the spec (ContractEntry.args).
   * RefArg values are still { kind: "ref", contract: "<id>" } — no address
   * substitution is performed because nothing is deployed.
   * Undefined when the spec entry has no args.
   */
  readonly args?: ContractArg[];
  /**
   * Explicit after-constraints as declared in the spec (ContractEntry.after).
   * Lists the ids that this step must be deployed after.
   * Undefined when the spec entry has no after constraints.
   */
  readonly after?: string[];
  /**
   * Combined set of dependency ids for this step: the union of all ref-arg
   * targets and all after-constraint ids. This mirrors the set of ids that
   * Ignition would receive as dependency edges when building the module.
   *
   * Listed in the order they appear in the spec (refs first, then after).
   */
  readonly dependsOn: string[];
}

/**
 * The result of simulate().
 *
 *   { ok: true,  steps: PlannedStep[] }  — valid spec, steps in execution order
 *   { ok: false, errors: SimulateError[] } — validation or compile failure
 */
export type SimulateResult =
  | { readonly ok: true; readonly steps: PlannedStep[] }
  | { readonly ok: false; readonly errors: SimulateError[] };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dry-run a DeploymentSpec: validate it and resolve the ordered deployment
 * plan WITHOUT touching any chain, provider, journal, or filesystem.
 *
 * Returns a discriminated union — never throws for expected failure modes
 * (validation failures, compile errors). Only truly unexpected runtime errors
 * (e.g. out-of-memory) can escape as thrown exceptions.
 *
 * On success (`ok: true`):
 *   - `steps` lists the planned contract deployments in topological execution
 *     order — each dependency appears before the entries that depend on it.
 *   - Each step includes `dependsOn` (the resolved dependency ids), `args` and
 *     `after` as declared in the spec.
 *   - NO addresses are assigned (nothing is deployed).
 *
 * On failure (`ok: false`):
 *   - `errors` contains all collected errors (multiple errors on INVALID_SPEC,
 *     exactly one on COMPILE_ERROR).
 *
 * @param spec  Any value — treated as untrusted input and validated via validateSpec.
 */
export function simulate(spec: unknown): SimulateResult {
  // --- 1. Validate spec -------------------------------------------------------
  const validateResult = validateSpec(spec);
  if (!validateResult.ok) {
    const errors: SimulateError[] = validateResult.errors.map(
      (e: SpecError) => ({
        code: "INVALID_SPEC" as const,
        path: e.path,
        message: e.message,
      }),
    );
    return { ok: false, errors };
  }

  const validSpec: DeploymentSpec = validateResult.spec;

  // --- 2. Resolve topological creation order ----------------------------------
  // buildCreationOrder() uses the same Kahn's BFS topo-sort as compileSpec()
  // and can throw CompileError(INTERNAL_INVARIANT) if an invariant is violated.
  // This should never happen for a spec that passed validateSpec(), but we
  // catch it defensively to keep simulate()'s never-throws contract.
  let orderedEntries: ReturnType<typeof buildCreationOrder>;
  try {
    orderedEntries = buildCreationOrder(validSpec.contracts);
  } catch (err) {
    const msg = err instanceof CompileError ? err.message : String(err);
    return {
      ok: false,
      errors: [
        {
          code: "COMPILE_ERROR",
          path: err instanceof CompileError && err.path != null ? err.path : "",
          message: msg,
        },
      ],
    };
  }

  // --- 3. Map ordered entries → PlannedStep[] --------------------------------
  const steps: PlannedStep[] = orderedEntries.map((entry) => {
    // Build the deduplicated dependsOn list: ref-arg targets first, then
    // after-constraint ids. Use a Set to deduplicate (an id could appear in
    // both refs and after).
    const seenDeps = new Set<string>();
    const dependsOn: string[] = [];

    for (const arg of entry.args ?? []) {
      if (arg.kind === "ref" && !seenDeps.has(arg.contract)) {
        seenDeps.add(arg.contract);
        dependsOn.push(arg.contract);
      }
    }
    for (const afterId of entry.after ?? []) {
      if (!seenDeps.has(afterId)) {
        seenDeps.add(afterId);
        dependsOn.push(afterId);
      }
    }

    return {
      id: entry.id,
      contract: entry.contract,
      ...(entry.args !== undefined ? { args: entry.args } : {}),
      ...(entry.after !== undefined ? { after: entry.after } : {}),
      dependsOn,
    };
  });

  return { ok: true, steps };
}

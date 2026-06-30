/**
 * Validation entry point for the declarative post-deployment configuration spec.
 *
 * Validation is two-phase:
 *   1. Zod schema parse — structural shape, required fields, discriminated union.
 *   2. Cross-field rules — duplicate step ids, missing refs (target/source/into/
 *      account-ref must resolve to a known deployed contract id when a deployment
 *      is provided).
 *
 * All errors are COLLECTED and returned together (never fail-fast). The function
 * never throws on untrusted input (the zod parse is wrapped in try/catch to
 * guard against stack overflows on pathological inputs).
 *
 * Ordered vs. unordered steps:
 *   Both `steps` (unordered) and `orderedSteps` (globally ordered) are validated
 *   identically in terms of shape and ref resolution. They share the same step-id
 *   namespace — a duplicate id that appears in `steps`, in `orderedSteps`, or
 *   across both lists is rejected with a DUPLICATE_STEP_ID error. Cross-field
 *   errors report paths as `steps[N]...` or `orderedSteps[N]...` respectively.
 *
 * Ref resolution against a deployment:
 *   When a second argument (`deployment`) is passed, every ref-like field in
 *   the spec (step `target`, `source`, `into`, and any `account` or `args`
 *   entry of kind `"ref"` or `"addressRef"`) is checked against the set of known
 *   deployed contract ids. Unknown refs produce a MISSING_REF error.
 *
 *   Acceptable forms for `deployment`:
 *     - A `DeploymentSpec` (imported from @redeploy/core) — ids are extracted
 *       from its `contracts[].id` array.
 *     - A `ReadonlySet<string>` of deployed ids.
 *     - A `readonly string[]` of deployed ids (converted to a Set internally).
 *
 *   When `deployment` is omitted (or `undefined`), ref-resolution checks are
 *   skipped entirely; shape-only validation still applies.
 */

import type { DeploymentSpec } from "@redeploy/core";
import type { ConfigSpec, ConfigStep, ConfigArg } from "./types.js";
import { configSpecSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// ConfigError — structured validation error
// ---------------------------------------------------------------------------

/** Stable string codes for every config validation failure mode. */
export type ConfigErrorCode =
  | "INVALID_SHAPE"
  | "DUPLICATE_STEP_ID"
  | "MISSING_REF"
  | "SELF_REFERENCE";

/**
 * A single structured config validation error.
 *
 * - `path`    — JSON-pointer-ish location string (e.g. `steps[2].args[0].contract`).
 * - `code`    — Stable enum value for programmatic handling.
 * - `message` — Human-readable description.
 */
export interface ConfigError {
  readonly path: string;
  readonly code: ConfigErrorCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ConfigResult =
  | { readonly ok: true; readonly spec: ConfigSpec }
  | { readonly ok: false; readonly errors: ConfigError[] };

// ---------------------------------------------------------------------------
// Deployment input type
// ---------------------------------------------------------------------------

/**
 * Accepted forms for the deployment knowledge passed to `validateConfig`.
 *
 * - `DeploymentSpec` — the full deployment spec; ids extracted from `contracts[].id`.
 * - `ReadonlySet<string>` — a pre-built set of deployed contract ids.
 * - `readonly string[]` — a list of deployed contract ids.
 *
 * When omitted (`undefined`), ref-resolution checks are skipped.
 */
export type DeploymentInput = DeploymentSpec | ReadonlySet<string> | readonly string[];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a zod issue path array to a human-readable JSON-pointer-ish string.
 * e.g. ["steps", 2, "args", 0, "kind"] → "steps[2].args[0].kind"
 */
function zodPathToString(path: (string | number)[]): string {
  return path
    .map((seg, i) =>
      typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`,
    )
    .join("");
}

/**
 * Normalise a `DeploymentInput` to a `ReadonlySet<string>` of ids.
 * Uses only safe prototype-pollution-resistant operations.
 */
function toDeployedIdSet(deployment: DeploymentInput): ReadonlySet<string> {
  if (deployment instanceof Set) {
    return deployment;
  }
  if (Array.isArray(deployment)) {
    return new Set(deployment as string[]);
  }
  // DeploymentSpec — extract ids from contracts array
  const spec = deployment as DeploymentSpec;
  return new Set(spec.contracts.map((c) => c.id));
}

/**
 * Collect all ref strings from a ConfigArg (returns the contract id if the arg
 * is a ref, or nothing if it is a literal).
 */
function refFromArg(arg: ConfigArg): string | undefined {
  return arg.kind === "ref" ? arg.contract : undefined;
}

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

function collectCrossFieldErrors(
  spec: ConfigSpec,
  deployedIds: ReadonlySet<string> | undefined,
): ConfigError[] {
  const errors: ConfigError[] = [];

  const orderedSteps = spec.orderedSteps ?? [];

  // --- 1. Duplicate step ids ------------------------------------------------
  // Both `steps` and `orderedSteps` share the same id namespace. We track
  // the first occurrence with a path label so the error message is precise.
  //
  // Entry format: id → { index, listLabel } where listLabel is the path prefix
  // ("steps" or "orderedSteps") to use in the error path.
  const seenIds = new Map<string, { index: number; listLabel: string }>();

  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i];
    if (seenIds.has(step.id)) {
      const first = seenIds.get(step.id)!;
      errors.push({
        path: `steps[${i}].id`,
        code: "DUPLICATE_STEP_ID",
        message: `Duplicate step id "${step.id}" (first seen at ${first.listLabel}[${first.index}])`,
      });
    } else {
      seenIds.set(step.id, { index: i, listLabel: "steps" });
    }
  }

  for (let i = 0; i < orderedSteps.length; i++) {
    const step = orderedSteps[i];
    if (seenIds.has(step.id)) {
      const first = seenIds.get(step.id)!;
      errors.push({
        path: `orderedSteps[${i}].id`,
        code: "DUPLICATE_STEP_ID",
        message: `Duplicate step id "${step.id}" (first seen at ${first.listLabel}[${first.index}])`,
      });
    } else {
      seenIds.set(step.id, { index: i, listLabel: "orderedSteps" });
    }
  }

  // --- 2. Ref resolution (only when a deployment was provided) --------------
  if (deployedIds === undefined) {
    return errors;
  }

  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i] as ConfigStep;
    const basePath = `steps[${i}]`;
    collectStepRefErrors(step, i, basePath, deployedIds, errors);
  }

  for (let i = 0; i < orderedSteps.length; i++) {
    const step = orderedSteps[i] as ConfigStep;
    const basePath = `orderedSteps[${i}]`;
    collectStepRefErrors(step, i, basePath, deployedIds, errors);
  }

  return errors;
}

/**
 * Emit MISSING_REF / SELF_REFERENCE errors for a single step.
 * Mutates `errors` in place.
 */
function collectStepRefErrors(
  step: ConfigStep,
  _stepIndex: number,
  basePath: string,
  deployedIds: ReadonlySet<string>,
  errors: ConfigError[],
): void {
  /**
   * Helper: check a single string ref field.
   */
  function checkRef(ref: string, path: string, label: string): void {
    if (!deployedIds.has(ref)) {
      errors.push({
        path,
        code: "MISSING_REF",
        message: `${label} references unknown deployed id "${ref}"`,
      });
    }
  }

  /**
   * Helper: check a single ConfigArg if it is a ref.
   */
  function checkArgRef(arg: ConfigArg, path: string, label: string): void {
    const ref = refFromArg(arg);
    if (ref !== undefined) {
      checkRef(ref, path, label);
    }
  }

  switch (step.kind) {
    case "setX": {
      checkRef(step.target, `${basePath}.target`, `setX step "${step.id}" target`);
      if (step.args) {
        for (let j = 0; j < step.args.length; j++) {
          checkArgRef(
            step.args[j],
            `${basePath}.args[${j}].contract`,
            `setX step "${step.id}" args[${j}]`,
          );
        }
      }
      break;
    }

    case "grantRole": {
      checkRef(step.target, `${basePath}.target`, `grantRole step "${step.id}" target`);
      checkArgRef(
        step.account,
        `${basePath}.account.contract`,
        `grantRole step "${step.id}" account`,
      );
      break;
    }

    case "wire": {
      checkRef(step.source, `${basePath}.source`, `wire step "${step.id}" source`);
      checkRef(step.into, `${basePath}.into`, `wire step "${step.id}" into`);
      // Self-reference: wiring a contract into itself via the same id is a
      // logical error — the source and into are the same deployed id.
      if (step.source === step.into) {
        errors.push({
          path: `${basePath}.into`,
          code: "SELF_REFERENCE",
          message: `wire step "${step.id}" has source and into pointing to the same deployed id "${step.source}"`,
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value against the config spec.
 *
 * Returns `{ ok: true, spec }` on success or `{ ok: false, errors }` with ALL
 * collected errors on failure. Never throws.
 *
 * @param input      - Untrusted input (e.g. parsed JSON).
 * @param deployment - Optional deployment knowledge for ref resolution.
 *                     When omitted, ref-resolution checks are skipped and only
 *                     structural shape validation is applied. Accepted forms:
 *                       - `DeploymentSpec` from @redeploy/core
 *                       - `ReadonlySet<string>` of deployed contract ids
 *                       - `readonly string[]` of deployed contract ids
 *
 * Input is treated as untrusted `unknown` — prototype-pollution via crafted
 * keys (`__proto__`, `constructor`, etc.) is not a concern because:
 *   - Zod parses with its own structural traversal (not JSON.parse assignment).
 *   - Cross-field logic uses Map/Set with explicit `.has()` guards, never
 *     indexing plain objects with attacker-controlled keys.
 */
export function validateConfig(
  input: unknown,
  deployment?: DeploymentInput,
): ConfigResult {
  // --- Phase 1: Zod shape validation ----------------------------------------
  // Wrapped in try/catch for the same reason as core: zod's recursive descent
  // can throw a V8 RangeError on pathological inputs. The depth guard in
  // schema.ts prevents most cases; this is the last-resort safety net.
  let parseResult: ReturnType<typeof configSpecSchema.safeParse>;
  try {
    parseResult = configSpecSchema.safeParse(input);
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "",
          code: "INVALID_SHAPE",
          message: "config spec could not be parsed (too deeply nested or malformed)",
        },
      ],
    };
  }

  if (!parseResult.success) {
    const errors: ConfigError[] = parseResult.error.issues.map((issue) => ({
      path: zodPathToString(issue.path as (string | number)[]),
      code: "INVALID_SHAPE" as ConfigErrorCode,
      message: issue.message,
    }));
    return { ok: false, errors };
  }

  const spec = parseResult.data;

  // --- Phase 2: Cross-field validation --------------------------------------
  const deployedIds =
    deployment !== undefined ? toDeployedIdSet(deployment) : undefined;

  const crossErrors = collectCrossFieldErrors(spec, deployedIds);

  if (crossErrors.length > 0) {
    return { ok: false, errors: crossErrors };
  }

  return { ok: true, spec };
}

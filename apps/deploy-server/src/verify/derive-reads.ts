/**
 * Heuristic getter-mapping derivation for config-drift checking.
 *
 * `@redeploy/verify`'s `verifyConfig()` requires a caller-supplied
 * `ReadDescriptor` (getter function name + expected value) for every `setX`
 * and `wire` step — it has no way to know which view function reads back a
 * given setter's state, and throws `ConfigVerifyError("MISSING_GETTER_MAPPING")`
 * when one is missing. The studio's ConfigSpec carries no such mapping today,
 * so this module derives one using a naming convention (`setFoo` -> `getFoo`)
 * wherever it safely can, and reports everything else as "skipped" rather
 * than ever letting the endpoint 500 (see the deploy-server ticket's
 * "graceful handling" requirement).
 *
 * Convention:
 *   - setX:  function "setFoo" (or "setFoo(uint256)") with EXACTLY ONE arg
 *            -> reads[id] = { function: "getFoo", expected: <that arg> }
 *            Steps with zero or >1 args are skipped — we cannot guess which
 *            getter return value corresponds to which arg.
 *   - wire:  function "setFoo" (or "setFoo(address)") on the `into` contract
 *            -> reads[id] = { function: "getFoo" }  (verifyConfig derives
 *            `expected` itself from the wire step's `source` address).
 *   - grantRole: never needs a read descriptor (verifyConfig always uses
 *            `hasRole`) — always included, untouched.
 *
 * Functions that don't match the `set<Name>` convention (free-text setter
 * names, e.g. "updateFee") cannot be derived and are reported as "skipped".
 */

import type { ConfigStep, ConfigArg } from "@redeploy/config";
import type { ReadDescriptor } from "@redeploy/verify";

/** A step id skipped from drift checking, with a human-readable reason. */
export interface SkippedStep {
  readonly id: string;
  readonly reason: string;
}

/** Result of deriving read descriptors for a list of ConfigSteps. */
export interface DerivedReads {
  /** Steps safe to hand to verifyConfig() (grantRole always; derivable setX/wire). */
  readonly includable: ConfigStep[];
  /** Read descriptors for the includable setX/wire steps, keyed by step id. */
  readonly reads: Record<string, ReadDescriptor>;
  /** Steps that could not be derived — never passed to verifyConfig(). */
  readonly skipped: SkippedStep[];
}

/** Strip a canonical signature's parameter list, e.g. "setFee(uint256)" -> "setFee". */
function bareFunctionName(fn: string): string {
  const idx = fn.indexOf("(");
  return idx === -1 ? fn : fn.slice(0, idx);
}

/** "setFee" -> "getFee"; anything not matching `set<Capitalized...>` -> null. */
function deriveGetterName(setterBareName: string): string | null {
  const match = /^set([A-Z_].*)$/.exec(setterBareName);
  if (!match) return null;
  return `get${match[1]}`;
}

/**
 * Derive read descriptors for every ConfigStep in `steps`, splitting them
 * into steps safe to verify (`includable` + `reads`) and steps that must be
 * reported as "skipped" (no derivable getter mapping).
 */
export function deriveReads(steps: ConfigStep[]): DerivedReads {
  const includable: ConfigStep[] = [];
  const reads: Record<string, ReadDescriptor> = {};
  const skipped: SkippedStep[] = [];

  for (const step of steps) {
    if (step.kind === "grantRole") {
      includable.push(step);
      continue;
    }

    if (step.kind === "setX") {
      const bare = bareFunctionName(step.function);
      const getter = deriveGetterName(bare);
      const args = step.args ?? [];
      if (getter === null) {
        skipped.push({
          id: step.id,
          reason: `cannot derive a getter for setter "${bare}" (expected a "set<Name>" naming convention)`,
        });
        continue;
      }
      if (args.length !== 1) {
        skipped.push({
          id: step.id,
          reason: `cannot derive an expected value for setter "${bare}" with ${args.length} argument(s) (only single-argument setters are supported)`,
        });
        continue;
      }
      const expected: ConfigArg = args[0]!;
      reads[step.id] = { function: getter, expected };
      includable.push(step);
      continue;
    }

    // wire
    const bare = bareFunctionName(step.function);
    const getter = deriveGetterName(bare);
    if (getter === null) {
      skipped.push({
        id: step.id,
        reason: `cannot derive a getter for wire setter "${bare}" (expected a "set<Name>" naming convention)`,
      });
      continue;
    }
    reads[step.id] = { function: getter };
    includable.push(step);
  }

  return { includable, reads, skipped };
}

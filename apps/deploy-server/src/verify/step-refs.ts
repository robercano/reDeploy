/**
 * Ref-resolvability helpers for config-drift checking.
 *
 * Before handing a ConfigStep to `@redeploy/verify`'s `verifyConfig()`, the
 * caller must know every deployment id the step references (target, source,
 * into, and any `{kind:"ref"}` args) resolves to a REAL deployed address.
 * `verifyConfig()` itself throws `ConfigVerifyError("UNKNOWN_REF")` — a setup
 * error — when it doesn't; pre-checking here lets the drift endpoint turn an
 * unresolvable step into a per-step "error" result instead of aborting the
 * whole batch (see run-config-drift.ts).
 */

import type { ConfigStep } from "@redeploy/config";

/**
 * Collect every deployment id a ConfigStep needs resolved to an address:
 *   - setX:      target, plus any `{kind:"ref"}` arg
 *   - grantRole: target, plus `account` when it is a `{kind:"ref"}` arg
 *   - wire:      source, into
 */
export function collectRequiredIds(step: ConfigStep): string[] {
  if (step.kind === "setX") {
    const ids = [step.target];
    for (const arg of step.args ?? []) {
      if (arg.kind === "ref") ids.push(arg.contract);
    }
    return ids;
  }
  if (step.kind === "grantRole") {
    const ids = [step.target];
    if (step.account.kind === "ref") ids.push(step.account.contract);
    return ids;
  }
  // wire
  return [step.source, step.into];
}

/**
 * Return the first referenced deployment id that is NOT a key in
 * `deployedAddresses`, or `null` when every reference resolves.
 */
export function findUnresolvedRef(
  step: ConfigStep,
  deployedAddresses: Readonly<Record<string, string>>,
): string | null {
  for (const id of collectRequiredIds(step)) {
    if (deployedAddresses[id] === undefined) return id;
  }
  return null;
}

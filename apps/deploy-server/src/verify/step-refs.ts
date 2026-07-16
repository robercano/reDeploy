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
 *
 * INPUT TRUST: `step` ultimately originates from the client-supplied HTTP
 * request body, which is only shape-validated at the top level
 * (`validateConfigSpecShape`) before being cast to `ConfigStep`. Individual
 * step fields (target/source/into/account/args) are NOT schema-validated, so
 * at runtime they may be missing, `null`, or the wrong type despite the
 * `ConfigStep` compile-time type — e.g. a `null` entry in `args`, or a wire
 * step with no `function` chosen yet in the studio. Every helper below
 * treats step fields as untrusted (`unknown`) and degrades gracefully
 * instead of throwing.
 */

import type { ConfigStep } from "@redeploy/config";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** True iff `value` looks like a `{kind:"ref", contract:"<id>"}` RefArg. */
function isRefArg(value: unknown): value is { kind: "ref"; contract: string } {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v["kind"] === "ref" && typeof v["contract"] === "string";
}

/**
 * Collect every deployment id a ConfigStep needs resolved to an address:
 *   - setX:      target, plus any `{kind:"ref"}` arg
 *   - grantRole: target, plus `account` when it is a `{kind:"ref"}` arg
 *   - wire:      source, into
 *
 * Malformed/missing fields (see the module doc's INPUT TRUST note) are
 * simply omitted from the returned list rather than causing a throw.
 */
export function collectRequiredIds(step: ConfigStep): string[] {
  // `step` is treated as untrusted at runtime — see INPUT TRUST above.
  const s = step as unknown as Record<string, unknown>;

  if (step.kind === "setX") {
    const ids: string[] = [];
    const target = asString(s["target"]);
    if (target !== null) ids.push(target);
    const args = Array.isArray(s["args"]) ? s["args"] : [];
    for (const arg of args) {
      if (isRefArg(arg)) ids.push(arg.contract);
    }
    return ids;
  }
  if (step.kind === "grantRole") {
    const ids: string[] = [];
    const target = asString(s["target"]);
    if (target !== null) ids.push(target);
    if (isRefArg(s["account"])) ids.push((s["account"] as { contract: string }).contract);
    return ids;
  }
  // wire
  const ids: string[] = [];
  const source = asString(s["source"]);
  if (source !== null) ids.push(source);
  const into = asString(s["into"]);
  if (into !== null) ids.push(into);
  return ids;
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

/**
 * narrow-config.ts
 *
 * Narrows a full `ConfigSpec` down to a single step, for the config-drift
 * one-click re-apply flow (issue #153).
 *
 * ## Why this exists (issue #153 review, finding B1)
 *
 * `App.tsx`'s "Re-apply" confirm modal claims that clicking it will broadcast
 * a real transaction for ONE named step and that "All other steps are
 * unaffected". Before this fix, `handleApplyConfig` POSTed the studio's
 * ENTIRE current `config` (every step on the canvas) to `/api/apply-config`
 * with only `forceStepIds` narrowed to the single target step. The server
 * forwards the whole POST body as `spec` to `applyConfig()`
 * (`apps/deploy-server/src/server.ts`), and `applyConfig()` executes EVERY
 * step in that spec that is not already journaled — `forceStepIds` only
 * controls which ALREADY-journaled steps are forced to re-run; it does
 * nothing to steps that were never journaled in the first place. So clicking
 * "Re-apply" on one drifted step could ALSO broadcast real transactions for
 * every not-yet-applied step still on the canvas — directly contradicting the
 * modal's promise, on an irreversible, gas-spending path.
 *
 * The fix: when re-applying a single step, narrow the POSTed spec itself down
 * to just that one step, so the server-side `applyConfig()` has no other step
 * to execute even before `forceStepIds` is considered — the modal's "1 step,
 * nothing else" claim becomes structurally true, not just a UI label.
 *
 * ## Why this is safe
 *
 * `validateConfig` (`packages/config/src/steps/validate.ts`) resolves every
 * ref (`target`/`source`/`into`/`account`/args of kind `ref` or `read`) ONLY
 * against the deployment's known deployed contract ids (`deployedAddresses`
 * on the server) — never against sibling steps in the spec. Dropping every
 * other step from the spec therefore cannot break the forced step's own ref
 * resolution; the deployed contracts it references are still deployed and
 * still resolvable regardless of which other config steps happen to be
 * present in the same POST body.
 */

import type { ConfigSpec } from "@redeploy/config/steps";

/**
 * Return a new `ConfigSpec` containing ONLY the step whose `id` matches
 * `stepId`, preserving every other top-level field (`version`) unchanged.
 *
 * The matching step is kept in whichever list it was found in (`steps` vs
 * `orderedSteps`) — the other list is filtered to empty rather than dropped,
 * so the returned spec always has the same shape (`{ version, steps,
 * orderedSteps }`) as the input, just narrowed.
 *
 * If no step in either list has the given id, the returned spec has both
 * lists empty — `applyConfig()` will then execute nothing, which is the
 * safe/inert outcome for a stale/unknown step id (mirrors how a forced id
 * that matches no step is silently ignored server-side, see
 * `packages/config/src/execute/execute.ts`'s FORCING RE-EXECUTION section).
 */
export function narrowConfigToStep(spec: ConfigSpec, stepId: string): ConfigSpec {
  return {
    ...spec,
    steps: spec.steps.filter((s) => s.id === stepId),
    orderedSteps: spec.orderedSteps?.filter((s) => s.id === stepId),
  };
}

/**
 * narrow-config.test.ts
 *
 * Unit tests for narrowConfigToStep (issue #153 review, finding B1) — pins
 * the guarantee that narrowing a spec to a single step id yields a spec that
 * can execute AT MOST that one step, regardless of which list (`steps` vs
 * `orderedSteps`) it originated in.
 */

import { describe, it, expect } from "vitest";
import { narrowConfigToStep } from "../src/spec/narrow-config.js";
import type { ConfigSpec } from "@redeploy/config/steps";

const SPEC: ConfigSpec = {
  version: 1,
  steps: [
    { kind: "setX", id: "set-fee", target: "token", function: "setFee", args: [{ kind: "literal", value: 500 }] },
    { kind: "grantRole", id: "grant-minter", target: "vault", role: "MINTER_ROLE", account: { kind: "ref", contract: "minter" } },
  ],
  orderedSteps: [
    { kind: "wire", id: "wire-token-into-vault", source: "token", into: "vault", function: "setToken" },
  ],
};

describe("narrowConfigToStep", () => {
  it("keeps only the matching step from `steps`, empties `orderedSteps`", () => {
    const narrowed = narrowConfigToStep(SPEC, "set-fee");
    expect(narrowed.steps).toEqual([SPEC.steps[0]]);
    expect(narrowed.orderedSteps).toEqual([]);
    expect(narrowed.version).toBe(1);
  });

  it("keeps only the matching step from `orderedSteps`, empties `steps`", () => {
    const narrowed = narrowConfigToStep(SPEC, "wire-token-into-vault");
    expect(narrowed.steps).toEqual([]);
    expect(narrowed.orderedSteps).toEqual([SPEC.orderedSteps![0]]);
  });

  it("an unknown step id narrows to a spec with both lists empty (safe/inert, not an error)", () => {
    const narrowed = narrowConfigToStep(SPEC, "does-not-exist");
    expect(narrowed.steps).toEqual([]);
    expect(narrowed.orderedSteps).toEqual([]);
  });

  it("does not mutate the input spec", () => {
    const before = JSON.parse(JSON.stringify(SPEC)) as ConfigSpec;
    narrowConfigToStep(SPEC, "set-fee");
    expect(SPEC).toEqual(before);
  });

  it("a spec with no orderedSteps field narrows to orderedSteps: undefined (not [])", () => {
    const specWithoutOrdered: ConfigSpec = { version: 1, steps: SPEC.steps };
    const narrowed = narrowConfigToStep(specWithoutOrdered, "set-fee");
    expect(narrowed.orderedSteps).toBeUndefined();
    expect(narrowed.steps).toEqual([SPEC.steps[0]]);
  });

  it("narrowing to a single step id never includes any other step's id in the result", () => {
    const narrowed = narrowConfigToStep(SPEC, "grant-minter");
    const allIds = [...narrowed.steps, ...(narrowed.orderedSteps ?? [])].map((s) => s.id);
    expect(allIds).toEqual(["grant-minter"]);
  });

  // Issue #153 review (TESTS lens, nit): the same step id present in BOTH
  // `steps` AND `orderedSteps` is an already-invalid spec (packages/config's
  // `validateConfig` rejects any id duplicated across the two lists with a
  // `DUPLICATE_STEP_ID` -> `INVALID_SPEC` error before any step ever
  // executes — see packages/config/src/steps/validate.ts). narrowConfigToStep
  // itself does not de-duplicate: it independently filters each list by id,
  // so a duplicate id is kept in BOTH lists. Pinning that here so a future
  // change to the filtering logic can't silently start dropping one of the
  // duplicates (which would just as silently mask an otherwise-caught
  // INVALID_SPEC).
  it("a step id present in BOTH `steps` and `orderedSteps` is kept in both (narrowConfigToStep does not de-duplicate; the resulting spec is later rejected as DUPLICATE_STEP_ID by validateConfig, not silently collapsed here)", () => {
    const duplicateIdSpec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "dup",
          target: "token",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
      orderedSteps: [{ kind: "wire", id: "dup", source: "token", into: "vault", function: "setToken" }],
    };

    const narrowed = narrowConfigToStep(duplicateIdSpec, "dup");
    expect(narrowed.steps).toEqual([duplicateIdSpec.steps[0]]);
    expect(narrowed.orderedSteps).toEqual([duplicateIdSpec.orderedSteps![0]]);
  });
});

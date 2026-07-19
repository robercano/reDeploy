/**
 * manifest-dedup.test.ts
 *
 * Issue #147 tests-lens finding #5 ("dedup honesty"): manifest.test.ts's
 * "returned functions have no duplicate signatures" tests for
 * getStateChangingFunctions/getViewFunctions only run against the REAL
 * generated manifest (contracts.generated.json), whose entries are already
 * deduped upstream by deriveManifest's own most-derived-wins `seenSignatures`
 * pass (src/manifest/derive.ts). No project fixture has two functions in the
 * SAME contract's final `.functions` array sharing a signature, so those
 * tests never actually exercise getStateChangingFunctions/getViewFunctions's
 * own `if (seen.has(fn.signature)) continue;` dedup line — they pass
 * trivially regardless of whether that line exists.
 *
 * This file mocks contracts.generated.json with a synthetic contract whose
 * `functions` array contains a genuine duplicate signature (something that
 * can never come out of deriveManifests, but IS a legal ContractManifest
 * shape per the type, and is exactly the shape getStateChangingFunctions/
 * getViewFunctions must defend against), and asserts the collision is
 * actually skipped and the FIRST occurrence wins.
 */

import { describe, it, expect, vi } from "vitest";
import type { ContractManifest } from "../src/manifest/types.js";

const DUP_FIXTURE: ContractManifest[] = [
  {
    name: "DupFixture",
    sourcePath: "src/DupFixture.sol",
    packageSegments: ["src"],
    constructorArgs: [],
    inheritance: ["DupFixture", "Base"],
    functions: [
      // Two entries sharing "foo()" — a genuine duplicate VIEW signature.
      { name: "foo", signature: "foo()", declaredIn: "Base", inputs: [], stateMutability: "view" },
      { name: "foo", signature: "foo()", declaredIn: "DupFixture", inputs: [], stateMutability: "view" },
      // Two entries sharing "bar()" — a genuine duplicate STATE-CHANGING signature.
      { name: "bar", signature: "bar()", declaredIn: "DupFixture", inputs: [], stateMutability: "nonpayable" },
      { name: "bar", signature: "bar()", declaredIn: "Base", inputs: [], stateMutability: "nonpayable" },
    ],
  },
];

vi.mock("../src/manifest/contracts.generated.json", () => ({
  default: DUP_FIXTURE,
}));

const { getViewFunctions, getStateChangingFunctions } = await import("../src/manifest/index.js");

describe("getViewFunctions / getStateChangingFunctions — genuine duplicate-signature collision (issue #147 finding #5)", () => {
  it("getViewFunctions collapses a genuine duplicate view-function signature to ONE entry, keeping the first occurrence", () => {
    const fns = getViewFunctions("DupFixture");
    expect(fns).toHaveLength(1);
    expect(fns[0]).toEqual({ name: "foo", signature: "foo()", declaredIn: "Base", inputs: [], stateMutability: "view" });
  });

  it("getStateChangingFunctions collapses a genuine duplicate state-changing-function signature to ONE entry, keeping the first occurrence", () => {
    const fns = getStateChangingFunctions("DupFixture");
    expect(fns).toHaveLength(1);
    expect(fns[0]).toEqual({
      name: "bar",
      signature: "bar()",
      declaredIn: "DupFixture",
      inputs: [],
      stateMutability: "nonpayable",
    });
  });
});

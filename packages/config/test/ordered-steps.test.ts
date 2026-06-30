/**
 * Tests for the ordered-steps feature in @redeploy/config.
 *
 * Covers:
 *  - ConfigSpec.orderedSteps schema parsing (valid and invalid shapes)
 *  - Ordered steps execute in strict array order AFTER unordered steps
 *  - Ordered steps resume correctly (journal persists completion)
 *  - Ordered steps interleave correctly with unordered steps in the journal
 *  - Address references (RefArg) work in both step lists
 *  - Duplicate ids across steps and orderedSteps are rejected
 *  - MISSING_REF is checked in orderedSteps just like in steps
 *  - Backward compat: specs without orderedSteps behave unchanged
 *  - addressRefSchema validates the AddressRef shape
 *  - configArgExtendedSchema validates ref, literal, and addressRef args
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  validateConfig,
  applyConfig,
  ConfigExecError,
  configSpecSchema,
  addressRefSchema,
  configArgExtendedSchema,
} from "../src/index.js";
import type {
  ConfigSpec,
  ConfigCall,
  ConfigExecutor,
  ApplyConfigOptions,
  AddressRef,
  ConfigArgExtended,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ADDRESSES = {
  feeController: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
  minterContract: "0x3333333333333333333333333333333333333333",
  vault: "0x4444444444444444444444444444444444444444",
  registry: "0x5555555555555555555555555555555555555555",
};

class FakeExecutor implements ConfigExecutor {
  readonly calls: ConfigCall[] = [];
  private readonly throwOnCallNumber: number | undefined;

  constructor(throwOnCallNumber?: number) {
    this.throwOnCallNumber = throwOnCallNumber;
  }

  async execute(call: ConfigCall): Promise<void> {
    const callNumber = this.calls.length + 1;
    if (this.throwOnCallNumber !== undefined && callNumber === this.throwOnCallNumber) {
      throw new Error(`FakeExecutor: simulated failure on call #${callNumber} (step "${call.stepId}")`);
    }
    this.calls.push(call);
  }
}

function makeOptions(
  spec: ConfigSpec | unknown,
  executor: ConfigExecutor,
  stateDir: string,
  deployedAddresses: Record<string, string> = ADDRESSES,
): ApplyConfigOptions {
  return { spec, deployedAddresses, executor, stateDir };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redeploy-config-ordered-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Schema: orderedSteps field
// ---------------------------------------------------------------------------

describe("configSpecSchema — orderedSteps field", () => {
  it("accepts a spec with an empty orderedSteps array", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [],
      orderedSteps: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a spec with orderedSteps populated", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "setX", id: "step-a", target: "feeController", function: "setFee" },
        { kind: "wire", id: "step-b", source: "token", into: "vault", function: "setToken" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a spec without orderedSteps (backward compat)", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [{ kind: "setX", id: "s1", target: "feeController", function: "setFee" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orderedSteps).toBeUndefined();
    }
  });

  it("rejects orderedSteps that is not an array", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [],
      orderedSteps: "not-an-array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an orderedSteps step with unknown kind", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [],
      orderedSteps: [{ kind: "bogus", id: "x", target: "y", function: "z" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an orderedSteps step with an empty-string id", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [],
      orderedSteps: [{ kind: "setX", id: "", target: "c", function: "f" }],
    });
    expect(result.success).toBe(false);
  });

  it("parsed spec has orderedSteps as empty array when set to []", () => {
    const result = configSpecSchema.safeParse({ version: 1, steps: [], orderedSteps: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orderedSteps).toEqual([]);
    }
  });

  it("parsed orderedSteps grantRole step is typed correctly", () => {
    const result = configSpecSchema.safeParse({
      version: 1,
      steps: [],
      orderedSteps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "ref", contract: "minterContract" },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orderedSteps?.[0].kind).toBe("grantRole");
    }
  });
});

// ---------------------------------------------------------------------------
// Schema: AddressRef
// ---------------------------------------------------------------------------

describe("addressRefSchema", () => {
  it("accepts a valid addressRef", () => {
    const result = addressRefSchema.safeParse({ kind: "addressRef", deployId: "token" });
    expect(result.success).toBe(true);
    if (result.success) {
      const ref: AddressRef = result.data;
      expect(ref.kind).toBe("addressRef");
      expect(ref.deployId).toBe("token");
    }
  });

  it("rejects an empty-string deployId", () => {
    const result = addressRefSchema.safeParse({ kind: "addressRef", deployId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing deployId", () => {
    const result = addressRefSchema.safeParse({ kind: "addressRef" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-addressRef kind", () => {
    const result = addressRefSchema.safeParse({ kind: "ref", contract: "token" });
    expect(result.success).toBe(false);
  });

  it("rejects a null input", () => {
    const result = addressRefSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema: configArgExtendedSchema
// ---------------------------------------------------------------------------

describe("configArgExtendedSchema", () => {
  it("accepts a RefArg ({ kind: 'ref', contract })", () => {
    const result = configArgExtendedSchema.safeParse({ kind: "ref", contract: "token" });
    expect(result.success).toBe(true);
  });

  it("accepts a LiteralArg ({ kind: 'literal', value })", () => {
    const result = configArgExtendedSchema.safeParse({ kind: "literal", value: 42 });
    expect(result.success).toBe(true);
  });

  it("accepts an AddressRef ({ kind: 'addressRef', deployId })", () => {
    const result = configArgExtendedSchema.safeParse({ kind: "addressRef", deployId: "vault" });
    expect(result.success).toBe(true);
    if (result.success) {
      const arg: ConfigArgExtended = result.data;
      expect(arg.kind).toBe("addressRef");
    }
  });

  it("rejects an unknown kind", () => {
    const result = configArgExtendedSchema.safeParse({ kind: "unknown", value: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects addressRef with empty-string deployId", () => {
    const result = configArgExtendedSchema.safeParse({ kind: "addressRef", deployId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects ref with empty-string contract", () => {
    const result = configArgExtendedSchema.safeParse({ kind: "ref", contract: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation: orderedSteps — duplicate id checks
// ---------------------------------------------------------------------------

describe("validateConfig — orderedSteps duplicate id checks", () => {
  it("rejects duplicate id within orderedSteps", () => {
    const result = validateConfig({
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "setX", id: "dup", target: "feeController", function: "f" },
        { kind: "setX", id: "dup", target: "token", function: "g" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_STEP_ID");
      const dupErr = result.errors.find((e) => e.code === "DUPLICATE_STEP_ID");
      expect(dupErr?.path).toBe("orderedSteps[1].id");
      expect(dupErr?.message).toContain("dup");
    }
  });

  it("rejects a duplicate id that appears in steps and orderedSteps", () => {
    const result = validateConfig({
      version: 1,
      steps: [
        { kind: "setX", id: "shared-id", target: "feeController", function: "f" },
      ],
      orderedSteps: [
        { kind: "setX", id: "shared-id", target: "token", function: "g" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain("DUPLICATE_STEP_ID");
      const dupErr = result.errors.find((e) => e.code === "DUPLICATE_STEP_ID");
      expect(dupErr?.path).toBe("orderedSteps[0].id");
      expect(dupErr?.message).toContain("shared-id");
      expect(dupErr?.message).toContain("steps[0]");
    }
  });

  it("accepts the same id NOT being duplicated across both lists", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "setX", id: "step-a", target: "feeController", function: "f" }],
        orderedSteps: [{ kind: "setX", id: "step-b", target: "token", function: "g" }],
      },
      ["feeController", "token"],
    );
    expect(result.ok).toBe(true);
  });

  it("collects multiple DUPLICATE_STEP_ID errors for three occurrences", () => {
    const result = validateConfig({
      version: 1,
      steps: [
        { kind: "setX", id: "dup", target: "feeController", function: "f" },
        { kind: "setX", id: "dup", target: "token", function: "g" },
      ],
      orderedSteps: [
        { kind: "setX", id: "dup", target: "vault", function: "h" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dupErrors = result.errors.filter((e) => e.code === "DUPLICATE_STEP_ID");
      expect(dupErrors).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation: orderedSteps — MISSING_REF checks
// ---------------------------------------------------------------------------

describe("validateConfig — orderedSteps MISSING_REF checks", () => {
  it("emits MISSING_REF for an orderedSteps setX target not in deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [],
        orderedSteps: [
          { kind: "setX", id: "s1", target: "unknownContract", function: "f" },
        ],
      },
      new Set(["feeController"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const refErr = result.errors.find((e) => e.code === "MISSING_REF");
      expect(refErr).toBeDefined();
      expect(refErr?.path).toBe("orderedSteps[0].target");
    }
  });

  it("emits MISSING_REF for an orderedSteps wire source not in deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [],
        orderedSteps: [
          { kind: "wire", id: "w1", source: "ghost", into: "vault", function: "setToken" },
        ],
      },
      new Set(["vault"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const refErr = result.errors.find((e) => e.code === "MISSING_REF");
      expect(refErr?.path).toBe("orderedSteps[0].source");
    }
  });

  it("emits MISSING_REF for an orderedSteps grantRole account ref not in deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [],
        orderedSteps: [
          {
            kind: "grantRole",
            id: "g1",
            target: "token",
            role: "MINTER",
            account: { kind: "ref", contract: "noSuchMinter" },
          },
        ],
      },
      new Set(["token"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const refErr = result.errors.find((e) => e.code === "MISSING_REF");
      expect(refErr?.path).toBe("orderedSteps[0].account.contract");
    }
  });

  it("emits MISSING_REF for an orderedSteps setX ref arg not in deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [],
        orderedSteps: [
          {
            kind: "setX",
            id: "s1",
            target: "vault",
            function: "setToken",
            args: [{ kind: "ref", contract: "noSuchToken" }],
          },
        ],
      },
      new Set(["vault"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const refErr = result.errors.find((e) => e.code === "MISSING_REF");
      expect(refErr?.path).toBe("orderedSteps[0].args[0].contract");
    }
  });

  it("skips ref-resolution in orderedSteps when no deployment is provided", () => {
    const result = validateConfig({
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "setX", id: "s1", target: "nonexistent", function: "f" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("collects MISSING_REF errors from both steps and orderedSteps", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "setX", id: "s1", target: "missingA", function: "f" }],
        orderedSteps: [{ kind: "setX", id: "s2", target: "missingB", function: "g" }],
      },
      new Set<string>(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const missingRefs = result.errors.filter((e) => e.code === "MISSING_REF");
      expect(missingRefs).toHaveLength(2);
      const paths = missingRefs.map((e) => e.path);
      expect(paths).toContain("steps[0].target");
      expect(paths).toContain("orderedSteps[0].target");
    }
  });

  it("SELF_REFERENCE is emitted for orderedSteps wire with same source and into", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [],
        orderedSteps: [
          { kind: "wire", id: "w1", source: "vault", into: "vault", function: "setVault" },
        ],
      },
      new Set(["vault"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const selfErr = result.errors.find((e) => e.code === "SELF_REFERENCE");
      expect(selfErr).toBeDefined();
      expect(selfErr?.path).toBe("orderedSteps[0].into");
    }
  });
});

// ---------------------------------------------------------------------------
// Validation: address references (RefArg) in both step lists
// ---------------------------------------------------------------------------

describe("validateConfig — address references (RefArg) in orderedSteps", () => {
  it("accepts a ref arg in a setX orderedSteps step with resolving deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [],
        orderedSteps: [
          {
            kind: "setX",
            id: "s1",
            target: "registry",
            function: "register",
            args: [{ kind: "ref", contract: "token" }],
          },
        ],
      },
      new Set(["registry", "token"]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a ref arg in a setX steps step with resolving deployment", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [
          {
            kind: "setX",
            id: "s1",
            target: "vault",
            function: "setToken",
            args: [{ kind: "ref", contract: "token" }],
          },
        ],
      },
      new Set(["vault", "token"]),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution: orderedSteps run AFTER unordered steps, in strict array order
// ---------------------------------------------------------------------------

describe("applyConfig — orderedSteps execution order", () => {
  it("executes steps THEN orderedSteps, in array order", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "unordered-1", target: "feeController", function: "setFee" },
        { kind: "setX", id: "unordered-2", target: "token", function: "setLimit" },
      ],
      orderedSteps: [
        { kind: "wire", id: "ordered-1", source: "token", into: "vault", function: "setToken" },
        {
          kind: "grantRole",
          id: "ordered-2",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "ref", contract: "minterContract" },
        },
      ],
    };

    const executor = new FakeExecutor();
    const result = await applyConfig(makeOptions(spec, executor, stateDir));

    expect(result.success).toBe(true);
    // All four steps should have executed
    expect(result.executedStepIds).toEqual(
      ["unordered-1", "unordered-2", "ordered-1", "ordered-2"],
    );
    expect(result.skippedStepIds).toEqual([]);

    // Calls were made in the exact order: steps first, then orderedSteps
    expect(executor.calls.map((c) => c.stepId)).toEqual([
      "unordered-1",
      "unordered-2",
      "ordered-1",
      "ordered-2",
    ]);
  });

  it("completedStepIds covers both steps and orderedSteps after full run", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "u1", target: "feeController", function: "f" },
      ],
      orderedSteps: [
        { kind: "setX", id: "o1", target: "token", function: "g" },
      ],
    };

    const executor = new FakeExecutor();
    const result = await applyConfig(makeOptions(spec, executor, stateDir));

    expect(result.completedStepIds).toEqual(["u1", "o1"]);
  });

  it("spec with only orderedSteps (no unordered steps) executes orderedSteps in order", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "setX", id: "o1", target: "feeController", function: "setFee" },
        { kind: "setX", id: "o2", target: "token", function: "setLimit" },
        { kind: "wire", id: "o3", source: "token", into: "vault", function: "setToken" },
      ],
    };

    const executor = new FakeExecutor();
    const result = await applyConfig(makeOptions(spec, executor, stateDir));

    expect(result.success).toBe(true);
    expect(executor.calls.map((c) => c.stepId)).toEqual(["o1", "o2", "o3"]);
    expect(result.executedStepIds).toEqual(["o1", "o2", "o3"]);
  });

  it("spec with neither steps nor orderedSteps is a no-op", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [],
    };

    const executor = new FakeExecutor();
    const result = await applyConfig(makeOptions(spec, executor, stateDir));

    expect(result.success).toBe(true);
    expect(result.executedStepIds).toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Execution: orderedSteps resume semantics
// ---------------------------------------------------------------------------

describe("applyConfig — orderedSteps resume semantics", () => {
  it("interrupts mid-orderedSteps, journal has completed steps; re-run resumes from failed step", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "u1", target: "feeController", function: "f" },
      ],
      orderedSteps: [
        { kind: "setX", id: "o1", target: "token", function: "g" },
        { kind: "setX", id: "o2", target: "vault", function: "h" },
      ],
    };

    // First run: 3 calls total (u1, o1, o2); throw on call #3 (o2)
    const executor1 = new FakeExecutor(3);
    await expect(applyConfig(makeOptions(spec, executor1, stateDir))).rejects.toThrow(
      "simulated failure on call #3",
    );

    // Journal should have u1 and o1 only
    const journalFile = path.join(stateDir, "config-state.jsonl");
    const content = await fs.promises.readFile(journalFile, "utf8");
    const ids = content.trim().split("\n").filter(Boolean).map(
      (l) => (JSON.parse(l) as { id: string }).id,
    );
    expect(ids).toEqual(["u1", "o1"]);

    // Second run: resumes from o2 only
    const executor2 = new FakeExecutor();
    const result2 = await applyConfig(makeOptions(spec, executor2, stateDir));

    expect(result2.success).toBe(true);
    expect(result2.executedStepIds).toEqual(["o2"]);
    expect(result2.skippedStepIds).toEqual(["u1", "o1"]);
    expect(result2.completedStepIds).toEqual(["u1", "o1", "o2"]);

    // executor2 only ran o2
    expect(executor2.calls.map((c) => c.stepId)).toEqual(["o2"]);
  });

  it("fully-applied re-run is a no-op for both steps and orderedSteps", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [{ kind: "setX", id: "u1", target: "feeController", function: "f" }],
      orderedSteps: [{ kind: "setX", id: "o1", target: "token", function: "g" }],
    };

    // Full first run
    const executor1 = new FakeExecutor();
    await applyConfig(makeOptions(spec, executor1, stateDir));

    // Second run — no-op
    const executor2 = new FakeExecutor();
    const result2 = await applyConfig(makeOptions(spec, executor2, stateDir));

    expect(result2.success).toBe(true);
    expect(executor2.calls).toHaveLength(0);
    expect(result2.executedStepIds).toEqual([]);
    expect(result2.skippedStepIds).toEqual(["u1", "o1"]);
    expect(result2.completedStepIds).toEqual(["u1", "o1"]);
  });

  it("orderedSteps step not in journal after crash — re-executed on next run", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "setX", id: "o1", target: "feeController", function: "f" },
        { kind: "setX", id: "o2", target: "token", function: "g" },
      ],
    };

    // Throw on call #2 (o2)
    const executor1 = new FakeExecutor(2);
    await expect(applyConfig(makeOptions(spec, executor1, stateDir))).rejects.toThrow();

    const journalFile = path.join(stateDir, "config-state.jsonl");
    const content = await fs.promises.readFile(journalFile, "utf8");
    const ids = content.trim().split("\n").filter(Boolean).map(
      (l) => (JSON.parse(l) as { id: string }).id,
    );

    // o1 is in journal, o2 is not
    expect(ids).toContain("o1");
    expect(ids).not.toContain("o2");

    // Re-run executes only o2
    const executor2 = new FakeExecutor();
    await applyConfig(makeOptions(spec, executor2, stateDir));
    expect(executor2.calls.map((c) => c.stepId)).toEqual(["o2"]);
  });

  it("each step in both lists executed EXACTLY ONCE across interrupted and resumed run", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [{ kind: "setX", id: "u1", target: "feeController", function: "f" }],
      orderedSteps: [
        { kind: "setX", id: "o1", target: "token", function: "g" },
        { kind: "setX", id: "o2", target: "vault", function: "h" },
      ],
    };

    // First run throws on call #2 (o1)
    const executor1 = new FakeExecutor(2);
    await expect(applyConfig(makeOptions(spec, executor1, stateDir))).rejects.toThrow();

    // Second run completes
    const executor2 = new FakeExecutor();
    await applyConfig(makeOptions(spec, executor2, stateDir));

    // Each step called exactly once across both runs
    const allCalls = [...executor1.calls, ...executor2.calls];
    const countById = new Map<string, number>();
    for (const call of allCalls) {
      countById.set(call.stepId, (countById.get(call.stepId) ?? 0) + 1);
    }
    expect(countById.get("u1")).toBe(1);
    expect(countById.get("o1")).toBe(1);
    expect(countById.get("o2")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Execution: address references (RefArg) in orderedSteps
// ---------------------------------------------------------------------------

describe("applyConfig — address references (RefArg) in orderedSteps", () => {
  it("ref arg in an orderedSteps setX step resolves to the correct address", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [
        {
          kind: "setX",
          id: "register-token",
          target: "vault",
          function: "setToken",
          args: [{ kind: "ref", contract: "token" }],
        },
      ],
    };

    const executor = new FakeExecutor();
    await applyConfig({
      spec,
      deployedAddresses: {
        vault: ADDRESSES.vault,
        token: ADDRESSES.token,
      },
      executor,
      stateDir,
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call.target).toBe(ADDRESSES.vault);
    expect(call.args[0]).toBe(ADDRESSES.token);
  });

  it("grantRole in orderedSteps with ref account resolves correctly", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "ref", contract: "minterContract" },
        },
      ],
    };

    const executor = new FakeExecutor();
    await applyConfig({
      spec,
      deployedAddresses: {
        token: ADDRESSES.token,
        minterContract: ADDRESSES.minterContract,
      },
      executor,
      stateDir,
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call.target).toBe(ADDRESSES.token);
    expect(call.role).toBe("MINTER_ROLE");
    expect(call.args[0]).toBe(ADDRESSES.minterContract);
  });

  it("wire in orderedSteps resolves source and into addresses correctly", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "wire", id: "wire-token-into-vault", source: "token", into: "vault",
          function: "setToken" },
      ],
    };

    const executor = new FakeExecutor();
    await applyConfig({
      spec,
      deployedAddresses: {
        token: ADDRESSES.token,
        vault: ADDRESSES.vault,
      },
      executor,
      stateDir,
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call.target).toBe(ADDRESSES.vault);
    expect(call.args[0]).toBe(ADDRESSES.token);
    expect(call.function).toBe("setToken");
  });
});

// ---------------------------------------------------------------------------
// Execution: invalid spec with orderedSteps
// ---------------------------------------------------------------------------

describe("applyConfig — invalid spec with orderedSteps", () => {
  it("throws INVALID_SPEC when orderedSteps has unknown ref target", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [],
      orderedSteps: [
        { kind: "setX", id: "s1", target: "nonExistent", function: "f" },
      ],
    };

    const executor = new FakeExecutor();
    await expect(
      applyConfig({
        spec,
        deployedAddresses: { someOtherContract: "0xDEAD" },
        executor,
        stateDir,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConfigExecError && err.code === "INVALID_SPEC",
    );
    expect(executor.calls).toHaveLength(0);
  });

  it("throws INVALID_SPEC for duplicate id across steps and orderedSteps", async () => {
    const spec = {
      version: 1,
      steps: [
        { kind: "setX", id: "shared", target: "feeController", function: "f" },
      ],
      orderedSteps: [
        { kind: "setX", id: "shared", target: "token", function: "g" },
      ],
    };

    const executor = new FakeExecutor();
    const stateDir = await makeTempDir();
    await expect(
      applyConfig(makeOptions(spec, executor, stateDir)),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConfigExecError && err.code === "INVALID_SPEC",
    );
    expect(executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: existing specs without orderedSteps
// ---------------------------------------------------------------------------

describe("applyConfig — backward compatibility (no orderedSteps)", () => {
  it("spec without orderedSteps runs exactly as before", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
        { kind: "grantRole", id: "grant-minter", target: "token", role: "MINTER_ROLE",
          account: { kind: "ref", contract: "minterContract" } },
        { kind: "wire", id: "wire-token", source: "token", into: "vault", function: "setToken" },
      ],
    };

    const executor = new FakeExecutor();
    const result = await applyConfig(makeOptions(spec, executor, stateDir));

    expect(result.success).toBe(true);
    expect(result.executedStepIds).toEqual(["set-fee", "grant-minter", "wire-token"]);
    expect(result.skippedStepIds).toEqual([]);
    expect(result.completedStepIds).toEqual(["set-fee", "grant-minter", "wire-token"]);
    expect(executor.calls.map((c) => c.stepId)).toEqual([
      "set-fee",
      "grant-minter",
      "wire-token",
    ]);
  });

  it("spec without orderedSteps: validateConfig still accepts it (backward compat)", () => {
    const result = validateConfig(
      {
        version: 1,
        steps: [{ kind: "setX", id: "s1", target: "feeController", function: "f" }],
      },
      new Set(["feeController"]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.orderedSteps).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Journal: orderedSteps entries are written correctly
// ---------------------------------------------------------------------------

describe("applyConfig — journal includes orderedSteps entries", () => {
  it("journal contains completion records for both steps and orderedSteps in execution order", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        { kind: "setX", id: "u1", target: "feeController", function: "f" },
      ],
      orderedSteps: [
        { kind: "setX", id: "o1", target: "token", function: "g" },
        { kind: "setX", id: "o2", target: "vault", function: "h" },
      ],
    };

    const executor = new FakeExecutor();
    await applyConfig(makeOptions(spec, executor, stateDir));

    const journalFile = path.join(stateDir, "config-state.jsonl");
    const content = await fs.promises.readFile(journalFile, "utf8");
    const ids = content.trim().split("\n").filter(Boolean).map(
      (l) => (JSON.parse(l) as { id: string }).id,
    );

    // Journal should contain all ids in execution order: steps first, then orderedSteps
    expect(ids).toEqual(["u1", "o1", "o2"]);
  });
});

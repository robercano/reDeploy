import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyConfig,
  ConfigExecError,
} from "../src/index.js";
import type {
  ConfigSpec,
  ConfigCall,
  ConfigExecutor,
  ApplyConfigOptions,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Addresses used across tests. */
const ADDRESSES = {
  feeController: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
  minterContract: "0x3333333333333333333333333333333333333333",
  vault: "0x4444444444444444444444444444444444444444",
};

/** A full spec covering all three step kinds. */
const threeStepSpec: ConfigSpec = {
  version: 1,
  steps: [
    {
      kind: "setX",
      id: "set-fee",
      target: "feeController",
      function: "setFee",
      args: [{ kind: "literal", value: 500 }],
    },
    {
      kind: "grantRole",
      id: "grant-minter",
      target: "token",
      role: "MINTER_ROLE",
      account: { kind: "ref", contract: "minterContract" },
    },
    {
      kind: "wire",
      id: "wire-token-into-vault",
      source: "token",
      into: "vault",
      function: "setToken",
    },
  ],
};

/**
 * A fake ConfigExecutor that records every call it received and can be
 * configured to throw on the Nth call (1-indexed, to simulate a crash).
 */
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

/** Build ApplyConfigOptions with given spec, executor, and stateDir. */
function makeOptions(
  spec: ConfigSpec | unknown,
  executor: ConfigExecutor,
  stateDir: string,
  deployedAddresses: Record<string, string> = ADDRESSES,
): ApplyConfigOptions {
  return { spec, deployedAddresses, executor, stateDir };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redeploy-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test: Fresh run executes all steps in order
// ---------------------------------------------------------------------------

describe("applyConfig — fresh run", () => {
  it("executes all steps IN ORDER and returns completedStepIds with all ids", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();
    const result = await applyConfig(makeOptions(threeStepSpec, executor, stateDir));

    expect(result.success).toBe(true);
    expect(result.executedStepIds).toEqual(["set-fee", "grant-minter", "wire-token-into-vault"]);
    expect(result.skippedStepIds).toEqual([]);
    expect(result.completedStepIds).toEqual(["set-fee", "grant-minter", "wire-token-into-vault"]);

    // Steps were called in the same order as the spec
    expect(executor.calls.map((c) => c.stepId)).toEqual([
      "set-fee",
      "grant-minter",
      "wire-token-into-vault",
    ]);
  });

  it("writes all completed step ids to the journal file on disk", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();
    await applyConfig(makeOptions(threeStepSpec, executor, stateDir));

    const journalFile = path.join(stateDir, "config-state.jsonl");
    const content = await fs.promises.readFile(journalFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id);

    expect(ids).toEqual(["set-fee", "grant-minter", "wire-token-into-vault"]);
  });
});

// ---------------------------------------------------------------------------
// Test: Interrupt mid-config (crash simulation)
// ---------------------------------------------------------------------------

describe("applyConfig — interrupt and resume", () => {
  it("interrupts at step 2, journal has only step 1; re-run executes only steps 2 and 3", async () => {
    const stateDir = await makeTempDir();

    // --- First run: throws on step 2 (call #2) ---
    const executor1 = new FakeExecutor(2);
    await expect(applyConfig(makeOptions(threeStepSpec, executor1, stateDir))).rejects.toThrow(
      "simulated failure on call #2",
    );

    // journal should have only step 1
    const journalFile = path.join(stateDir, "config-state.jsonl");
    const contentAfterCrash = await fs.promises.readFile(journalFile, "utf8");
    const idsAfterCrash = contentAfterCrash
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { id: string }).id);
    expect(idsAfterCrash).toEqual(["set-fee"]);

    // --- Second run: non-throwing executor, same stateDir ---
    const executor2 = new FakeExecutor();
    const result2 = await applyConfig(makeOptions(threeStepSpec, executor2, stateDir));

    expect(result2.success).toBe(true);
    expect(result2.executedStepIds).toEqual(["grant-minter", "wire-token-into-vault"]);
    expect(result2.skippedStepIds).toEqual(["set-fee"]);
    expect(result2.completedStepIds).toEqual(["set-fee", "grant-minter", "wire-token-into-vault"]);

    // executor2 only ran steps 2 and 3
    expect(executor2.calls.map((c) => c.stepId)).toEqual([
      "grant-minter",
      "wire-token-into-vault",
    ]);
  });

  it("across both runs, each step's executor.execute was called EXACTLY ONCE", async () => {
    const stateDir = await makeTempDir();

    // First run throws on call #2 (step "grant-minter")
    const executor1 = new FakeExecutor(2);
    await expect(applyConfig(makeOptions(threeStepSpec, executor1, stateDir))).rejects.toThrow();

    // Second run completes
    const executor2 = new FakeExecutor();
    await applyConfig(makeOptions(threeStepSpec, executor2, stateDir));

    // Combine calls from both executors
    const allCalls = [...executor1.calls, ...executor2.calls];
    const callsByStepId = new Map<string, number>();
    for (const call of allCalls) {
      callsByStepId.set(call.stepId, (callsByStepId.get(call.stepId) ?? 0) + 1);
    }

    expect(callsByStepId.get("set-fee")).toBe(1);
    expect(callsByStepId.get("grant-minter")).toBe(1);
    expect(callsByStepId.get("wire-token-into-vault")).toBe(1);
  });

  it("the crashing step is NOT in the journal after the interrupted run", async () => {
    const stateDir = await makeTempDir();

    // Throw on call #2 which is "grant-minter"
    const executor1 = new FakeExecutor(2);
    await expect(applyConfig(makeOptions(threeStepSpec, executor1, stateDir))).rejects.toThrow();

    const journalFile = path.join(stateDir, "config-state.jsonl");
    const content = await fs.promises.readFile(journalFile, "utf8");
    const ids = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { id: string }).id);

    // "grant-minter" (step k=2) must NOT be in the journal
    expect(ids).not.toContain("grant-minter");
    // "set-fee" (step 1, which completed) IS in the journal
    expect(ids).toContain("set-fee");
    // "wire-token-into-vault" (step 3, never reached) is also absent
    expect(ids).not.toContain("wire-token-into-vault");
  });
});

// ---------------------------------------------------------------------------
// Test: Fully-applied re-run is a no-op
// ---------------------------------------------------------------------------

describe("applyConfig — idempotent re-run", () => {
  it("fully-applied re-run: executor never called, all steps skipped, success=true", async () => {
    const stateDir = await makeTempDir();

    // First full run
    const executor1 = new FakeExecutor();
    await applyConfig(makeOptions(threeStepSpec, executor1, stateDir));

    // Second run with a fresh executor, same stateDir
    const executor2 = new FakeExecutor();
    const result2 = await applyConfig(makeOptions(threeStepSpec, executor2, stateDir));

    expect(result2.success).toBe(true);
    expect(executor2.calls).toHaveLength(0);
    expect(result2.executedStepIds).toEqual([]);
    expect(result2.skippedStepIds).toEqual(["set-fee", "grant-minter", "wire-token-into-vault"]);
    expect(result2.completedStepIds).toEqual(["set-fee", "grant-minter", "wire-token-into-vault"]);
  });
});

// ---------------------------------------------------------------------------
// Test: Unknown ref → throws ConfigExecError
// ---------------------------------------------------------------------------

describe("applyConfig — unknown ref", () => {
  it("throws ConfigExecError with code INVALID_SPEC when a target ref is not in deployedAddresses", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-something",
          target: "nonExistentContract",
          function: "setFee",
        },
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
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof ConfigExecError &&
        (err.code === "INVALID_SPEC" || err.code === "UNKNOWN_REF")
      );
    });
  });

  it("error is an instance of ConfigExecError", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "wire",
          id: "wire-missing",
          source: "ghost",
          into: "vault",
          function: "setToken",
        },
      ],
    };

    const executor = new FakeExecutor();
    let caughtError: unknown;
    try {
      await applyConfig({
        spec,
        deployedAddresses: { vault: "0x4444444444444444444444444444444444444444" },
        executor,
        stateDir,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ConfigExecError);
    const configErr = caughtError as ConfigExecError;
    expect(configErr.code === "INVALID_SPEC" || configErr.code === "UNKNOWN_REF").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: Ref resolution correctness
// ---------------------------------------------------------------------------

describe("applyConfig — ref resolution", () => {
  it("resolves ref args to the exact addresses from deployedAddresses", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-token",
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
    // Target is vault's address
    expect(call.target).toBe(ADDRESSES.vault);
    // First arg is token's address (resolved from ref)
    expect(call.args[0]).toBe(ADDRESSES.token);
  });

  it("resolves grantRole account ref to the exact address", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
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

  it("resolves wire source and into to their exact addresses", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "wire",
          id: "wire-token-into-vault",
          source: "token",
          into: "vault",
          function: "setToken",
        },
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
    // target is the `into` contract (vault)
    expect(call.target).toBe(ADDRESSES.vault);
    // args[0] is the `source` contract address (token)
    expect(call.args[0]).toBe(ADDRESSES.token);
    expect(call.function).toBe("setToken");
  });

  it("resolves literal args unchanged", async () => {
    const stateDir = await makeTempDir();
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };

    const executor = new FakeExecutor();
    await applyConfig({
      spec,
      deployedAddresses: { feeController: ADDRESSES.feeController },
      executor,
      stateDir,
    });

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].args[0]).toBe(500);
  });

  it("passes literal account through correctly for grantRole", async () => {
    const stateDir = await makeTempDir();
    const literalAddress = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-admin",
          target: "token",
          role: "ADMIN_ROLE",
          account: { kind: "literal", value: literalAddress },
        },
      ],
    };

    const executor = new FakeExecutor();
    await applyConfig({
      spec,
      deployedAddresses: { token: ADDRESSES.token },
      executor,
      stateDir,
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call.args[0]).toBe(literalAddress);
    expect(call.role).toBe("ADMIN_ROLE");
  });
});

// ---------------------------------------------------------------------------
// Test: ConfigCall shape validation
// ---------------------------------------------------------------------------

describe("applyConfig — ConfigCall shape", () => {
  it("setX ConfigCall has correct kind, stepId, function, and args", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();
    await applyConfig({
      spec: {
        version: 1,
        steps: [
          {
            kind: "setX",
            id: "set-fee",
            target: "feeController",
            function: "setFee",
            args: [{ kind: "literal", value: 42 }],
          },
        ],
      },
      deployedAddresses: { feeController: ADDRESSES.feeController },
      executor,
      stateDir,
    });

    const call = executor.calls[0];
    expect(call.kind).toBe("setX");
    expect(call.stepId).toBe("set-fee");
    expect(call.function).toBe("setFee");
    expect(call.args).toEqual([42]);
    expect(call.role).toBeUndefined();
  });

  it("grantRole ConfigCall has function='grantRole', role, and account as first arg", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();
    await applyConfig({
      spec: {
        version: 1,
        steps: [
          {
            kind: "grantRole",
            id: "grant-minter",
            target: "token",
            role: "MINTER_ROLE",
            account: { kind: "literal", value: "0xCAFE" },
          },
        ],
      },
      deployedAddresses: { token: ADDRESSES.token },
      executor,
      stateDir,
    });

    const call = executor.calls[0];
    expect(call.kind).toBe("grantRole");
    expect(call.function).toBe("grantRole");
    expect(call.role).toBe("MINTER_ROLE");
    expect(call.args).toEqual(["0xCAFE"]);
  });

  it("wire ConfigCall: target=into address, args=[source address]", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();
    await applyConfig({
      spec: {
        version: 1,
        steps: [
          {
            kind: "wire",
            id: "wire-token-into-vault",
            source: "token",
            into: "vault",
            function: "setToken",
          },
        ],
      },
      deployedAddresses: {
        token: ADDRESSES.token,
        vault: ADDRESSES.vault,
      },
      executor,
      stateDir,
    });

    const call = executor.calls[0];
    expect(call.kind).toBe("wire");
    expect(call.target).toBe(ADDRESSES.vault);
    expect(call.args).toEqual([ADDRESSES.token]);
    expect(call.function).toBe("setToken");
  });
});

// ---------------------------------------------------------------------------
// Test: Invalid spec
// ---------------------------------------------------------------------------

describe("applyConfig — invalid spec", () => {
  it("throws ConfigExecError(INVALID_SPEC) for an invalid spec object", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();

    await expect(
      applyConfig(makeOptions({ version: 2, steps: [] }, executor, stateDir)),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ConfigExecError && err.code === "INVALID_SPEC",
    );
  });

  it("includes specErrors on the thrown ConfigExecError", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();

    let caughtError: unknown;
    try {
      await applyConfig(makeOptions({ version: 2, steps: [] }, executor, stateDir));
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ConfigExecError);
    const configErr = caughtError as ConfigExecError;
    expect(configErr.specErrors).toBeDefined();
    expect(Array.isArray(configErr.specErrors)).toBe(true);
    expect(configErr.specErrors!.length).toBeGreaterThan(0);
  });

  it("throws ConfigExecError(INVALID_SPEC) for a null spec", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();

    await expect(
      applyConfig(makeOptions(null, executor, stateDir)),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof ConfigExecError && err.code === "INVALID_SPEC",
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Empty spec is a no-op
// ---------------------------------------------------------------------------

describe("applyConfig — empty spec", () => {
  it("empty steps list runs without error and returns empty arrays", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();
    const result = await applyConfig(
      makeOptions({ version: 1, steps: [] }, executor, stateDir),
    );

    expect(result.success).toBe(true);
    expect(result.executedStepIds).toEqual([]);
    expect(result.skippedStepIds).toEqual([]);
    expect(result.completedStepIds).toEqual([]);
    expect(executor.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Crash-safety detail — step NOT in journal after crash
// ---------------------------------------------------------------------------

describe("applyConfig — crash safety", () => {
  it("a step that throws is absent from the journal (at-least-once, not at-most-once)", async () => {
    const stateDir = await makeTempDir();

    // Spec with 3 steps; crash on step 3 (call #3, "wire-token-into-vault")
    const executor = new FakeExecutor(3);
    await expect(applyConfig(makeOptions(threeStepSpec, executor, stateDir))).rejects.toThrow();

    const journalFile = path.join(stateDir, "config-state.jsonl");
    const content = await fs.promises.readFile(journalFile, "utf8");
    const ids = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { id: string }).id);

    // Steps 1 and 2 completed before the crash
    expect(ids).toContain("set-fee");
    expect(ids).toContain("grant-minter");
    // Step 3 (the crashing step) is NOT in the journal
    expect(ids).not.toContain("wire-token-into-vault");
  });

  it("journal file is not created when the spec is invalid (no file side-effects)", async () => {
    const stateDir = await makeTempDir();
    const executor = new FakeExecutor();

    await expect(
      applyConfig(makeOptions({ version: 99, steps: [] }, executor, stateDir)),
    ).rejects.toBeInstanceOf(ConfigExecError);

    const journalFile = path.join(stateDir, "config-state.jsonl");
    const exists = fs.existsSync(journalFile);
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: ConfigExecError structure
// ---------------------------------------------------------------------------

describe("ConfigExecError", () => {
  it("is an instance of Error", () => {
    const err = new ConfigExecError("INVALID_SPEC", "test");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct name", () => {
    const err = new ConfigExecError("INVALID_SPEC", "test");
    expect(err.name).toBe("ConfigExecError");
  });

  it("exposes the code", () => {
    const err = new ConfigExecError("UNKNOWN_REF", "missing ref");
    expect(err.code).toBe("UNKNOWN_REF");
  });

  it("exposes specErrors when provided", () => {
    const specErrors = [{ path: "x", code: "INVALID_SHAPE" as const, message: "bad" }];
    const err = new ConfigExecError("INVALID_SPEC", "msg", specErrors);
    expect(err.specErrors).toEqual(specErrors);
  });

  it("specErrors is undefined when not provided", () => {
    const err = new ConfigExecError("JOURNAL_ERROR", "could not read");
    expect(err.specErrors).toBeUndefined();
  });
});

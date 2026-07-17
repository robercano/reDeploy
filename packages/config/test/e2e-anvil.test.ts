/**
 * End-to-end tests for @redeploy/config against a live local chain (Anvil).
 *
 * These tests exercise the FULL stack that the unit tests in execute.test.ts
 * and ordered-steps.test.ts intentionally stub out: a real `ConfigExecutor`
 * (packages/config/test/helpers/chainExecutor.ts) that signs and broadcasts
 * actual transactions, against real deployed fixture contracts
 * (Registry.sol / Vault.sol / Token.sol, deployed via @redeploy/core's own
 * `deploy()`), running on a locally-spawned Anvil instance
 * (packages/config/test/helpers/anvil.ts).
 *
 * Covers (see issue #97):
 *  1. Full config apply — setX / grantRole / wire all land on-chain, verified
 *     by reading state back through the provider (not just executor bookkeeping).
 *  2. Partial config + resume — a run interrupted mid-way leaves partial
 *     on-chain state and a partial config-state.jsonl journal; re-running the
 *     SAME ConfigSpec against the SAME stateDir executes ONLY the steps that
 *     did not complete, and never re-executes (never re-sends a transaction
 *     for) an already-completed step.
 *  3. Ordered steps run strictly after unordered steps, and in array order.
 *
 * SKIPPABILITY
 * ============
 * This suite requires the `anvil` and `forge` binaries. It is guarded by
 * `describe.skipIf(!isFoundryAvailable())` so machines without Foundry still
 * pass the rest of the suite cleanly. Coverage of the production code
 * (execute.ts, journal.ts) is already provided by the existing unit tests
 * (execute.test.ts / ordered-steps.test.ts / index.test.ts), so skipping this
 * suite does not affect the package's coverage threshold.
 *
 * ANVIL HARNESS NOTE — see test/helpers/anvil.ts for details: this is a
 * config-local, test-only harness pending a shared one from issue #96.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyConfig } from "../src/index.js";
import type { ConfigSpec } from "../src/index.js";
import {
  startAnvil,
  isFoundryAvailable,
  ANVIL_DEV_PRIVATE_KEY_0,
  ANVIL_DEV_ADDRESS_1,
  type AnvilInstance,
} from "./helpers/anvil.js";
import { deployFixtures, type DeployFixturesResult } from "./helpers/deployFixtures.js";
import { ChainConfigExecutor, RecordingExecutor } from "./helpers/chainExecutor.js";
import { makeChainReader } from "./helpers/chainReader.js";

const foundryAvailable = isFoundryAvailable();
if (!foundryAvailable) {
  console.warn(
    "[config e2e] `anvil`/`forge` not found on PATH — skipping applyConfig Anvil e2e suite.",
  );
}

describe.skipIf(!foundryAvailable)("applyConfig — e2e against Anvil", () => {
  let anvil: AnvilInstance;
  let reader: ReturnType<typeof makeChainReader>;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    anvil = await startAnvil();
    reader = makeChainReader(anvil.rpcUrl);
  }, 30_000);

  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
    await anvil?.stop();
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `redeploy-config-e2e-${prefix}-`),
    );
    tempDirs.push(dir);
    return dir;
  }

  /** Fresh set of fixtures deployed onto the shared Anvil chain. */
  async function freshFixtures(label: string): Promise<DeployFixturesResult> {
    const deploymentDir = await makeTempDir(`deploy-${label}`);
    return deployFixtures(anvil.rpcUrl, deploymentDir);
  }

  /** Read the ordered list of step ids recorded in the config-state journal. */
  async function readJournalStepIds(stateDir: string): Promise<string[]> {
    const journalFile = path.join(stateDir, "config-state.jsonl");
    let content: string;
    try {
      content = await fs.promises.readFile(journalFile, "utf8");
    } catch {
      return [];
    }
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { id: string }).id);
  }

  /**
   * A three-step spec covering all three step kinds: one unordered `setX`,
   * followed by an ordered `wire` and an ordered `grantRole` — matching the
   * mapping described in the ticket: setX -> Vault.setFeeBps,
   * wire -> Vault.setRegistry(Registry), grantRole -> Token MINTER_ROLE.
   */
  function threeKindSpec(): ConfigSpec {
    return {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "vault",
          function: "setFeeBps",
          args: [{ kind: "literal", value: 250 }],
        },
      ],
      orderedSteps: [
        {
          kind: "wire",
          id: "wire-registry-into-vault",
          source: "registry",
          into: "vault",
          function: "setRegistry",
        },
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "MINTER_ROLE",
          account: { kind: "literal", value: ANVIL_DEV_ADDRESS_1 },
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // 1. Full config apply
  // -------------------------------------------------------------------------

  describe("1. full config apply", () => {
    it(
      "runs setX / wire / grantRole to completion; on-chain state (read via the provider) matches the spec",
      async () => {
        const fixtures = await freshFixtures("full");
        const stateDir = await makeTempDir("state-full");
        const executor = new ChainConfigExecutor(anvil.rpcUrl, ANVIL_DEV_PRIVATE_KEY_0);

        const result = await applyConfig({
          spec: threeKindSpec(),
          deployedAddresses: fixtures.addresses,
          executor,
          stateDir,
        });

        expect(result.success).toBe(true);
        expect(result.executedStepIds).toEqual([
          "set-fee",
          "wire-registry-into-vault",
          "grant-minter",
        ]);
        expect(result.skippedStepIds).toEqual([]);

        // Assert on real on-chain state, read back independently via the
        // provider — NOT via the executor's own bookkeeping.
        expect(await reader.vaultFeeBps(fixtures.addresses.vault)).toBe(250);
        expect(await reader.vaultRegistry(fixtures.addresses.vault)).toBe(
          fixtures.addresses.registry.toLowerCase(),
        );
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(true);

        // And the journal reflects every step, in execution order.
        expect(await readJournalStepIds(stateDir)).toEqual([
          "set-fee",
          "wire-registry-into-vault",
          "grant-minter",
        ]);
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // 2. Partial config + resume — config-state.jsonl idempotency
  // -------------------------------------------------------------------------

  describe("2. partial config + resume", () => {
    it(
      "an interrupted run leaves partial on-chain state + a partial journal; re-running the SAME spec resumes and executes each step exactly once",
      async () => {
        const fixtures = await freshFixtures("partial");
        const stateDir = await makeTempDir("state-partial");
        const chainExecutor = new ChainConfigExecutor(anvil.rpcUrl, ANVIL_DEV_PRIVATE_KEY_0);
        const spec = threeKindSpec();

        // --- First run: interrupted BEFORE the 3rd call (grant-minter) -----
        // set-fee (1) and wire-registry-into-vault (2) land on-chain and are
        // journaled; grant-minter (3) never reaches the executor.
        const executor1 = new RecordingExecutor(chainExecutor, 3);
        await expect(
          applyConfig({
            spec,
            deployedAddresses: fixtures.addresses,
            executor: executor1,
            stateDir,
          }),
        ).rejects.toThrow("simulated interruption before call #3");

        expect(executor1.calls.map((c) => c.stepId)).toEqual([
          "set-fee",
          "wire-registry-into-vault",
        ]);

        // On-chain: the two completed steps are visible; grant-minter is not.
        expect(await reader.vaultFeeBps(fixtures.addresses.vault)).toBe(250);
        expect(await reader.vaultRegistry(fixtures.addresses.vault)).toBe(
          fixtures.addresses.registry.toLowerCase(),
        );
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(false);

        // The journal (config-state.jsonl) has exactly the two completed ids.
        expect(await readJournalStepIds(stateDir)).toEqual([
          "set-fee",
          "wire-registry-into-vault",
        ]);

        // --- Second run: SAME spec, SAME stateDir, fresh executor ----------
        const executor2 = new RecordingExecutor(chainExecutor);
        const result2 = await applyConfig({
          spec,
          deployedAddresses: fixtures.addresses,
          executor: executor2,
          stateDir,
        });

        expect(result2.success).toBe(true);
        expect(result2.skippedStepIds).toEqual(["set-fee", "wire-registry-into-vault"]);
        expect(result2.executedStepIds).toEqual(["grant-minter"]);

        // Completed steps were NOT handed back to the executor on resume —
        // i.e. no duplicate on-chain call. If "wire-registry-into-vault" had
        // been re-executed, Vault.setRegistry would have reverted with
        // RegistryAlreadySet (it can only be called once), so this also
        // proves resumption didn't attempt to re-run it.
        expect(executor2.calls.map((c) => c.stepId)).toEqual(["grant-minter"]);

        // Now the third effect is present on-chain too.
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(true);

        // Idempotency proof: across BOTH runs, each step's executor.execute
        // (and therefore its on-chain transaction) ran EXACTLY ONCE.
        const allCalls = [...executor1.calls, ...executor2.calls].map((c) => c.stepId);
        expect(allCalls).toEqual(["set-fee", "wire-registry-into-vault", "grant-minter"]);

        const callCounts = new Map<string, number>();
        for (const id of allCalls) {
          callCounts.set(id, (callCounts.get(id) ?? 0) + 1);
        }
        for (const id of ["set-fee", "wire-registry-into-vault", "grant-minter"]) {
          expect(callCounts.get(id)).toBe(1);
        }

        // Final journal contains all three ids, in the order they actually
        // completed across the two runs.
        expect(await readJournalStepIds(stateDir)).toEqual([
          "set-fee",
          "wire-registry-into-vault",
          "grant-minter",
        ]);

        // A THIRD run against the now-fully-journaled stateDir is a total
        // no-op: the executor is never called again.
        const executor3 = new RecordingExecutor(chainExecutor);
        const result3 = await applyConfig({
          spec,
          deployedAddresses: fixtures.addresses,
          executor: executor3,
          stateDir,
        });
        expect(result3.success).toBe(true);
        expect(result3.executedStepIds).toEqual([]);
        expect(result3.skippedStepIds).toEqual([
          "set-fee",
          "wire-registry-into-vault",
          "grant-minter",
        ]);
        expect(executor3.calls).toHaveLength(0);
      },
      60_000,
    );
  });

  // -------------------------------------------------------------------------
  // 3. Ordered steps run strictly after unordered steps, and in order
  // -------------------------------------------------------------------------

  describe("3. ordered steps run strictly after unordered steps, in order", () => {
    it(
      "two unordered setX steps complete before either ordered step starts, and orderedSteps run in strict array order",
      async () => {
        const fixtures = await freshFixtures("ordered");
        const stateDir = await makeTempDir("state-ordered");
        const chainExecutor = new ChainConfigExecutor(anvil.rpcUrl, ANVIL_DEV_PRIVATE_KEY_0);
        const executor = new RecordingExecutor(chainExecutor);

        const spec: ConfigSpec = {
          version: 1,
          steps: [
            {
              kind: "setX",
              id: "unordered-1",
              target: "vault",
              function: "setFeeBps",
              args: [{ kind: "literal", value: 100 }],
            },
            {
              kind: "setX",
              id: "unordered-2",
              target: "vault",
              function: "setFeeBps",
              args: [{ kind: "literal", value: 200 }],
            },
          ],
          orderedSteps: [
            {
              kind: "wire",
              id: "ordered-1",
              source: "registry",
              into: "vault",
              function: "setRegistry",
            },
            {
              kind: "grantRole",
              id: "ordered-2",
              target: "token",
              role: "MINTER_ROLE",
              account: { kind: "literal", value: ANVIL_DEV_ADDRESS_1 },
            },
          ],
        };

        const result = await applyConfig({
          spec,
          deployedAddresses: fixtures.addresses,
          executor,
          stateDir,
        });

        expect(result.success).toBe(true);

        // Real on-chain transactions were awaited sequentially in this exact
        // order: both unordered steps, THEN both ordered steps, in array order.
        expect(executor.calls.map((c) => c.stepId)).toEqual([
          "unordered-1",
          "unordered-2",
          "ordered-1",
          "ordered-2",
        ]);
        expect(result.executedStepIds).toEqual([
          "unordered-1",
          "unordered-2",
          "ordered-1",
          "ordered-2",
        ]);

        // The journal — which drives resume — records completion in the same
        // strict order (steps first, then orderedSteps in array order).
        expect(await readJournalStepIds(stateDir)).toEqual([
          "unordered-1",
          "unordered-2",
          "ordered-1",
          "ordered-2",
        ]);

        // Final on-chain state: last unordered write wins (200), and both
        // ordered effects (wire + grant) landed.
        expect(await reader.vaultFeeBps(fixtures.addresses.vault)).toBe(200);
        expect(await reader.vaultRegistry(fixtures.addresses.vault)).toBe(
          fixtures.addresses.registry.toLowerCase(),
        );
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(true);
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // 4. read args — reading a value from a deployed contract into a later step
  // -------------------------------------------------------------------------

  describe("4. read args — reading a value written by a prior config step", () => {
    it(
      "reads registry.lookup(key) (set by a prior ordered config step) and uses the result as a grantRole.account",
      async () => {
        const fixtures = await freshFixtures("read");
        const stateDir = await makeTempDir("state-read");
        const executor = new ChainConfigExecutor(anvil.rpcUrl, ANVIL_DEV_PRIVATE_KEY_0);

        // The reading step ("grant-minter-via-read") depends on the EFFECT of
        // "register-minter" (a prior config step), so — per the ordering rule
        // documented in steps/types.ts — both live in `orderedSteps`, with the
        // reading step placed strictly AFTER the step whose effect it reads.
        const spec: ConfigSpec = {
          version: 1,
          steps: [],
          orderedSteps: [
            {
              kind: "setX",
              id: "register-minter",
              target: "registry",
              function: "register",
              args: [
                { kind: "literal", value: "minter" },
                { kind: "literal", value: ANVIL_DEV_ADDRESS_1 },
              ],
            },
            {
              kind: "grantRole",
              id: "grant-minter-via-read",
              target: "token",
              role: "MINTER_ROLE",
              account: {
                kind: "read",
                contract: "registry",
                function: "lookup",
                args: [{ kind: "literal", value: "minter" }],
              },
            },
          ],
        };

        const result = await applyConfig({
          spec,
          deployedAddresses: fixtures.addresses,
          executor,
          stateDir,
        });

        expect(result.success).toBe(true);
        expect(result.executedStepIds).toEqual(["register-minter", "grant-minter-via-read"]);

        // The role was granted to the address READ from the registry — this
        // only passes if the `read` arg's on-chain result (not a hardcoded
        // literal) actually drove the grantRole call.
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(true);

        expect(await readJournalStepIds(stateDir)).toEqual([
          "register-minter",
          "grant-minter-via-read",
        ]);
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // 5. read args — partial + resume (idempotency)
  // -------------------------------------------------------------------------

  describe("5. read args — partial + resume", () => {
    it(
      "an interrupted run before the reading step's on-chain tx leaves it un-journaled; resuming executes it exactly once and applies the correct read result",
      async () => {
        const fixtures = await freshFixtures("read-resume");
        const stateDir = await makeTempDir("state-read-resume");
        const chainExecutor = new ChainConfigExecutor(anvil.rpcUrl, ANVIL_DEV_PRIVATE_KEY_0);
        const spec: ConfigSpec = {
          version: 1,
          steps: [],
          orderedSteps: [
            {
              kind: "setX",
              id: "register-minter",
              target: "registry",
              function: "register",
              args: [
                { kind: "literal", value: "minter" },
                { kind: "literal", value: ANVIL_DEV_ADDRESS_1 },
              ],
            },
            {
              kind: "grantRole",
              id: "grant-minter-via-read",
              target: "token",
              role: "MINTER_ROLE",
              account: {
                kind: "read",
                contract: "registry",
                function: "lookup",
                args: [{ kind: "literal", value: "minter" }],
              },
            },
          ],
        };

        // --- First run: interrupted before the 2nd on-chain tx (the reading
        // step's grantRole call). "register-minter" lands on-chain and is
        // journaled. The reading step's `read` IS attempted — a `read` arg
        // resolves as part of building the ConfigCall, BEFORE executor.execute()
        // is invoked (see execute/execute.ts) — but its on-chain tx never lands.
        const executor1 = new RecordingExecutor(chainExecutor, 2);
        await expect(
          applyConfig({
            spec,
            deployedAddresses: fixtures.addresses,
            executor: executor1,
            stateDir,
          }),
        ).rejects.toThrow("simulated interruption before call #2");

        expect(executor1.calls.map((c) => c.stepId)).toEqual(["register-minter"]);
        expect(executor1.reads).toHaveLength(1);
        expect(executor1.reads[0]).toEqual({
          target: fixtures.addresses.registry,
          function: "lookup",
          args: ["minter"],
        });

        // The grant never landed on-chain.
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(false);
        expect(await readJournalStepIds(stateDir)).toEqual(["register-minter"]);

        // --- Second run: SAME spec, SAME stateDir — resumes and executes ONLY
        // the reading step. "register-minter" is skipped, so Registry.register
        // is never invoked a second time (proving idempotency for the
        // already-completed step).
        const executor2 = new RecordingExecutor(chainExecutor);
        const result2 = await applyConfig({
          spec,
          deployedAddresses: fixtures.addresses,
          executor: executor2,
          stateDir,
        });

        expect(result2.success).toBe(true);
        expect(result2.skippedStepIds).toEqual(["register-minter"]);
        expect(result2.executedStepIds).toEqual(["grant-minter-via-read"]);
        expect(executor2.calls.map((c) => c.stepId)).toEqual(["grant-minter-via-read"]);
        expect(executor2.reads).toHaveLength(1);

        // The role is now granted, using the (re-resolved) read result.
        expect(
          await reader.hasRole(fixtures.addresses.token, "MINTER_ROLE", ANVIL_DEV_ADDRESS_1),
        ).toBe(true);

        // Idempotency: "register-minter" ran (landed on-chain) exactly once
        // across both runs.
        const allCallIds = [...executor1.calls, ...executor2.calls].map((c) => c.stepId);
        expect(allCallIds.filter((id) => id === "register-minter")).toHaveLength(1);

        expect(await readJournalStepIds(stateDir)).toEqual([
          "register-minter",
          "grant-minter-via-read",
        ]);

        // --- Third run against the now fully-journaled stateDir: BOTH steps
        // are skipped and NO reads are performed at all — proving a resumed,
        // fully-complete run never re-invokes read() for steps it skips.
        const executor3 = new RecordingExecutor(chainExecutor);
        const result3 = await applyConfig({
          spec,
          deployedAddresses: fixtures.addresses,
          executor: executor3,
          stateDir,
        });
        expect(result3.success).toBe(true);
        expect(result3.executedStepIds).toEqual([]);
        expect(result3.skippedStepIds).toEqual(["register-minter", "grant-minter-via-read"]);
        expect(executor3.calls).toHaveLength(0);
        expect(executor3.reads).toHaveLength(0);
      },
      60_000,
    );
  });
});

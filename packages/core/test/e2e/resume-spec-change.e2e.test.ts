/**
 * E2E scenario 3 — spec change on resume, against a real Anvil chain.
 *
 * Deploys `fullSpec()` (5 contracts, fully complete) into a deploymentDir,
 * then re-runs with `extendedSpec()` — the SAME 5 contracts PLUS one brand
 * new leaf contract ("registry2") that was never part of the original spec.
 *
 * Asserts:
 *   - Only "registry2" is newly deployed (new address, real on-chain code).
 *   - Every pre-existing contract's address is UNCHANGED across the re-run.
 *   - The journal shows NO new activity for any of the 5 pre-existing
 *     futures after the extended re-run — proving the spec change did not
 *     disturb the already-deployed contracts.
 *
 * This is distinct from the interruption/resume scenario (resume-idempotent):
 * here the ORIGINAL deployment is not interrupted at all — it completes fully
 * — and the resume run evolves the SPEC ITSELF by adding a new entry.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { deploy } from "../../src/deploy/deploy.js";
import { jsonRpcProvider } from "../../src/provider/jsonRpc.js";
import { isAnvilAvailable, startAnvil, type AnvilInstance } from "./anvilHarness.js";
import { areFixturesBuilt, extendedSpec, fixturesArtifactResolver, fullSpec } from "./fixtures.js";
import { futureIdFor, hasActivityForFutureAfter, journalLineCount } from "./journal.js";

const ANVIL_READY = isAnvilAvailable();
const FIXTURES_READY = areFixturesBuilt();

if (!ANVIL_READY) {
  console.warn(
    "[e2e] Skipping resume-spec-change.e2e.test.ts — `anvil` binary not found on PATH. " +
      "Install Foundry (https://getfoundry.sh) to run these tests. See test/e2e/README.md.",
  );
}
if (ANVIL_READY && !FIXTURES_READY) {
  console.warn(
    "[e2e] Skipping resume-spec-change.e2e.test.ts — contracts/out fixtures are not built. " +
      "Run `forge build` in contracts/. See test/e2e/README.md.",
  );
}

const ORIGINAL_IDS = ["registry", "token", "priceOracle", "vault", "vaultErc4626"];

describe.skipIf(!ANVIL_READY || !FIXTURES_READY)(
  "e2e: adding a new contract to the spec on resume (real Anvil)",
  () => {
    let anvil: AnvilInstance;
    let deploymentDir: string;

    beforeAll(async () => {
      anvil = await startAnvil();
    }, 30_000);

    afterAll(async () => {
      if (anvil) await anvil.stop();
    }, 15_000);

    beforeAll(() => {
      deploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-specchange-"));
    });

    afterAll(() => {
      if (deploymentDir) rmSync(deploymentDir, { recursive: true, force: true });
    });

    it(
      "deploys only the newly-added contract and leaves pre-existing addresses untouched",
      async () => {
        const provider = jsonRpcProvider({
          rpcUrl: anvil.rpcUrl,
          privateKey: anvil.accounts[0]!.privateKey,
        });
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        const artifactResolver = fixturesArtifactResolver();

        // --- Phase 1: deploy the ORIGINAL (complete) spec -----------------------
        const original = await deploy({
          spec: fullSpec(accounts[0]!),
          provider,
          accounts,
          deploymentDir,
          artifactResolver,
        });
        expect(original.success).toBe(true);
        expect(Object.keys(original.deployedAddresses).sort()).toEqual([...ORIGINAL_IDS].sort());

        const journalLengthAfterOriginal = journalLineCount(deploymentDir);

        // --- Phase 2: re-run with the EXTENDED spec (adds "registry2") ---------
        const extended = await deploy({
          spec: extendedSpec(accounts[0]!),
          provider,
          accounts,
          deploymentDir,
          artifactResolver,
        });
        expect(extended.success).toBe(true);

        // ASSERTION: every pre-existing address is UNCHANGED.
        for (const id of ORIGINAL_IDS) {
          expect(extended.deployedAddresses[id]).toBe(original.deployedAddresses[id]);
        }

        // ASSERTION (journal-level): none of the pre-existing futures show any
        // new activity after the extended re-run.
        for (const id of ORIGINAL_IDS) {
          expect(
            hasActivityForFutureAfter(deploymentDir, futureIdFor(id), journalLengthAfterOriginal),
          ).toBe(false);
        }

        // ASSERTION: the new contract ("registry2") is deployed with a fresh
        // address and real on-chain bytecode.
        const registry2Address = extended.deployedAddresses["registry2"];
        expect(registry2Address).toBeDefined();
        expect(Object.values(original.deployedAddresses)).not.toContain(registry2Address);

        const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
        const code = await publicClient.getCode({ address: registry2Address as Hex });
        expect(code).not.toBe("0x");
      },
      120_000,
    );
  },
);

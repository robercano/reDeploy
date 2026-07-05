/**
 * E2E scenario 2 — partial deploy + resume (idempotency) against a real
 * Anvil chain.
 *
 * STRATEGY
 * ========
 * Uses a strictly LINEAR 3-contract chain (registry -> token -> vault, see
 * fixtures.ts's linearChainSpec) so Ignition deploys each contract in its own
 * sequential batch. We wrap the REAL jsonRpcProvider (talking to a REAL Anvil
 * node) with a thin shim that throws on the SECOND `eth_estimateGas` call —
 * this happens BEFORE Ignition journals a nonce for "token" (nonce is
 * journaled only after estimateGas succeeds — see TRANSACTION_PREPARE_SEND in
 * the journal), so the interruption leaves a clean, resumable journal with
 * "registry" COMPLETE and "token"/"vault" never started.
 *
 * We then re-run the SAME spec against the SAME deploymentDir with a HEALTHY
 * (unwrapped) provider and assert:
 *   - "registry"'s address is UNCHANGED (read from the journal/deployed_addresses,
 *     not re-deployed).
 *   - The journal has NO NEW activity for "registry"'s future after the resume
 *     (proves no re-deploy at the Ignition-journal level, not just "the address
 *     happened to match").
 *   - "token" and "vault" (missing before) now have real on-chain bytecode.
 *
 * REGRESSION SENSITIVITY: if idempotency ever regressed (e.g. "registry" were
 * re-deployed on resume), the on-chain deploy would consume the account's next
 * nonce and produce a DIFFERENT contract address — the
 * `expect(resumed.deployedAddresses["registry"]).toBe(partialRegistryAddress)`
 * assertion below would fail, as would the journal-activity assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { deploy } from "../../src/deploy/deploy.js";
import { jsonRpcProvider } from "../../src/provider/jsonRpc.js";
import type { EIP1193Provider } from "@nomicfoundation/ignition-core";
import { isAnvilAvailable, startAnvil, type AnvilInstance } from "./anvilHarness.js";
import { areFixturesBuilt, fixturesArtifactResolver, linearChainSpec } from "./fixtures.js";
import { futureIdFor, hasActivityForFutureAfter, journalLineCount } from "./journal.js";

const ANVIL_READY = isAnvilAvailable();
const FIXTURES_READY = areFixturesBuilt();

if (!ANVIL_READY) {
  console.warn(
    "[e2e] Skipping resume-idempotent.e2e.test.ts — `anvil` binary not found on PATH. " +
      "Install Foundry (https://getfoundry.sh) to run these tests. See test/e2e/README.md.",
  );
}
if (ANVIL_READY && !FIXTURES_READY) {
  console.warn(
    "[e2e] Skipping resume-idempotent.e2e.test.ts — contracts/out fixtures are not built. " +
      "Run `forge build` in contracts/. See test/e2e/README.md.",
  );
}

/** Wraps a real provider so the Nth eth_estimateGas call throws, simulating a
 * mid-deployment crash/interruption BEFORE any nonce is journaled for it. */
function withEstimateGasFailureOn(provider: EIP1193Provider, failOnCallNumber: number): EIP1193Provider {
  let estimateGasCalls = 0;
  return {
    async request(args) {
      if (args.method === "eth_estimateGas") {
        estimateGasCalls += 1;
        if (estimateGasCalls === failOnCallNumber) {
          throw new Error("SIMULATED_INTERRUPTION: aborting before this future's transaction is sent");
        }
      }
      return provider.request(args);
    },
  };
}

describe.skipIf(!ANVIL_READY || !FIXTURES_READY)(
  "e2e: partial deploy + resume is idempotent (real Anvil)",
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
      deploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-resume-"));
    });

    afterAll(() => {
      if (deploymentDir) rmSync(deploymentDir, { recursive: true, force: true });
    });

    it(
      "resumes an interrupted deployment without re-deploying already-complete contracts",
      async () => {
        const privateKey = anvil.accounts[0]!.privateKey;
        const realProvider = jsonRpcProvider({ rpcUrl: anvil.rpcUrl, privateKey });
        const accounts = (await realProvider.request({ method: "eth_accounts" })) as string[];
        const artifactResolver = fixturesArtifactResolver();
        const spec = linearChainSpec(accounts[0]!);

        // --- Phase 1: interrupted partial deploy --------------------------------
        // Batch 1 = registry (1st estimateGas call, succeeds).
        // Batch 2 = token (2nd estimateGas call — we make THIS one throw).
        const interruptingProvider = withEstimateGasFailureOn(realProvider, 2);

        let threw = false;
        try {
          await deploy({
            spec,
            provider: interruptingProvider,
            accounts,
            deploymentDir,
            artifactResolver,
          });
        } catch {
          threw = true;
        }
        expect(threw, "expected the simulated interruption to abort phase 1").toBe(true);

        const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });

        // registry must have been ACTUALLY deployed on-chain in phase 1.
        const partialAddressesRaw = readFileSync(join(deploymentDir, "deployed_addresses.json"), "utf-8");
        const partialAddresses = JSON.parse(partialAddressesRaw) as Record<string, string>;
        const partialRegistryAddress = partialAddresses[futureIdFor("registry")];
        expect(partialRegistryAddress).toBeDefined();
        const partialRegistryCode = await publicClient.getCode({ address: partialRegistryAddress as Hex });
        expect(partialRegistryCode).not.toBe("0x");

        // token/vault must NOT have been deployed yet.
        expect(partialAddresses[futureIdFor("token")]).toBeUndefined();
        expect(partialAddresses[futureIdFor("vault")]).toBeUndefined();

        const journalLengthAfterPartial = journalLineCount(deploymentDir);

        // --- Phase 2: resume with a HEALTHY provider, SAME deploymentDir --------
        const resumed = await deploy({
          spec,
          provider: realProvider,
          accounts,
          deploymentDir,
          artifactResolver,
        });

        expect(resumed.success).toBe(true);

        // ASSERTION (idempotency): registry's address is UNCHANGED.
        // This is the assertion that would FAIL if idempotency regressed
        // (e.g. registry got re-deployed to a fresh address on resume).
        expect(resumed.deployedAddresses["registry"]).toBe(partialRegistryAddress);

        // ASSERTION (idempotency, journal-level): no new journal activity for
        // registry's future after the resume — proves Ignition did not
        // re-execute/re-send a transaction for it.
        expect(
          hasActivityForFutureAfter(deploymentDir, futureIdFor("registry"), journalLengthAfterPartial),
        ).toBe(false);

        // token and vault (previously missing) are now deployed with real code.
        for (const id of ["token", "vault"]) {
          const address = resumed.deployedAddresses[id];
          expect(address, `expected "${id}" to be deployed on resume`).toBeDefined();
          const code = await publicClient.getCode({ address: address as Hex });
          expect(code).not.toBe("0x");
        }
      },
      120_000,
    );
  },
);

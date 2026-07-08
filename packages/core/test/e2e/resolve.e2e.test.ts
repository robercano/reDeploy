/**
 * E2E scenario — typed resolver escape-hatch (issue #100, Layer 2) against a
 * real local Anvil chain.
 *
 * Proves the full resolver pre-resolution pass end-to-end, against REAL
 * JSON-RPC semantics (not a mocked EIP-1193 provider):
 *   1. Deploy a first "registry" Registry(admin) contract normally (no
 *      resolvers involved).
 *   2. Deploy AGAIN into the SAME deploymentDir with a spec that adds a
 *      second Registry ("registry2") whose `admin` constructor arg is a
 *      `{ kind: "resolver" }` arg. The resolver:
 *        - reads `ctx.resolvedAddresses.registry` — the FIRST registry's
 *          address, read back from Ignition's journal by deploy()'s
 *          pre-resolution pass (resolve/resolveSpec.ts), proving the
 *          journal-read path works against a real deployment, not just a
 *          fake-provider unit test.
 *        - performs a REAL on-chain read via `ctx.provider.request(...)`
 *          (`eth_getCode` on the first registry's address) to prove
 *          `ctx.provider` is a live, working EIP-1193 provider — not a stub.
 *        - returns the deployer's own address as the literal `admin` value
 *          for registry2.
 *   3. Assert registry2 was deployed with that resolved admin actually
 *      holding DEFAULT_ADMIN_ROLE on-chain (real `hasRole` read via viem).
 *
 * REQUIRES the `anvil` binary (see ../e2e/anvilHarness.ts). If it is not
 * installed, this whole suite is skipped with a console warning — see
 * test/e2e/README.md for how to install it and run these tests locally.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { deploy } from "../../src/deploy/deploy.js";
import type { ResolverRegistry } from "../../src/resolve/registry.js";
import { jsonRpcProvider } from "../../src/provider/jsonRpc.js";
import { isAnvilAvailable, startAnvil, type AnvilInstance } from "./anvilHarness.js";
import { areFixturesBuilt, fixturesArtifactResolver, loadFixtureAbi } from "./fixtures.js";
import type { DeploymentSpec } from "../../src/spec/types.js";

const ANVIL_READY = isAnvilAvailable();
const FIXTURES_READY = areFixturesBuilt();

/** OpenZeppelin AccessControl's DEFAULT_ADMIN_ROLE is always bytes32(0). */
const DEFAULT_ADMIN_ROLE = `0x${"0".repeat(64)}` as Hex;

if (!ANVIL_READY) {
  console.warn(
    "[e2e] Skipping resolve.e2e.test.ts — `anvil` binary not found on PATH. " +
      "Install Foundry (https://getfoundry.sh) to run these tests. See test/e2e/README.md.",
  );
}
if (ANVIL_READY && !FIXTURES_READY) {
  console.warn(
    "[e2e] Skipping resolve.e2e.test.ts — contracts/out fixtures are not built. " +
      "Run `forge build` in contracts/. See test/e2e/README.md.",
  );
}

describe.skipIf(!ANVIL_READY || !FIXTURES_READY)("e2e: ResolverArg (typed resolver escape-hatch)", () => {
  let anvil: AnvilInstance;
  let deploymentDir: string;

  beforeAll(async () => {
    anvil = await startAnvil();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  }, 15_000);

  beforeAll(() => {
    deploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-resolve-"));
  });

  afterAll(() => {
    if (deploymentDir) rmSync(deploymentDir, { recursive: true, force: true });
  });

  it(
    "resolves a resolver arg against a real journal (resolvedAddresses) and a live provider (ctx.provider), and the resolved value lands on-chain",
    async () => {
      const provider = jsonRpcProvider({
        rpcUrl: anvil.rpcUrl,
        privateKey: anvil.accounts[0]!.privateKey,
      });
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      const deployerAddress = accounts[0]!;
      const artifactResolver = fixturesArtifactResolver();

      // --- Run 1: deploy the first Registry normally (no resolvers) ---------
      const firstSpec: DeploymentSpec = {
        version: 1,
        contracts: [
          { id: "registry", contract: "Registry", args: [{ kind: "literal", value: deployerAddress }] },
        ],
      };

      const firstResult = await deploy({
        spec: firstSpec,
        provider,
        accounts,
        deploymentDir,
        artifactResolver,
      });

      expect(firstResult.success).toBe(true);
      const registryAddress = firstResult.deployedAddresses["registry"]!;
      expect(registryAddress).toMatch(/^0x/);

      // --- Run 2: SAME deploymentDir. Add "registry2" whose admin arg is a --
      // resolver reading ctx.resolvedAddresses.registry (from run 1's real
      // journal) and ctx.provider (a real eth_getCode read).
      let observedResolvedAddresses: Record<string, string> | undefined;
      let observedCode: string | undefined;

      const resolvers: ResolverRegistry = {
        deriveAdminFromRegistry: async (ctx) => {
          observedResolvedAddresses = ctx.resolvedAddresses;
          const firstRegistryAddr = ctx.resolvedAddresses["registry"];
          if (firstRegistryAddr === undefined) {
            throw new Error("expected ctx.resolvedAddresses.registry to be populated from the journal");
          }
          // A REAL on-chain read through the live provider.
          observedCode = (await ctx.provider.request({
            method: "eth_getCode",
            params: [firstRegistryAddr, "latest"],
          })) as string;
          // Return the deployer's own address as the literal admin value.
          return deployerAddress;
        },
      };

      const secondSpec: DeploymentSpec = {
        version: 1,
        contracts: [
          { id: "registry", contract: "Registry", args: [{ kind: "literal", value: deployerAddress }] },
          {
            id: "registry2",
            contract: "Registry",
            args: [{ kind: "resolver", name: "deriveAdminFromRegistry" }],
          },
        ],
      };

      const secondResult = await deploy({
        spec: secondSpec,
        provider,
        accounts,
        deploymentDir,
        artifactResolver,
        resolvers,
      });

      expect(secondResult.success).toBe(true);

      // --- Assert the pre-resolution pass actually saw real, live data ------
      expect(observedResolvedAddresses).toEqual({ registry: registryAddress });
      expect(observedCode).toBeDefined();
      expect(observedCode).not.toBe("0x"); // real deployed bytecode, not empty

      // --- Assert the resolved value landed correctly on the REAL deployed --
      // registry2 contract: deployerAddress must hold DEFAULT_ADMIN_ROLE.
      const registry2Address = secondResult.deployedAddresses["registry2"]!;
      expect(registry2Address).toMatch(/^0x/);

      const registryAbi = await loadFixtureAbi("Registry");
      const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
      const hasAdminRole = await publicClient.readContract({
        address: registry2Address as Hex,
        abi: registryAbi,
        functionName: "hasRole",
        args: [DEFAULT_ADMIN_ROLE, deployerAddress as Hex],
      });
      expect(hasAdminRole).toBe(true);
    },
    120_000,
  );

  it(
    "throws DeployError(UNKNOWN_RESOLVER) before sending any on-chain transaction when the resolver is not registered",
    async () => {
      const provider = jsonRpcProvider({
        rpcUrl: anvil.rpcUrl,
        privateKey: anvil.accounts[0]!.privateKey,
      });
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      const freshDeploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-resolve-unknown-"));

      try {
        const spec: DeploymentSpec = {
          version: 1,
          contracts: [
            {
              id: "registry",
              contract: "Registry",
              args: [{ kind: "resolver", name: "neverRegistered" }],
            },
          ],
        };

        await expect(
          deploy({
            spec,
            provider,
            accounts,
            deploymentDir: freshDeploymentDir,
            artifactResolver: fixturesArtifactResolver(),
            // no `resolvers` supplied
          }),
        ).rejects.toMatchObject({ name: "DeployError", code: "UNKNOWN_RESOLVER" });
      } finally {
        rmSync(freshDeploymentDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

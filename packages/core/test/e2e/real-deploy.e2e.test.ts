/**
 * E2E scenario 1 — real deploy against a live local Anvil chain.
 *
 * Deploys a multi-contract spec WITH inter-contract RefArg links (Vault refs
 * Token; VaultERC4626 refs Token + PriceOracle) against a real Anvil node —
 * not a mocked EIP-1193 provider. Asserts:
 *   1. `deployed_addresses.json` is written under the deploymentDir.
 *   2. Every deployed contract has real on-chain bytecode (eth_getCode != "0x").
 *   3. The ref links are wired correctly on-chain, read back via eth_call
 *      (viem's readContract): Vault.token() === Token address,
 *      VaultERC4626.asset() === Token address, VaultERC4626.oracle() ===
 *      PriceOracle address.
 *
 * REQUIRES the `anvil` binary (see ../e2e/anvilHarness.ts). If it is not
 * installed, this whole suite is skipped with a console warning — see
 * test/e2e/README.md for how to install it and run these tests locally.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { deploy } from "../../src/deploy/deploy.js";
import { jsonRpcProvider } from "../../src/provider/jsonRpc.js";
import { isAnvilAvailable, startAnvil, type AnvilInstance } from "./anvilHarness.js";
import { areFixturesBuilt, fixturesArtifactResolver, fullSpec, loadFixtureAbi } from "./fixtures.js";
import { futureIdFor } from "./journal.js";

const ANVIL_READY = isAnvilAvailable();
const FIXTURES_READY = areFixturesBuilt();

if (!ANVIL_READY) {
  console.warn(
    "[e2e] Skipping real-deploy.e2e.test.ts — `anvil` binary not found on PATH. " +
      "Install Foundry (https://getfoundry.sh) to run these tests. See test/e2e/README.md.",
  );
}
if (ANVIL_READY && !FIXTURES_READY) {
  console.warn(
    "[e2e] Skipping real-deploy.e2e.test.ts — contracts/out fixtures are not built. " +
      "Run `forge build` in contracts/. See test/e2e/README.md.",
  );
}

describe.skipIf(!ANVIL_READY || !FIXTURES_READY)("e2e: real deploy against Anvil", () => {
  let anvil: AnvilInstance;
  let deploymentDir: string;

  beforeAll(async () => {
    anvil = await startAnvil();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
  }, 15_000);

  beforeAll(() => {
    deploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-real-"));
  });

  afterAll(() => {
    if (deploymentDir) rmSync(deploymentDir, { recursive: true, force: true });
  });

  it(
    "deploys a linked multi-contract spec, writes deployed_addresses.json, and wires refs correctly on-chain",
    async () => {
      const provider = jsonRpcProvider({
        rpcUrl: anvil.rpcUrl,
        privateKey: anvil.accounts[0]!.privateKey,
      });
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      const artifactResolver = fixturesArtifactResolver();
      const spec = fullSpec(accounts[0]!);

      const result = await deploy({
        spec,
        provider,
        accounts,
        deploymentDir,
        artifactResolver,
      });

      expect(result.success).toBe(true);
      expect(Object.keys(result.deployedAddresses).sort()).toEqual(
        ["registry", "token", "priceOracle", "vault", "vaultErc4626"].sort(),
      );

      // --- 1. deployed_addresses.json is written under deploymentDir ---------
      const deployedAddressesRaw = readFileSync(join(deploymentDir, "deployed_addresses.json"), "utf-8");
      const deployedAddressesJson = JSON.parse(deployedAddressesRaw) as Record<string, string>;
      for (const id of Object.keys(result.deployedAddresses)) {
        expect(deployedAddressesJson[futureIdFor(id)]).toBe(result.deployedAddresses[id]);
      }

      // --- 2. every deployed contract has real on-chain bytecode --------------
      const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
      for (const [id, address] of Object.entries(result.deployedAddresses)) {
        const code = await publicClient.getCode({ address: address as Hex });
        expect(code, `expected on-chain bytecode for "${id}" at ${address}`).toBeDefined();
        expect(code).not.toBe("0x");
        expect(code!.length).toBeGreaterThan(2);
      }

      // --- 3. ref links are wired correctly on-chain (read via eth_call) ------
      const vaultAbi = await loadFixtureAbi("Vault");
      const vaultToken = await publicClient.readContract({
        address: result.deployedAddresses["vault"] as Hex,
        abi: vaultAbi,
        functionName: "token",
      });
      expect((vaultToken as string).toLowerCase()).toBe(result.deployedAddresses["token"]!.toLowerCase());

      const vaultErc4626Abi = await loadFixtureAbi("VaultERC4626");
      const vaultErc4626Asset = await publicClient.readContract({
        address: result.deployedAddresses["vaultErc4626"] as Hex,
        abi: vaultErc4626Abi,
        functionName: "asset",
      });
      expect((vaultErc4626Asset as string).toLowerCase()).toBe(
        result.deployedAddresses["token"]!.toLowerCase(),
      );

      const vaultErc4626Oracle = await publicClient.readContract({
        address: result.deployedAddresses["vaultErc4626"] as Hex,
        abi: vaultErc4626Abi,
        functionName: "oracle",
      });
      expect((vaultErc4626Oracle as string).toLowerCase()).toBe(
        result.deployedAddresses["priceOracle"]!.toLowerCase(),
      );
    },
    120_000,
  );
});

/**
 * E2E scenario — ParamArg + DeployOptions.deploymentParameters resolve to a
 * REAL on-chain effect, against a live local Anvil chain (issue #98).
 *
 * STRATEGY
 * ========
 * Registry's constructor takes an `admin` address and grants it
 * DEFAULT_ADMIN_ROLE (see contracts/src/Registry.sol). We declare the spec's
 * `parameters.admin` as one Anvil account (the "declared default") but
 * OVERRIDE it via `DeployOptions.deploymentParameters` to a DIFFERENT Anvil
 * account (the "per-network override") — exactly the per-network-override
 * scenario issue #98 is about.
 *
 * This proves the FULL chain end-to-end:
 *   spec ParamArg -> compile.ts's m.getParameter() -> Ignition's own
 *   parameter-precedence -> DeployOptions.deploymentParameters -> the REAL
 *   constructor call sent to a REAL Anvil chain.
 *
 * We verify the outcome by reading AccessControl's `hasRole` (a real on-chain
 * read, via viem) rather than just inspecting the compiled module (that is
 * already covered by compile.test.ts's unit tests) or the raw calldata (that
 * is already covered by deploy.test.ts's decodeDeployData assertions):
 *   - The OVERRIDE address (deploymentParameters) HOLDS DEFAULT_ADMIN_ROLE.
 *   - The DECLARED DEFAULT address (spec.parameters) does NOT hold it —
 *     proving deploymentParameters took precedence over the spec's default,
 *     not the other way around.
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
import { jsonRpcProvider } from "../../src/provider/jsonRpc.js";
import { isAnvilAvailable, startAnvil, type AnvilInstance } from "./anvilHarness.js";
import { areFixturesBuilt, fixturesArtifactResolver, loadFixtureAbi } from "./fixtures.js";
import type { DeploymentSpec } from "../../src/spec/types.js";

const ANVIL_READY = isAnvilAvailable();
const FIXTURES_READY = areFixturesBuilt();

if (!ANVIL_READY) {
  console.warn(
    "[e2e] Skipping param-resolution.e2e.test.ts — `anvil` binary not found on PATH. " +
      "Install Foundry (https://getfoundry.sh) to run these tests. See test/e2e/README.md.",
  );
}
if (ANVIL_READY && !FIXTURES_READY) {
  console.warn(
    "[e2e] Skipping param-resolution.e2e.test.ts — contracts/out fixtures are not built. " +
      "Run `forge build` in contracts/. See test/e2e/README.md.",
  );
}

describe.skipIf(!ANVIL_READY || !FIXTURES_READY)(
  "e2e: ParamArg + deploymentParameters resolve to a real on-chain effect (real Anvil)",
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
      deploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-params-"));
    });

    afterAll(() => {
      if (deploymentDir) rmSync(deploymentDir, { recursive: true, force: true });
    });

    it(
      "the deploymentParameters override (not the spec's declared default) receives DEFAULT_ADMIN_ROLE",
      async () => {
        const privateKey = anvil.accounts[0]!.privateKey;
        const provider = jsonRpcProvider({ rpcUrl: anvil.rpcUrl, privateKey });
        // jsonRpcProvider() is a single-key signer: eth_accounts only ever
        // returns that one signer address. Use two DISTINCT Anvil dev
        // accounts (from the harness, not the provider) as the "declared
        // default" and "override" addresses passed as constructor ARGS —
        // they don't need to be signers, just plain addresses.
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        const artifactResolver = fixturesArtifactResolver();

        const declaredDefaultAdmin = anvil.accounts[1]!.address;
        const overriddenAdmin = anvil.accounts[2]!.address;
        expect(overriddenAdmin.toLowerCase()).not.toBe(declaredDefaultAdmin.toLowerCase());

        const spec: DeploymentSpec = {
          version: 1,
          parameters: { admin: declaredDefaultAdmin },
          contracts: [
            {
              id: "registry",
              contract: "Registry",
              args: [{ kind: "param", name: "admin" }],
            },
          ],
        };

        const result = await deploy({
          spec,
          provider,
          accounts,
          deploymentDir,
          artifactResolver,
          // Per-network override: the module id defaults to "Deployment"
          // (no `moduleId` option passed to deploy()).
          deploymentParameters: { Deployment: { admin: overriddenAdmin } },
        });

        expect(result.success).toBe(true);
        const registryAddress = result.deployedAddresses["registry"];
        expect(registryAddress).toBeDefined();

        const abi = await loadFixtureAbi("Registry");
        const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });

        const defaultAdminRole = await publicClient.readContract({
          address: registryAddress as Hex,
          abi,
          functionName: "DEFAULT_ADMIN_ROLE",
        });

        const overriddenHasRole = await publicClient.readContract({
          address: registryAddress as Hex,
          abi,
          functionName: "hasRole",
          args: [defaultAdminRole, overriddenAdmin as Hex],
        });
        const declaredDefaultHasRole = await publicClient.readContract({
          address: registryAddress as Hex,
          abi,
          functionName: "hasRole",
          args: [defaultAdminRole, declaredDefaultAdmin as Hex],
        });

        // ASSERTION: the deploymentParameters OVERRIDE ended up as the actual
        // on-chain admin.
        expect(overriddenHasRole).toBe(true);
        // ASSERTION: the spec's declared DEFAULT never took effect — the
        // override took precedence over it, exactly as issue #98 requires
        // for per-network overrides.
        expect(declaredDefaultHasRole).toBe(false);
      },
      60_000,
    );

    it(
      "falls back to the spec's declared default when deploymentParameters supplies no override",
      async () => {
        const privateKey = anvil.accounts[0]!.privateKey;
        const provider = jsonRpcProvider({ rpcUrl: anvil.rpcUrl, privateKey });
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        const artifactResolver = fixturesArtifactResolver();
        const declaredDefaultAdmin = anvil.accounts[3]!.address;

        const spec: DeploymentSpec = {
          version: 1,
          parameters: { admin: declaredDefaultAdmin },
          contracts: [
            {
              id: "registry",
              contract: "Registry",
              args: [{ kind: "param", name: "admin" }],
            },
          ],
        };

        // NOTE: a fresh deploymentDir — this is a distinct Ignition module
        // instance from the previous test, so no deploymentParameters at all
        // is supplied here (not even an empty object for this parameter).
        const freshDeploymentDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-params-default-"));
        try {
          const result = await deploy({
            spec,
            provider,
            accounts,
            deploymentDir: freshDeploymentDir,
            artifactResolver,
          });

          expect(result.success).toBe(true);
          const registryAddress = result.deployedAddresses["registry"];
          const abi = await loadFixtureAbi("Registry");
          const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });

          const defaultAdminRole = await publicClient.readContract({
            address: registryAddress as Hex,
            abi,
            functionName: "DEFAULT_ADMIN_ROLE",
          });
          const hasRole = await publicClient.readContract({
            address: registryAddress as Hex,
            abi,
            functionName: "hasRole",
            args: [defaultAdminRole, declaredDefaultAdmin as Hex],
          });

          expect(hasRole).toBe(true);
        } finally {
          rmSync(freshDeploymentDir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);

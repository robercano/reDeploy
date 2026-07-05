/**
 * TEST-ONLY deployment glue for @redeploy/config's Anvil-backed e2e suite.
 *
 * Deploys the shared contract fixtures (contracts/src/Token.sol, Registry.sol,
 * Vault.sol) onto a live Anvil chain using @redeploy/core's own `deploy()` +
 * `jsonRpcProvider()` + `foundryArtifactResolver()` — i.e. the same deploy
 * path a real caller of reDeploy would use. This package does not (and must
 * not) modify anything under `contracts/`; it only compiles (via `forge
 * build`, idempotent) and deploys the existing fixtures.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deploy,
  jsonRpcProvider,
  foundryArtifactResolver,
  type DeploymentSpec,
} from "@redeploy/core";
import { ANVIL_DEV_ADDRESS_0, ANVIL_DEV_PRIVATE_KEY_0 } from "./anvil.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Foundry project (contracts/). */
export const CONTRACTS_DIR = path.resolve(__dirname, "../../../../contracts");

/** Absolute path to Foundry's compiled-artifact output directory. */
export const CONTRACTS_OUT_DIR = path.join(CONTRACTS_DIR, "out");

/**
 * Ensure `contracts/out` has fresh compiled artifacts by running
 * `forge build`. Idempotent — Foundry only recompiles changed sources.
 *
 * @throws Error if `forge build` exits non-zero.
 */
export function ensureContractsBuilt(): void {
  const result = spawnSync("forge", ["build"], {
    cwd: CONTRACTS_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `forge build failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/**
 * Addresses of the fixture contracts deployed by {@link deployFixtures}.
 *
 * Also structurally compatible with `Record<string, string>` (the shape
 * `applyConfig`'s `deployedAddresses` option expects) so callers can pass
 * `fixtures.addresses` straight through without a cast.
 */
export interface FixtureAddresses extends Record<string, string> {
  readonly token: string;
  readonly registry: string;
  readonly vault: string;
}

export interface DeployFixturesResult {
  readonly addresses: FixtureAddresses;
  /** The account that deployed the fixtures (holds DEFAULT_ADMIN_ROLE on all three). */
  readonly deployerAddress: string;
}

/**
 * Deploy Token, Registry, and Vault onto the chain at `rpcUrl`, using
 * @redeploy/core's idempotent/resumable `deploy()` — mirroring how a real
 * reDeploy caller would deploy these fixtures.
 *
 * Vault's constructor takes the Token's address (a `ref`), so `deploy()`
 * resolves the dependency ordering automatically; Registry's constructor
 * takes the deployer's address as its initial admin.
 *
 * @param rpcUrl - Anvil (or any EVM JSON-RPC) endpoint to deploy against.
 * @param deploymentDir - Directory for Ignition's journal (pass a fresh temp
 *   dir per test so runs don't interfere with each other).
 */
export async function deployFixtures(
  rpcUrl: string,
  deploymentDir: string,
): Promise<DeployFixturesResult> {
  ensureContractsBuilt();

  const deployerAddress = ANVIL_DEV_ADDRESS_0;
  const provider = jsonRpcProvider({ rpcUrl, privateKey: ANVIL_DEV_PRIVATE_KEY_0 });

  const spec: DeploymentSpec = {
    version: 1,
    contracts: [
      {
        id: "token",
        contract: "Token",
        args: [
          { kind: "literal", value: "Test Token" },
          { kind: "literal", value: "TST" },
        ],
      },
      {
        id: "registry",
        contract: "Registry",
        args: [{ kind: "literal", value: deployerAddress }],
      },
      {
        id: "vault",
        contract: "Vault",
        args: [{ kind: "ref", contract: "token" }],
      },
    ],
  };

  const result = await deploy({
    spec,
    provider,
    accounts: [deployerAddress],
    deploymentDir,
    artifactResolver: foundryArtifactResolver(CONTRACTS_OUT_DIR),
  });

  if (!result.success) {
    throw new Error(
      `fixture deployment failed: ${JSON.stringify(result.ignitionResult, null, 2)}`,
    );
  }

  const { token, registry, vault } = result.deployedAddresses;
  if (!token || !registry || !vault) {
    throw new Error(
      `fixture deployment did not return all expected addresses: ${JSON.stringify(result.deployedAddresses)}`,
    );
  }

  return {
    addresses: { token, registry, vault },
    deployerAddress,
  };
}

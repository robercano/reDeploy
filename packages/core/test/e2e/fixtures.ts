/**
 * Shared fixtures for @redeploy/core Anvil e2e tests.
 *
 * Resolves the real Foundry-built contract fixtures at `<repo>/contracts/out`
 * (built via `forge build` — see `contracts/`) and provides small builders
 * for the multi-contract DeploymentSpecs used across the e2e scenarios.
 *
 * Contract dependency graph (see contracts/src/*.sol):
 *   - Registry(admin)                                — leaf
 *   - Token(name_, symbol_)                           — leaf
 *   - PriceOracle(decimals_, initialAnswer_)          — leaf
 *   - Vault(token_)                                   — ref Token
 *   - VaultERC4626(asset_, oracle_, name_, symbol_)   — ref Token, ref PriceOracle
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { foundryArtifactResolver } from "../../src/resolvers/foundry.js";
import type { DeploymentSpec } from "../../src/spec/types.js";
import type { ArtifactResolver } from "@nomicfoundation/ignition-core";

// packages/core/test/e2e/fixtures.ts -> packages/core -> <repo>/contracts/out
const CORE_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
export const CONTRACTS_OUT_DIR = resolve(CORE_DIR, "../../contracts/out");

/** True iff the Foundry fixtures have been built (`forge build` in contracts/). */
export function areFixturesBuilt(): boolean {
  return (
    existsSync(resolve(CONTRACTS_OUT_DIR, "Registry.sol", "Registry.json")) &&
    existsSync(resolve(CONTRACTS_OUT_DIR, "Token.sol", "Token.json")) &&
    existsSync(resolve(CONTRACTS_OUT_DIR, "PriceOracle.sol", "PriceOracle.json")) &&
    existsSync(resolve(CONTRACTS_OUT_DIR, "Vault.sol", "Vault.json")) &&
    existsSync(resolve(CONTRACTS_OUT_DIR, "VaultERC4626.sol", "VaultERC4626.json"))
  );
}

/** Builds an ArtifactResolver reading the real Foundry fixtures. */
export function fixturesArtifactResolver(): ArtifactResolver {
  return foundryArtifactResolver(CONTRACTS_OUT_DIR);
}

/** Reads the ABI for one of the fixture contracts (for viem readContract calls). */
export async function loadFixtureAbi(name: string): Promise<readonly unknown[]> {
  const artifact = await fixturesArtifactResolver().loadArtifact(name);
  return artifact.abi as readonly unknown[];
}

/**
 * A leaf-only spec: Registry + Token + PriceOracle, no refs between them.
 * Used as the "already deployed" subset in the resume scenarios.
 */
export function leafSpec(adminAddress: string): DeploymentSpec {
  return {
    version: 1,
    contracts: [
      { id: "registry", contract: "Registry", args: [{ kind: "literal", value: adminAddress }] },
      {
        id: "token",
        contract: "Token",
        args: [
          { kind: "literal", value: "Test Token" },
          { kind: "literal", value: "TST" },
        ],
      },
      {
        id: "priceOracle",
        contract: "PriceOracle",
        args: [
          { kind: "literal", value: 8 },
          { kind: "literal", value: 200_000_000_000 },
        ],
      },
    ],
  };
}

/**
 * The full spec: leafSpec() plus Vault (refs Token) and VaultERC4626 (refs
 * Token + PriceOracle) — exercises real inter-contract RefArg wiring.
 */
export function fullSpec(adminAddress: string): DeploymentSpec {
  const leaf = leafSpec(adminAddress);
  return {
    version: 1,
    contracts: [
      ...leaf.contracts,
      { id: "vault", contract: "Vault", args: [{ kind: "ref", contract: "token" }] },
      {
        id: "vaultErc4626",
        contract: "VaultERC4626",
        args: [
          { kind: "ref", contract: "token" },
          { kind: "ref", contract: "priceOracle" },
          { kind: "literal", value: "Vault Shares" },
          { kind: "literal", value: "vTST" },
        ],
      },
    ],
  };
}

/**
 * A strictly LINEAR 3-contract chain: registry -> token (after registry) ->
 * vault (ref token). Used by the interruption/resume scenario: because each
 * contract depends on the previous one, Ignition deploys them in three
 * sequential batches (never in parallel), which makes it possible to
 * deterministically interrupt "between" batches by counting eth_estimateGas
 * calls on a wrapped provider (see resume-idempotent.e2e.test.ts).
 */
export function linearChainSpec(adminAddress: string): DeploymentSpec {
  return {
    version: 1,
    contracts: [
      { id: "registry", contract: "Registry", args: [{ kind: "literal", value: adminAddress }] },
      {
        id: "token",
        contract: "Token",
        args: [
          { kind: "literal", value: "Test Token" },
          { kind: "literal", value: "TST" },
        ],
        after: ["registry"],
      },
      { id: "vault", contract: "Vault", args: [{ kind: "ref", contract: "token" }] },
    ],
  };
}

/**
 * fullSpec() plus a brand-new leaf contract ("registry2") not present in the
 * original spec — used by the "spec change on resume" scenario.
 */
export function extendedSpec(adminAddress: string): DeploymentSpec {
  const full = fullSpec(adminAddress);
  return {
    version: 1,
    contracts: [
      ...full.contracts,
      { id: "registry2", contract: "Registry", args: [{ kind: "literal", value: adminAddress }] },
    ],
  };
}

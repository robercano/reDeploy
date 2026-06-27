/**
 * templates/builtin.ts
 *
 * Built-in template definitions for the studio template gallery.
 *
 * Contract shapes are derived from the manifest (contracts.generated.json).
 * Arg counts and names are verified against the manifest at definition time —
 * see the inline comments referencing each constructor's signature.
 *
 * ## ERC4626 Vault Stack
 *
 * Three contracts wired together:
 *   Token(name_: string, symbol_: string)
 *   PriceOracle(decimals_: uint8, initialAnswer_: int256)
 *   VaultERC4626(asset_: contract IERC20, oracle_: contract AggregatorV3Interface,
 *                name_: string, symbol_: string)
 *
 * Constructor-ref edges:
 *   Token → VaultERC4626 arg0 (asset_)
 *   PriceOracle → VaultERC4626 arg1 (oracle_)
 *
 * Required params (user must fill before deploy):
 *   Token name (arg 0), Token symbol (arg 1),
 *   PriceOracle decimals (arg 0), PriceOracle initialAnswer (arg 1).
 *   VaultERC4626 name/symbol (args 2,3) are also params.
 */

import type { Template } from "./types.js";

// ---------------------------------------------------------------------------
// ERC4626 Vault Stack
// ---------------------------------------------------------------------------

const erc4626VaultStack: Template = {
  id: "erc4626-vault-stack",
  name: "ERC4626 Vault Stack",
  description:
    "A Chainlink-oracle-priced ERC4626 vault backed by a standard ERC-20 token. " +
    "Deploys Token + PriceOracle + VaultERC4626 and wires the asset and oracle " +
    "constructor references automatically.",

  nodes: [
    {
      // Template-local id for the ERC-20 token
      id: "token",
      data: {
        deployIdSeed: "Token",
        contractName: "Token",
        // Token(name_: string, symbol_: string) — 2 args
        args: [
          { index: 0, kind: "literal", value: "" }, // name_
          { index: 1, kind: "literal", value: "" }, // symbol_
        ],
        after: [],
        configSteps: [],
        position: { x: 0, y: 0 },
      },
    },
    {
      // Template-local id for the price oracle
      id: "oracle",
      data: {
        deployIdSeed: "PriceOracle",
        contractName: "PriceOracle",
        // PriceOracle(decimals_: uint8, initialAnswer_: int256) — 2 args
        args: [
          { index: 0, kind: "literal", value: "" }, // decimals_
          { index: 1, kind: "literal", value: "" }, // initialAnswer_
        ],
        after: [],
        configSteps: [],
        position: { x: 0, y: 220 },
      },
    },
    {
      // Template-local id for the vault
      id: "vault",
      data: {
        deployIdSeed: "Vault",
        contractName: "VaultERC4626",
        // VaultERC4626(asset_: contract IERC20, oracle_: contract AggregatorV3Interface,
        //              name_: string, symbol_: string) — 4 args
        // args 0 and 1 are filled by constructor-ref edges (token → arg0, oracle → arg1)
        args: [
          { index: 0, kind: "ref",     value: "" }, // asset_     ← ref from token
          { index: 1, kind: "ref",     value: "" }, // oracle_    ← ref from oracle
          { index: 2, kind: "literal", value: "" }, // name_      (e.g. "USD Vault")
          { index: 3, kind: "literal", value: "" }, // symbol_    (e.g. "vUSD")
        ],
        after: [],
        configSteps: [],
        position: { x: 320, y: 110 },
      },
    },
  ],

  edges: [
    {
      // Token → VaultERC4626 asset_ (arg 0)
      source: "token",
      target: "vault",
      argIndex: 0,
    },
    {
      // PriceOracle → VaultERC4626 oracle_ (arg 1)
      source: "oracle",
      target: "vault",
      argIndex: 1,
    },
  ],

  params: [
    {
      nodeId: "token",
      argIndex: 0,
      label: "Token name",
      hint: 'e.g. "USD Coin"',
    },
    {
      nodeId: "token",
      argIndex: 1,
      label: "Token symbol",
      hint: 'e.g. "USDC"',
    },
    {
      nodeId: "oracle",
      argIndex: 0,
      label: "Oracle decimals",
      hint: "e.g. 8 (Chainlink USD feeds use 8 decimals)",
    },
    {
      nodeId: "oracle",
      argIndex: 1,
      label: "Oracle initial answer",
      hint: "e.g. 100000000 (= 1.00 USD at 8 decimals)",
    },
    {
      nodeId: "vault",
      argIndex: 2,
      label: "Vault share token name",
      hint: 'e.g. "USD Vault"',
    },
    {
      nodeId: "vault",
      argIndex: 3,
      label: "Vault share token symbol",
      hint: 'e.g. "vUSD"',
    },
  ],
};

// ---------------------------------------------------------------------------
// Exported built-in list
// ---------------------------------------------------------------------------

/** All built-in templates, in display order. */
export const BUILTIN_TEMPLATES: Template[] = [erc4626VaultStack];

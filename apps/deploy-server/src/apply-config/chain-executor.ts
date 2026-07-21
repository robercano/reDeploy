/**
 * Real, on-chain `ConfigExecutor` backing `POST /api/apply-config`.
 *
 * `@redeploy/config`'s `applyConfig()` deliberately ships no chain
 * implementation — callers inject a `ConfigExecutor`. This module is that
 * plug for the deploy-server, adapted from `apps/cli/src/chain.ts`'s
 * `buildConfigExecutor()` / `buildAddressBook()` (see that module's doc
 * comment for the full design rationale: ABI lookup via `@redeploy/core`'s
 * `foundryArtifactResolver`, encoding via viem, sending/confirming via the
 * same `jsonRpcProvider()` EIP-1193 signer `deploy()` uses).
 *
 * DEVIATION FROM apps/cli/src/chain.ts — grantRole role hashing
 * =================================================================
 * The CLI's `buildConfigExecutor()` passes a `grantRole` step's `call.args`
 * straight through to `encodeFunctionData` using the TARGET CONTRACT's own
 * ABI. That only works if the target contract's ABI happens to declare
 * `grantRole(bytes32,address)` verbatim by that name AND `call.args`
 * already contains the resolved `bytes32` role hash — but
 * `ConfigCall.role` (see `@redeploy/config`'s `execute/types.ts`) carries
 * the role as a plain string mnemonic (e.g. `"MINTER_ROLE"`), never a
 * pre-hashed bytes32 value, and `call.args` for a `grantRole` step contains
 * only the resolved account address (one element). This module fixes that
 * gap: for `call.kind === "grantRole"` we hash `call.role` to the bytes32
 * value OpenZeppelin's `AccessControl` expects — `keccak256(toBytes(role))`,
 * special-casing `"DEFAULT_ADMIN_ROLE"` to the zero hash — and call
 * `grantRole(bytes32,address)` via a fixed ABI fragment with args
 * `[roleBytes32, call.args[0]]`. This mirrors the hashing convention in
 * `packages/config/test/helpers/chainExecutor.ts`'s `roleToBytes32()`.
 *
 * `setX` and `wire` steps are unaffected: their `call.function` + `call.args`
 * are used as-is, encoded against the target contract's Foundry-derived ABI.
 */

import { encodeFunctionData, keccak256, toBytes, type Abi } from "viem";
import type { ConfigCall, ConfigExecutor } from "@redeploy/config";
import type { foundryArtifactResolver, jsonRpcProvider } from "@redeploy/core";

/** Type aliases mirroring apps/cli/src/deps.ts's pattern. */
export type ArtifactResolverLike = ReturnType<typeof foundryArtifactResolver>;
export type Eip1193ProviderLike = ReturnType<typeof jsonRpcProvider>;

/** Lowercased deployed address -> Solidity contract (artifact) name. */
export type AddressBook = Readonly<Record<string, string>>;

/**
 * Build an AddressBook from a DeploymentView's contracts (id/contractName/address).
 * Contracts with a null address (never completed) are skipped.
 */
export function buildAddressBook(
  contracts: ReadonlyArray<{ readonly address: string | null; readonly contractName: string }>,
): AddressBook {
  const book: Record<string, string> = {};
  for (const c of contracts) {
    if (c.address !== null) {
      book[c.address.toLowerCase()] = c.contractName;
    }
  }
  return book;
}

async function loadAbi(resolver: ArtifactResolverLike, contractName: string): Promise<Abi> {
  const artifact = await resolver.loadArtifact(contractName);
  return artifact.abi as Abi;
}

function lookupContractName(addressBook: AddressBook, address: string, context: string): string {
  const contractName = addressBook[address.toLowerCase()];
  if (contractName === undefined) {
    throw new Error(`No known contract at address ${address} (${context})`);
  }
  return contractName;
}

/** bytes32(0) — OpenZeppelin AccessControl's DEFAULT_ADMIN_ROLE. */
const DEFAULT_ADMIN_ROLE_HASH = `0x${"0".repeat(64)}` as const;

/**
 * Resolve a config-level role mnemonic (e.g. "MINTER_ROLE") to the bytes32
 * value OpenZeppelin's AccessControl expects on-chain:
 * `keccak256("MINTER_ROLE")` — except for the special-cased zero role.
 * Mirrors `packages/config/test/helpers/chainExecutor.ts`'s `roleToBytes32`.
 */
export function roleToBytes32(role: string): `0x${string}` {
  if (role === "DEFAULT_ADMIN_ROLE") {
    return DEFAULT_ADMIN_ROLE_HASH;
  }
  return keccak256(toBytes(role));
}

/** Fixed ABI fragment for OpenZeppelin AccessControl's `grantRole(bytes32,address)`. */
const GRANT_ROLE_ABI: Abi = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
  },
];

export interface BuildChainConfigExecutorOptions {
  readonly provider: Eip1193ProviderLike;
  readonly artifactResolver: ArtifactResolverLike;
  readonly addressBook: AddressBook;
  /** Poll interval between receipt checks. @default 1000 */
  readonly pollIntervalMs?: number;
  /** Max receipt-poll attempts before giving up. @default 30 */
  readonly maxPollAttempts?: number;
  /** Injectable sleep, so tests run instantly. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build a ConfigExecutor (config's on-chain write interface) backed by the
 * same EIP-1193 signer `deploy()` uses (`jsonRpcProvider()`).
 *
 * Sends the transaction via `eth_sendTransaction` (signed locally by the
 * provider — see core/src/provider/jsonRpc.ts) and polls
 * `eth_getTransactionReceipt` until the receipt is available, throwing if
 * the receipt reports a revert. `applyConfig()` only journals a step
 * complete if `execute()` resolves without throwing, so this executor
 * deliberately waits for on-chain confirmation rather than resolving on
 * broadcast alone.
 *
 * Unlike Ignition-driven deploys (which supply `gas`/fee fields themselves),
 * this hand-rolled executor is the only source of the transaction params, so
 * it must fill in a gas limit and a fee itself: `jsonRpcProvider()` (see
 * core/src/provider/jsonRpc.ts) takes the LEGACY signing branch whenever
 * `maxFeePerGas` is absent, and that branch reads `gas`/`gasPrice` verbatim
 * from the params — so both are estimated/queried here via
 * `eth_estimateGas` and `eth_gasPrice` before broadcasting.
 */
export function buildChainConfigExecutor(options: BuildChainConfigExecutorOptions): ConfigExecutor {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxPollAttempts = options.maxPollAttempts ?? 30;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async execute(call: ConfigCall): Promise<void> {
      // Resolve the target's contract name up front — throws for ANY
      // unknown target address, regardless of step kind, before any ABI
      // lookup or on-chain call is attempted.
      const contractName = lookupContractName(options.addressBook, call.target, `step "${call.stepId}"`);

      let abi: Abi;
      let functionName: string;
      let args: ConfigCall["args"];

      if (call.kind === "grantRole") {
        if (call.role === undefined) {
          throw new Error(`grantRole call for step "${call.stepId}" is missing a role`);
        }
        abi = GRANT_ROLE_ABI;
        functionName = call.function;
        args = [roleToBytes32(call.role), call.args[0]];
      } else {
        abi = await loadAbi(options.artifactResolver, contractName);
        functionName = call.function;
        args = call.args;
      }

      const data = encodeFunctionData({
        abi,
        functionName,
        args,
      } as Parameters<typeof encodeFunctionData>[0]);

      const accounts = (await options.provider.request({ method: "eth_accounts" })) as string[];
      const from = accounts[0];
      if (from === undefined) {
        throw new Error(
          `No deployer account available for step "${call.stepId}" — check the configured deployer private key`,
        );
      }

      const callTx = { from, to: call.target, data };

      // Estimate a gas limit and query a legacy gas price so the raw signed
      // tx (see core/src/provider/jsonRpc.ts) never serializes gas=0 /
      // gasPrice=0, which real nodes reject.
      const gas = (await options.provider.request({
        method: "eth_estimateGas",
        params: [callTx],
      })) as string;
      const gasPrice = (await options.provider.request({
        method: "eth_gasPrice",
        params: [],
      })) as string;

      const txHash = (await options.provider.request({
        method: "eth_sendTransaction",
        params: [{ ...callTx, gas, gasPrice }],
      })) as string;

      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        const receipt = (await options.provider.request({
          method: "eth_getTransactionReceipt",
          params: [txHash],
        })) as { status?: string } | null;

        if (receipt !== null && receipt !== undefined) {
          if (receipt.status === "0x0") {
            throw new Error(`Step "${call.stepId}" reverted on-chain (tx ${txHash})`);
          }
          return;
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(
        `Step "${call.stepId}" transaction ${txHash} did not confirm within ${maxPollAttempts} poll attempts`,
      );
    },
  };
}

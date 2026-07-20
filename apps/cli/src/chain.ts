/**
 * Glue between reDeploy's chain-agnostic ChainReader / ConfigExecutor
 * interfaces (from @redeploy/verify and @redeploy/config) and an actual
 * chain, for the `apply-config` and `verify --target config` subcommands.
 *
 * DESIGN
 * ======
 *
 * Both `ConfigExecutor` (config's write path) and `ChainReader` (verify's
 * read path) are injectable-by-design in their respective libraries — they
 * intentionally do NOT ship a chain implementation, so callers can plug in
 * ethers/viem/a mock. This module is that plug for the CLI:
 *
 *   - ABI lookup: @redeploy/core's `foundryArtifactResolver` already loads a
 *     contract's ABI by name from Foundry's `out/` — reused as-is.
 *   - Address -> contract name: read from the `DeploymentView` the `status`/
 *     `snapshot` commands already use (via `readDeployment()`), NOT
 *     reinvented here.
 *   - Encoding/decoding calls and reading state: viem (already a direct
 *     dependency of @redeploy/core, used the same way inside
 *     `core/src/provider/jsonRpc.ts`).
 *   - Sending + confirming write transactions: @redeploy/core's
 *     `jsonRpcProvider()` (the same signer used by `deploy()`), so key
 *     handling/signing is not reimplemented here either.
 *
 * No business logic (address resolution, drift comparison, journal
 * idempotency) is reimplemented — this file only adapts existing library
 * outputs to the shape the injectable interfaces require.
 */

import { createPublicClient, http, encodeFunctionData, type Abi } from "viem";
import type { ChainReader } from "@redeploy/verify";
import type { ConfigExecutor, ConfigCall } from "@redeploy/config";
import type { ArtifactResolverLike, Eip1193ProviderLike } from "./deps.js";

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
    throw new Error(
      `No known contract at address ${address} (${context}) — is DEPLOYMENT_DIR pointing at the deployment that produced this address?`,
    );
  }
  return contractName;
}

// ---------------------------------------------------------------------------
// ChainReader (read path — used by `verify --target config`)
// ---------------------------------------------------------------------------

/** Injectable read function so tests never make a real network call. */
export type ReadContractFn = (args: {
  readonly rpcUrl: string;
  readonly address: string;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args: unknown[];
}) => Promise<unknown>;

const defaultReadContract: ReadContractFn = async ({ rpcUrl, address, abi, functionName, args }) => {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return client.readContract({
    address: address as `0x${string}`,
    abi,
    functionName,
    args,
  } as Parameters<typeof client.readContract>[0]);
};

export interface BuildChainReaderOptions {
  readonly rpcUrl: string;
  readonly artifactResolver: ArtifactResolverLike;
  readonly addressBook: AddressBook;
  /** Injectable for tests; defaults to a real viem `readContract` call. */
  readonly readContract?: ReadContractFn;
}

/** Build a ChainReader (verify's on-chain read interface) backed by viem + Foundry artifacts. */
export function buildChainReader(options: BuildChainReaderOptions): ChainReader {
  const readContractFn = options.readContract ?? defaultReadContract;
  return {
    async call({ address, function: functionName, args }) {
      const contractName = lookupContractName(options.addressBook, address, "ChainReader.call");
      const abi = await loadAbi(options.artifactResolver, contractName);
      return readContractFn({
        rpcUrl: options.rpcUrl,
        address,
        abi,
        functionName,
        args: [...(args ?? [])],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// ConfigExecutor (write path — used by `apply-config`)
// ---------------------------------------------------------------------------

export interface BuildConfigExecutorOptions {
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
 * the receipt reports a revert. applyConfig() only journals a step complete
 * if `execute()` resolves without throwing, so this executor deliberately
 * waits for on-chain confirmation rather than resolving on broadcast alone.
 */
export function buildConfigExecutor(options: BuildConfigExecutorOptions): ConfigExecutor {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxPollAttempts = options.maxPollAttempts ?? 30;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async execute(call: ConfigCall): Promise<void> {
      const contractName = lookupContractName(options.addressBook, call.target, `step "${call.stepId}"`);
      const abi = await loadAbi(options.artifactResolver, contractName);

      const data = encodeFunctionData({
        abi,
        functionName: call.function,
        args: call.args,
      } as Parameters<typeof encodeFunctionData>[0]);

      const accounts = (await options.provider.request({ method: "eth_accounts" })) as string[];
      const from = accounts[0];
      if (from === undefined) {
        throw new Error(
          `No deployer account available for step "${call.stepId}" — check DEPLOYER_PRIVATE_KEY`,
        );
      }

      const txHash = (await options.provider.request({
        method: "eth_sendTransaction",
        params: [{ from, to: call.target, data }],
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

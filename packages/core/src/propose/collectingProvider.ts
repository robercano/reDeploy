/**
 * A "collecting" EIP-1193 provider used ONLY by propose/propose.ts's
 * ephemeral, in-memory Ignition run.
 *
 * DESIGN — why this exists and why it is SAFE
 * ============================================
 * Propose mode wants to reuse Ignition's REAL execution engine (dependency
 * batching, constructor-arg encoding, upgradeable-proxy expansion, CREATE
 * address computation) rather than reimplementing any of it — see this
 * package's CLAUDE.md "don't reinvent Ignition" rule. But it must NEVER
 * actually broadcast a transaction, and it must NEVER let Ignition write a
 * "complete" journal entry for a transaction nobody signed/sent yet (see
 * propose.ts's module doc for the full journal-safety argument).
 *
 * This provider satisfies both constraints by intercepting the
 * send-transaction / poll-for-receipt cycle ENTIRELY in memory:
 *   - `eth_sendTransaction` is never broadcast. The `{to, data, value}` is
 *     appended to an in-order `transactions` array (the propose-mode batch)
 *     and a locally-synthesized tx hash is returned.
 *   - `eth_getTransactionReceipt` / `eth_getTransactionByHash` answer with a
 *     synthetic "already mined" receipt for hashes THIS provider minted,
 *     computing the CREATE-predicted contract address via viem's
 *     `getContractAddress` (nonce-based, matching real EVM CREATE
 *     semantics) so downstream `ref` args resolve to a plausible address —
 *     Ignition needs this to compile/encode LATER futures that depend on
 *     EARLIER ones in the batch.
 *   - `eth_getTransactionCount` / `eth_getCode` / `eth_estimateGas` /
 *     `eth_gasPrice` / `eth_blockNumber` / `eth_getBlockByNumber` are all
 *     answered LOCALLY too, once nonces start being tracked — the real chain
 *     is deliberately NEVER consulted about addresses that only exist inside
 *     this ephemeral sandbox (they'd correctly report "no code here", which
 *     would corrupt Ignition's view of its own in-progress batch).
 *
 * The ONLY calls that ever reach the real network are ONE-TIME bootstrap
 * reads (current nonce, chain id) for each address the FIRST time it is
 * seen — done through the real `EIP1193Provider` the caller supplies. Since
 * this whole provider is discarded at the end of `propose()` and is never
 * wired to Ignition's real (disk-backed) journal loader, nothing it does can
 * ever reach — let alone corrupt — the caller's persistent `deploymentDir`.
 *
 * This mirrors the exact method surface already proven sufficient to drive a
 * REAL Ignition `deploy()` run in `test/deploy.test.ts` /
 * `test/testHelpers/fakeEip1193Provider.ts` (both use an equivalent
 * fully-local fake provider for the same reason: unit-testable, no network).
 */

import { getContractAddress } from "viem";
import type { EIP1193Provider } from "@nomicfoundation/ignition-core";

/** One transaction captured from an intercepted `eth_sendTransaction` call, in send order. */
export interface CollectedTransaction {
  /** `null` for a contract-creation transaction (Ignition's basic CREATE strategy). */
  readonly to: string | null;
  /** Calldata (or init code + encoded constructor args, for creation). */
  readonly data: string;
  /** Value in wei, as a decimal string. */
  readonly value: string;
}

export interface CollectingProviderOptions {
  /**
   * The REAL provider used ONLY for one-time bootstrap reads (starting nonce,
   * chain id) — see this module's doc. Never used to broadcast or to read
   * anything about addresses this collecting provider itself invents.
   */
  realProvider: EIP1193Provider;
}

export interface CollectingProviderResult {
  /** The EIP-1193 provider to hand to Ignition's `deploy()` in place of a real one. */
  readonly provider: EIP1193Provider;
  /**
   * The ordered batch of transactions Ignition attempted to send, in send
   * order. Populated DURING the `deploy()` call this provider is used
   * for — read this AFTER that call resolves.
   */
  readonly transactions: CollectedTransaction[];
}

/** Builds a fresh collecting provider + its (initially empty) captured-transactions array. */
export function makeCollectingProvider(options: CollectingProviderOptions): CollectingProviderResult {
  const { realProvider } = options;

  const transactions: CollectedTransaction[] = [];
  const receipts = new Map<
    string,
    {
      readonly contractAddress: string | null;
      /** The block this synthetic tx was "mined" in — FIXED at send time, never
       * recomputed from the live `blockNumber` counter (which keeps advancing
       * to simulate chain progress). Ignition derives confirmation depth as
       * `currentBlock - minedBlockNumber`; reusing the live counter here would
       * make that delta permanently 0 and hang forever waiting for
       * confirmations that can never arrive. */
      readonly minedBlockNumber: number;
      readonly from: string;
      readonly nonce: number;
    }
  >();
  const nonces = new Map<string, number>();
  const bootstrapped = new Set<string>();
  let chainIdHex: string | undefined;
  let blockNumber = 0;
  let blockNumberBootstrapped = false;
  let hashCounter = 0;

  /** Lazily fetches (once) the real starting nonce for `address` from the real provider. */
  async function ensureNonceBootstrapped(address: string): Promise<void> {
    const key = address.toLowerCase();
    if (bootstrapped.has(key)) return;
    bootstrapped.add(key);
    const startNonceHex = (await realProvider.request({
      method: "eth_getTransactionCount",
      params: [address, "latest"],
    })) as string;
    nonces.set(key, Number(BigInt(startNonceHex)));
  }

  async function ensureChainId(): Promise<string> {
    if (chainIdHex === undefined) {
      chainIdHex = (await realProvider.request({ method: "eth_chainId" })) as string;
    }
    return chainIdHex;
  }

  /**
   * Lazily seeds the ephemeral block-number counter from the REAL chain's
   * current height, plus a large safety margin.
   *
   * WHY THIS MATTERS: Ignition's nonce-sync check (`getNonceSyncMessages`,
   * run at the START of every `deploy()` call) computes
   * `confirmedBlockNumber = block.number - requiredConfirmations + 1`
   * (default `requiredConfirmations` is 5) and, if that's negative (i.e.
   * `block.number` is too low), treats EVERY nonce already used by the
   * sender as "possibly unconfirmed" and throws `WAITING_FOR_CONFIRMATIONS`
   * — exactly the failure this margin avoids. This matters specifically for
   * propose()'s RESUME case (see propose.ts): the sender's nonce is already
   * > 0 (from real prior deploys) by the time this ephemeral run starts, so
   * starting the fake block counter at "1" would spuriously trip that check
   * even though nothing is actually unconfirmed.
   */
  async function ensureBlockNumberBootstrapped(): Promise<void> {
    if (blockNumberBootstrapped) return;
    blockNumberBootstrapped = true;
    const startBlockHex = (await realProvider.request({ method: "eth_blockNumber" })) as string;
    blockNumber = Number(BigInt(startBlockHex)) + 1000;
  }

  const provider: EIP1193Provider = {
    async request({
      method,
      params,
    }: {
      method: string;
      params?: readonly unknown[] | object;
    }): Promise<unknown> {
      const p = Array.isArray(params) ? params : [];

      // Bootstrap the block-number counter (once) before handling ANY
      // request — several branches below read/increment `blockNumber`, and
      // it must be seeded from the real chain height first (see
      // ensureBlockNumberBootstrapped's doc comment).
      await ensureBlockNumberBootstrapped();

      switch (method) {
        case "hardhat_getAutomine":
        case "web3_clientVersion":
          throw new Error(`collectingProvider: unsupported method "${method}"`);

        case "eth_chainId":
          return ensureChainId();

        case "eth_accounts":
        case "eth_requestAccounts":
          // Not used for account discovery in propose mode — Ignition is
          // given `accounts` explicitly by the caller (see propose.ts).
          return [];

        case "eth_blockNumber":
          return "0x" + blockNumber.toString(16);

        case "eth_getBlockByNumber":
          blockNumber += 1;
          return {
            number: "0x" + blockNumber.toString(16),
            hash: "0x" + blockNumber.toString(16).padStart(64, "0"),
          };

        case "eth_getTransactionCount": {
          const address = p[0] as string;
          await ensureNonceBootstrapped(address);
          return "0x" + (nonces.get(address.toLowerCase()) ?? 0).toString(16);
        }

        case "eth_gasPrice":
          return "0x3b9aca00";

        case "eth_estimateGas":
          return "0x30d40";

        case "eth_getCode":
          // Always report "has code" so Ignition's own idempotency checks
          // (if any) don't second-guess a future this ephemeral run just
          // "deployed". Matches test/testHelpers/fakeEip1193Provider.ts.
          return "0x6001";

        case "eth_call":
          return "0x";

        case "eth_sendTransaction": {
          const txParams = p[0] as Record<string, unknown>;
          const from = (txParams.from as string | undefined) ?? "";
          await ensureNonceBootstrapped(from);

          const to = (txParams.to as string | null | undefined) ?? null;
          const data = (txParams.data as string | undefined) ?? "0x";
          const value =
            txParams.value !== undefined ? BigInt(txParams.value as string).toString() : "0";
          transactions.push({ to, data, value });

          const fromKey = from.toLowerCase();
          const usedNonce = nonces.get(fromKey) ?? 0;
          nonces.set(fromKey, usedNonce + 1);

          hashCounter += 1;
          const txHash = `0x${hashCounter.toString(16).padStart(4, "0")}${"fe".repeat(30)}`;

          const contractAddress =
            to === null && from !== ""
              ? getContractAddress({ from: from as `0x${string}`, nonce: BigInt(usedNonce) })
              : null;

          blockNumber += 1;
          receipts.set(txHash, {
            contractAddress,
            minedBlockNumber: blockNumber,
            from,
            nonce: usedNonce,
          });
          return txHash;
        }

        case "eth_getTransactionByHash": {
          const txHash = p[0] as string;
          const receipt = receipts.get(txHash);
          if (receipt === undefined) return null;
          const chainId = await ensureChainId();
          return {
            hash: txHash,
            blockHash: "0x" + receipt.minedBlockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.minedBlockNumber.toString(16),
            from: receipt.from,
            to: null,
            input: "0x",
            value: "0x0",
            chainId,
            nonce: "0x" + receipt.nonce.toString(16),
            gasPrice: "0x3b9aca00",
          };
        }

        case "eth_getTransactionReceipt": {
          const txHash = p[0] as string;
          const receipt = receipts.get(txHash);
          if (receipt === undefined) return null;
          return {
            blockHash: "0x" + receipt.minedBlockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.minedBlockNumber.toString(16),
            status: "0x1",
            contractAddress: receipt.contractAddress,
            logs: [],
          };
        }

        default:
          throw new Error(`collectingProvider: unhandled method "${method}"`);
      }
    },
  };

  return { provider, transactions };
}

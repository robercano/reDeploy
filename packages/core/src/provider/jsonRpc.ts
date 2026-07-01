/**
 * EIP-1193 provider factory for @redeploy/core.
 *
 * Creates a provider backed by viem that can:
 *   - Read from the chain via HTTP JSON-RPC (eth_chainId, eth_call, etc.)
 *   - Sign and send transactions using a local private key account
 *
 * The returned provider is node-safe and does NOT use any browser globals.
 * It is intended for server-side use (e.g., deploy-server, scripts).
 *
 * SECURITY
 * ========
 * The private key is consumed once to derive the viem account and is NEVER
 * stored on the returned object, logged, printed, or included in error messages.
 * The only time the private key is in memory is during `privateKeyToAccount()`
 * inside this factory call.
 */

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EIP1193Provider } from "@nomicfoundation/ignition-core";

/**
 * Options for jsonRpcProvider.
 *
 * @property rpcUrl    - Full HTTP/HTTPS RPC endpoint URL.
 * @property privateKey - 0x-prefixed 32-byte private key hex string.
 *   Used to sign transactions locally (the key is NEVER sent over the wire).
 */
export interface JsonRpcProviderOptions {
  rpcUrl: string;
  privateKey: string;
}

/**
 * Creates an EIP-1193 compatible provider that uses viem under the hood.
 *
 * IMPLEMENTATION NOTES
 * ====================
 * Ignition requires both read methods (eth_chainId, eth_call, eth_getCode, …)
 * and write/signing methods (eth_accounts, eth_sendTransaction, …). Viem's
 * `WalletClient` with a local account handles BOTH:
 *   - Read methods are forwarded to the HTTP transport as-is.
 *   - eth_accounts returns the derived account's address (no RPC call).
 *   - eth_sendTransaction / eth_signTransaction are handled locally by the
 *     account, then broadcast via the transport.
 *   - personal_sign / eth_sign / eth_signTypedData are handled by the account.
 *
 * For read-only methods that WalletClient might not forward (e.g. eth_call,
 * eth_getCode, eth_blockNumber), we create a separate PublicClient backed by
 * the same transport and try it as a fallback. In practice, viem's WalletClient
 * delegates unknown JSON-RPC methods directly to the transport, so the fallback
 * path is rarely exercised but guards against any viem version differences.
 *
 * The `request` function on a viem client returns `unknown` for raw JSON-RPC
 * calls, which matches EIP-1193's `Promise<unknown>` return type.
 *
 * @throws Error (without exposing the private key) if the private key is
 *   invalid (not a valid secp256k1 scalar).
 */
export function jsonRpcProvider({ rpcUrl, privateKey }: JsonRpcProviderOptions): EIP1193Provider {
  // Derive the account from the private key.
  // `privateKeyToAccount` validates the key. Any error thrown here does NOT
  // include the private key in its message (viem produces "Invalid private key"
  // type errors without echoing the value).
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const transport = http(rpcUrl);

  // WalletClient: handles signing (eth_sendTransaction, eth_sign, eth_accounts)
  // and forwards unknown methods to the transport.
  const walletClient = createWalletClient({
    account,
    transport,
  });

  // PublicClient: explicit fallback for read methods. In viem, PublicClient
  // is the canonical way to invoke eth_call, eth_getCode, eth_getLogs, etc.
  // We use it only if the walletClient request throws (e.g., method not
  // supported by the wallet-client path in a future viem version).
  const publicClient = createPublicClient({
    transport,
  });

  return {
    async request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
      // Type assertion: viem's EIP-1193 request method uses the same shape but
      // with its own internal branded types. We pass through as-is since the
      // underlying JSON-RPC wire format is identical.
      try {
        return await walletClient.request(
          args as Parameters<typeof walletClient.request>[0],
        );
      } catch (walletErr) {
        // If the wallet client cannot handle this method (e.g. a read-only
        // method that viem explicitly disallows on WalletClient), try the
        // public client. If both fail, rethrow the public client error.
        try {
          return await publicClient.request(
            args as Parameters<typeof publicClient.request>[0],
          );
        } catch {
          // Rethrow the original wallet error so the caller sees the most
          // relevant failure. Do NOT include privateKey or account.address
          // in error messages constructed here.
          throw walletErr;
        }
      }
    },
  };
}

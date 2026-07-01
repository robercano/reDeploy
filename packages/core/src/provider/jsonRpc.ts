/**
 * EIP-1193 provider factory for @redeploy/core.
 *
 * Creates a provider backed by viem that:
 *   - Signs transactions LOCALLY with the supplied private key account
 *   - Broadcasts signed transactions via eth_sendRawTransaction over HTTP JSON-RPC
 *   - Forwards all read-only methods verbatim to the JSON-RPC transport
 *
 * The returned provider is node-safe and does NOT use any browser globals.
 * It is intended for server-side use (e.g., deploy-server, scripts).
 *
 * DESIGN
 * ======
 * Ignition drives deploys via provider.request({method:"eth_sendTransaction",params:[{from,to,data,gas,...}]}).
 * viem's walletClient.request() is a raw passthrough to the RPC node and does NOT
 * sign locally -- local signing only happens through viem's high-level action API
 * (walletClient.sendTransaction). Therefore we implement the signing layer ourselves:
 *
 *   - eth_accounts / eth_requestAccounts  -> return [account.address] immediately (no RPC)
 *   - eth_sendTransaction                 -> sign locally, broadcast via eth_sendRawTransaction
 *   - eth_signTransaction                 -> sign locally, return signed raw tx (no broadcast)
 *   - personal_sign                       -> route to account.signMessage (params: [data, address])
 *   - eth_sign                            -> route to account.signMessage (params: [address, data])
 *   - eth_signTypedData_v4 / _v3          -> route to account.signTypedData (parse JSON param)
 *   - ALL OTHER methods                   -> forward verbatim to the transport
 *
 * SECURITY
 * ========
 * The private key is consumed once to derive the viem account and is NEVER
 * stored on the returned object, logged, printed, or included in error messages.
 * The only time the private key is in memory is during `privateKeyToAccount()`
 * inside this factory call.
 */

import {
  createPublicClient,
  http,
  type TransactionSerializableLegacy,
  type TransactionSerializableEIP1559,
} from "viem";
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
 * Local signing is performed via the viem account derived from the private key.
 * The transport is used only for read methods and for broadcasting signed transactions
 * via eth_sendRawTransaction. The node never receives an unsigned eth_sendTransaction.
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

  // PublicClient: used for all read-only RPC forwarding and for filling in
  // missing transaction fields (nonce, chainId) before signing.
  const publicClient = createPublicClient({
    transport,
  });

  /**
   * Forward a raw JSON-RPC call verbatim to the transport.
   * Used for all read-only methods and for eth_sendRawTransaction after signing.
   */
  async function forwardToTransport(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
    return publicClient.request(args as Parameters<typeof publicClient.request>[0]);
  }

  /**
   * Parse a hex string or undefined into a bigint.
   */
  function hexToBigInt(v: unknown): bigint | undefined {
    return v !== undefined ? BigInt(v as string) : undefined;
  }

  /**
   * Parse a hex number string or undefined into a JS number.
   */
  function hexToNum(v: unknown): number | undefined {
    if (v === undefined) return undefined;
    return Number(BigInt(v as string));
  }

  /**
   * Sign and optionally broadcast an eth_sendTransaction / eth_signTransaction request.
   *
   * Ignition supplies: from, to, data, gas (hex), and either gasPrice (legacy)
   * or maxFeePerGas + maxPriorityFeePerGas (EIP-1559). We fill in nonce and
   * chainId from the network if not already provided. Ignition's own fields are
   * preserved as-is (gas, nonce when set, etc.).
   *
   * @param txParams - The JSON-RPC transaction object from params[0]
   * @param broadcast - If true, broadcast via eth_sendRawTransaction and return tx hash.
   *   If false, return the signed raw transaction hex.
   */
  async function signLocallyAndMaybeSend(
    txParams: Record<string, unknown>,
    broadcast: boolean,
  ): Promise<string> {
    // Fill in nonce from the network if not provided by Ignition
    const nonce: number =
      txParams.nonce !== undefined
        ? (hexToNum(txParams.nonce) as number)
        : await publicClient.getTransactionCount({ address: account.address });

    // Fill in chainId from the network if not provided
    const chainId: number =
      txParams.chainId !== undefined
        ? (hexToNum(txParams.chainId) as number)
        : await publicClient.getChainId();

    let signedTx: `0x${string}`;

    if (txParams.maxFeePerGas !== undefined) {
      // EIP-1559 transaction
      const request: TransactionSerializableEIP1559 = {
        type: "eip1559",
        chainId,
        nonce,
        to: (txParams.to as `0x${string}` | null | undefined) ?? null,
        value: hexToBigInt(txParams.value),
        data: txParams.data as `0x${string}` | undefined,
        gas: hexToBigInt(txParams.gas),
        maxFeePerGas: hexToBigInt(txParams.maxFeePerGas)!,
        maxPriorityFeePerGas: hexToBigInt(txParams.maxPriorityFeePerGas) ?? 0n,
        accessList: (txParams.accessList as TransactionSerializableEIP1559["accessList"]) ?? [],
      };
      signedTx = await account.signTransaction(request);
    } else {
      // Legacy transaction
      const request: TransactionSerializableLegacy = {
        type: "legacy",
        chainId,
        nonce,
        to: (txParams.to as `0x${string}` | null | undefined) ?? null,
        value: hexToBigInt(txParams.value),
        data: txParams.data as `0x${string}` | undefined,
        gas: hexToBigInt(txParams.gas),
        gasPrice: hexToBigInt(txParams.gasPrice),
      };
      signedTx = await account.signTransaction(request);
    }

    if (!broadcast) {
      return signedTx;
    }

    // Broadcast via eth_sendRawTransaction -- the node never receives a raw eth_sendTransaction
    return forwardToTransport({
      method: "eth_sendRawTransaction",
      params: [signedTx],
    }) as Promise<string>;
  }

  return {
    async request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
      const { method, params } = args;
      const paramList = Array.isArray(params) ? params : [];

      switch (method) {
        // Account methods -- return the local account address without any RPC call
        case "eth_accounts":
        case "eth_requestAccounts":
          return [account.address];

        // eth_sendTransaction -- sign locally, broadcast via eth_sendRawTransaction
        case "eth_sendTransaction": {
          const txParams = paramList[0] as Record<string, unknown>;
          return signLocallyAndMaybeSend(txParams, true);
        }

        // eth_signTransaction -- sign locally, return signed raw tx (no broadcast)
        case "eth_signTransaction": {
          const txParams = paramList[0] as Record<string, unknown>;
          return signLocallyAndMaybeSend(txParams, false);
        }

        // personal_sign -- params: [data, address]
        case "personal_sign": {
          const data = paramList[0] as `0x${string}`;
          return account.signMessage({ message: { raw: data } });
        }

        // eth_sign -- params: [address, data]
        case "eth_sign": {
          const data = paramList[1] as `0x${string}`;
          return account.signMessage({ message: { raw: data } });
        }

        // eth_signTypedData_v4 / eth_signTypedData_v3 -- params: [address, typedDataJson]
        case "eth_signTypedData_v4":
        case "eth_signTypedData_v3": {
          const typedDataRaw = paramList[1] as string | Record<string, unknown>;
          const typedData =
            typeof typedDataRaw === "string"
              ? (JSON.parse(typedDataRaw) as {
                  domain: Parameters<typeof account.signTypedData>[0]["domain"];
                  types: Parameters<typeof account.signTypedData>[0]["types"];
                  primaryType: string;
                  message: Record<string, unknown>;
                })
              : (typedDataRaw as {
                  domain: Parameters<typeof account.signTypedData>[0]["domain"];
                  types: Parameters<typeof account.signTypedData>[0]["types"];
                  primaryType: string;
                  message: Record<string, unknown>;
                });
          return account.signTypedData({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          });
        }

        // All other methods -- forward verbatim to the transport
        default:
          return forwardToTransport(args);
      }
    },
  };
}

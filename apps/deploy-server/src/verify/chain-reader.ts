/**
 * Read-only, viem-backed `ChainReader` (@redeploy/verify's config-drift seam)
 * for the deploy-server.
 *
 * DESIGN
 * ======
 * `ChainReader.call({address, function, args})` needs an ABI to encode the
 * call and decode the result. We resolve the ABI from the SAME Foundry
 * artifacts the deploy flow already reads (`core.foundryArtifactResolver`),
 * keyed by contract name — the caller supplies an `address -> contractName`
 * map built from the persisted `DeploymentView` (see run-config-drift.ts).
 *
 * This reader is READ-ONLY: it never signs or sends a transaction, and
 * therefore never needs `DEPLOYER_PRIVATE_KEY` — config-drift detection must
 * work even when no deployer key is configured.
 *
 * Per-call failures (unknown address, missing ABI entry, revert, network
 * error) are all surfaced by throwing — `verifyConfig()` catches per-step
 * `ChainReader.call()` failures and turns them into a per-step "error"
 * result whose `message` is `err.message` VERBATIM, which is then returned
 * to the HTTP client as-is (see run-config-drift.ts / server.ts). This
 * reader must NOT swallow failures, but it MUST sanitize them first:
 *
 * SECURITY: viem's `readContract()` embeds the full RPC transport URL in its
 * thrown error's `.message` on ANY failure (unreachable RPC, timeout, 429,
 * or even an ordinary revert) — e.g. `"HTTP request failed.\nURL:
 * https://mainnet.infura.io/v3/<KEY>\n..."`. A production `RPC_URL`
 * routinely embeds an Infura/Alchemy API key. Since that message is
 * returned verbatim to any client hitting `/api/verify/config`, we catch
 * viem's error here and rethrow a fixed, URL-free message — this is the
 * only layer that knows the RPC URL, so sanitization has to happen right
 * here, at the source.
 */

import { createPublicClient, http } from "viem";
import type { Abi } from "viem";
import type { ChainReader } from "@redeploy/verify";

/** Minimal artifact-loader seam — satisfied by `core.foundryArtifactResolver(outDir)`. */
export interface AbiLoader {
  loadArtifact(name: string): Promise<{ abi: readonly unknown[] }>;
}

export interface CreateRpcChainReaderOptions {
  /** JSON-RPC HTTP endpoint to read from. */
  readonly rpcUrl: string;
  /** Deployed address (LOWERCASED) -> Solidity contract (artifact) name. */
  readonly addressToContractName: ReadonlyMap<string, string>;
  /** Loads the ABI for a given contract name (e.g. `core.foundryArtifactResolver(outDir)`). */
  readonly abiLoader: AbiLoader;
}

/** Strip a canonical signature's parameter list, e.g. "getFee(uint256)" -> "getFee". */
function bareFunctionName(fn: string): string {
  const idx = fn.indexOf("(");
  return idx === -1 ? fn : fn.slice(0, idx);
}

/**
 * Build a `ChainReader` (from `@redeploy/verify`) backed by a real read-only
 * JSON-RPC connection.
 */
export function createRpcChainReader(options: CreateRpcChainReaderOptions): ChainReader {
  const { rpcUrl, addressToContractName, abiLoader } = options;
  const publicClient = createPublicClient({ transport: http(rpcUrl) });

  return {
    async call({ address, function: fnName, args = [] }): Promise<unknown> {
      const contractName = addressToContractName.get(address.toLowerCase());
      if (contractName === undefined) {
        throw new Error(`No known deployed contract at address ${address}`);
      }

      const artifact = await abiLoader.loadArtifact(contractName);
      const bareFn = bareFunctionName(fnName);

      try {
        return await publicClient.readContract({
          address: address as `0x${string}`,
          abi: artifact.abi as Abi,
          functionName: bareFn,
          args: args as readonly unknown[],
        });
      } catch {
        // SECURITY: never let viem's raw error (which embeds the RPC
        // transport URL, and therefore any embedded API key) escape this
        // function — see the class doc above. Keep the message useful for
        // drift diagnosis (which read, on which contract) without the URL.
        throw new Error(`On-chain read of "${bareFn}" at ${address} failed`);
      }
    },
  };
}

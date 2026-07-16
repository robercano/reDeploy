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
 * error) are all surfaced by simply letting them throw — `verifyConfig()`
 * catches per-step `ChainReader.call()` failures and turns them into a
 * per-step "error" result; this reader must NOT swallow them itself.
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

      return publicClient.readContract({
        address: address as `0x${string}`,
        abi: artifact.abi as Abi,
        functionName: bareFn,
        args: args as readonly unknown[],
      });
    },
  };
}

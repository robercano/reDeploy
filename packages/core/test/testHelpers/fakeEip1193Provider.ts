/**
 * Minimal in-memory EIP-1193 provider + artifact resolver, sufficient to run
 * a REAL `deploy()` call (against the real Ignition engine) without a live
 * chain — used to produce a genuine `journal.jsonl` on disk for tests that
 * need to read it back (e.g. resolve/crossRef.ts's cross-network journal
 * reads). This is a trimmed-down variant of the fake provider already used
 * in test/deploy.test.ts (see that file for the fully-documented version
 * with partial-deploy/interruption support) — this copy only supports
 * straight-through successful deploys of 0-or-N-arg contracts, which is all
 * that's needed to seed a "source network" journal for cross-chain-ref tests.
 */

import type { ArtifactResolver, Artifact, EIP1193Provider } from "@nomicfoundation/ignition-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A trivial constructor ABI fragment with `numInputs` address inputs. */
function buildConstructorAbi(numInputs: number): object[] {
  const inputs = Array.from({ length: numInputs }, (_, i) => ({
    name: `arg${i}`,
    type: "address",
    internalType: "address",
  }));
  return [{ type: "constructor", inputs, stateMutability: "nonpayable" }];
}

/** A fake ArtifactResolver backed by a name -> argCount map. */
export function makeFakeArtifactResolver(argCounts: Record<string, number> = {}): ArtifactResolver {
  return {
    async loadArtifact(contractName: string): Promise<Artifact> {
      const numArgs = argCounts[contractName] ?? 0;
      return {
        contractName,
        sourceName: `contracts/${contractName}.sol`,
        bytecode: "0x60806040526000805534801561001457600080fd5b50610100806100246000396000f3fe",
        abi: buildConstructorAbi(numArgs),
        linkReferences: {},
      };
    },
    async getBuildInfo() {
      return undefined;
    },
  };
}

interface ProviderState {
  sendTxCount: number;
  blockNumber: number;
  txReceipts: Map<string, { blockNumber: number; contractAddress: string }>;
  nonces: Map<string, number>;
}

function makeProviderState(): ProviderState {
  return { sendTxCount: 0, blockNumber: 10, txReceipts: new Map(), nonces: new Map() };
}

/** Builds a healthy fake EIP-1193 provider sufficient for a basic-strategy deploy. */
export function makeFakeProvider(): EIP1193Provider {
  const state = makeProviderState();
  const CHAIN_ID = "0x7a69"; // 31337

  return {
    async request({
      method,
      params,
    }: {
      method: string;
      params?: readonly unknown[] | object;
    }): Promise<unknown> {
      const p = Array.isArray(params) ? params : [];

      switch (method) {
        case "hardhat_getAutomine":
          throw new Error("not supported");
        case "web3_clientVersion":
          throw new Error("not supported");
        case "eth_chainId":
          return CHAIN_ID;
        case "eth_accounts":
          return ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"];
        case "eth_blockNumber":
          return "0x" + state.blockNumber.toString(16);
        case "eth_getBlockByNumber": {
          state.blockNumber += 1;
          return {
            number: "0x" + state.blockNumber.toString(16),
            hash: "0x" + state.blockNumber.toString(16).padStart(64, "0"),
          };
        }
        case "eth_getTransactionCount": {
          const addr = (p[0] as string).toLowerCase();
          return "0x" + (state.nonces.get(addr) ?? 0).toString(16);
        }
        case "eth_gasPrice":
          return "0x3b9aca00";
        case "eth_estimateGas":
          return "0x30d40";
        case "eth_sendTransaction": {
          state.sendTxCount += 1;
          const txParams = p[0] as Record<string, unknown>;
          const from = (
            (txParams["from"] as string | undefined) ??
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
          ).toLowerCase();
          const nonce = state.nonces.get(from) ?? 0;
          state.nonces.set(from, nonce + 1);
          const txHash = `0x${"ab".repeat(31)}${nonce.toString(16).padStart(2, "0")}`;
          const contractAddress = `0x${(state.sendTxCount * 17).toString(16).padStart(40, "0")}`;
          state.blockNumber += 1;
          state.txReceipts.set(txHash, { blockNumber: state.blockNumber, contractAddress });
          return txHash;
        }
        case "eth_getTransactionByHash": {
          const txHash = p[0] as string;
          const receipt = state.txReceipts.get(txHash);
          if (receipt === undefined) return null;
          return {
            hash: txHash,
            blockHash: "0x" + receipt.blockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.blockNumber.toString(16),
            from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            to: null,
            input: "0x",
            value: "0x0",
            chainId: CHAIN_ID,
            nonce: "0x0",
            gasPrice: "0x3b9aca00",
          };
        }
        case "eth_getTransactionReceipt": {
          const txHash = p[0] as string;
          const receipt = state.txReceipts.get(txHash);
          if (receipt === undefined) return null;
          return {
            blockHash: "0x" + receipt.blockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.blockNumber.toString(16),
            status: "0x1",
            contractAddress: receipt.contractAddress,
            logs: [],
          };
        }
        case "eth_getCode":
          return "0x6001";
        case "eth_call":
          return "0x";
        default:
          throw new Error(`FakeProvider: unhandled method "${method}"`);
      }
    },
  };
}

export const FAKE_ACCOUNTS = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"];

export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-test-"));
}

export function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

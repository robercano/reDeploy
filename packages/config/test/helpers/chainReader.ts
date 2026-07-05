/**
 * TEST-ONLY read helpers for @redeploy/config's Anvil-backed e2e suite.
 *
 * Thin viem wrappers used to assert that on-chain state produced by
 * `applyConfig()` + a real `ConfigExecutor` actually matches what the
 * ConfigSpec declared (role granted, value set, wiring done).
 */

import { createPublicClient, http, type Abi } from "viem";
import { foundry } from "viem/chains";
import { roleToBytes32 } from "./chainExecutor.js";

const VAULT_READ_ABI: Abi = [
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "registry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
];

const ACCESS_CONTROL_READ_ABI: Abi = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

export function makeChainReader(rpcUrl: string) {
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

  return {
    async vaultFeeBps(vaultAddress: string): Promise<number> {
      const value = await publicClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_READ_ABI,
        functionName: "feeBps",
      });
      return Number(value);
    },

    async vaultRegistry(vaultAddress: string): Promise<string> {
      const value = await publicClient.readContract({
        address: vaultAddress as `0x${string}`,
        abi: VAULT_READ_ABI,
        functionName: "registry",
      });
      return (value as string).toLowerCase();
    },

    async hasRole(contractAddress: string, role: string, account: string): Promise<boolean> {
      return (await publicClient.readContract({
        address: contractAddress as `0x${string}`,
        abi: ACCESS_CONTROL_READ_ABI,
        functionName: "hasRole",
        args: [roleToBytes32(role), account as `0x${string}`],
      })) as boolean;
    },
  };
}

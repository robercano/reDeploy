/**
 * TEST-ONLY real on-chain ConfigExecutor for @redeploy/config's e2e suite.
 *
 * @redeploy/config's `applyConfig` deliberately has NO built-in on-chain
 * execution — callers must inject a `ConfigExecutor`. This module provides a
 * REAL implementation (backed by viem) that signs and broadcasts an actual
 * transaction for each `ConfigCall`, used only by this package's Anvil-backed
 * e2e tests. It is intentionally tiny: it knows how to encode exactly the
 * handful of setter functions the test fixtures expose (Vault.setFeeBps,
 * Vault.setRegistry, Token.grantRole).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  keccak256,
  toBytes,
  type Abi,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { ConfigCall, ConfigExecutor } from "../../src/index.js";

/** bytes32(0) — OpenZeppelin AccessControl's DEFAULT_ADMIN_ROLE. */
const DEFAULT_ADMIN_ROLE_HASH = `0x${"0".repeat(64)}` as const;

/**
 * Minimal ABI fragments for the setter functions used by the e2e fixtures.
 * Keyed by the ConfigCall.function name that execute.ts produces.
 */
const FUNCTION_ABIS: Record<string, Abi> = {
  setFeeBps: [
    {
      type: "function",
      name: "setFeeBps",
      stateMutability: "nonpayable",
      inputs: [{ name: "bps", type: "uint16" }],
      outputs: [],
    },
  ],
  setRegistry: [
    {
      type: "function",
      name: "setRegistry",
      stateMutability: "nonpayable",
      inputs: [{ name: "registry_", type: "address" }],
      outputs: [],
    },
  ],
  grantRole: [
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
  ],
};

/**
 * Resolve a config-level role mnemonic (e.g. "MINTER_ROLE") to the bytes32
 * value OpenZeppelin's AccessControl expects on-chain. Mirrors how the
 * fixture contracts derive their role constants in Solidity:
 * `keccak256("MINTER_ROLE")` — except for the special-cased zero role.
 */
export function roleToBytes32(role: string): `0x${string}` {
  if (role === "DEFAULT_ADMIN_ROLE") {
    return DEFAULT_ADMIN_ROLE_HASH;
  }
  return keccak256(toBytes(role));
}

/**
 * A real ConfigExecutor that signs and broadcasts an on-chain transaction for
 * every ConfigCall against a live JSON-RPC endpoint (Anvil in these tests).
 *
 * Throws (and thus never journals the step — see execute.ts) if the
 * transaction reverts or if the call's function has no registered ABI
 * fragment.
 */
export class ChainConfigExecutor implements ConfigExecutor {
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(rpcUrl: string, privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl);
    this.publicClient = createPublicClient({ chain: foundry, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: foundry, transport });
  }

  async execute(call: ConfigCall): Promise<void> {
    const abi = FUNCTION_ABIS[call.function];
    if (!abi) {
      throw new Error(
        `ChainConfigExecutor: no ABI fragment registered for function "${call.function}" (step "${call.stepId}")`,
      );
    }

    let args: ConfigCall["args"];
    if (call.kind === "grantRole") {
      if (call.role === undefined) {
        throw new Error(
          `ChainConfigExecutor: grantRole call for step "${call.stepId}" is missing a role`,
        );
      }
      args = [roleToBytes32(call.role), call.args[0]];
    } else {
      args = call.args;
    }

    const data = encodeFunctionData({ abi, functionName: call.function, args });

    const hash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: foundry,
      to: call.target as `0x${string}`,
      data,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(
        `ChainConfigExecutor: on-chain call reverted for step "${call.stepId}" (tx ${hash})`,
      );
    }
  }
}

/**
 * A ConfigExecutor wrapper that records every ConfigCall it forwards to the
 * delegate (in the order received) and can be configured to throw BEFORE
 * delegating on a specific call number (1-indexed) — simulating a crash
 * that happens before the on-chain transaction for that step is even sent.
 *
 * Used to build the "partial config + resume" scenarios against a REAL
 * executor/chain: unlike the unit tests' FakeExecutor (which never touches a
 * chain), this wrapper lets earlier steps genuinely land on-chain while a
 * later step is interrupted, so resumption can be verified both via the
 * journal AND via actual on-chain reads.
 */
export class RecordingExecutor implements ConfigExecutor {
  readonly calls: ConfigCall[] = [];
  private readonly delegate: ConfigExecutor;
  private readonly throwOnCallNumber: number | undefined;

  constructor(delegate: ConfigExecutor, throwOnCallNumber?: number) {
    this.delegate = delegate;
    this.throwOnCallNumber = throwOnCallNumber;
  }

  async execute(call: ConfigCall): Promise<void> {
    const callNumber = this.calls.length + 1;
    if (this.throwOnCallNumber !== undefined && callNumber === this.throwOnCallNumber) {
      throw new Error(
        `RecordingExecutor: simulated interruption before call #${callNumber} (step "${call.stepId}")`,
      );
    }
    await this.delegate.execute(call);
    this.calls.push(call);
  }
}

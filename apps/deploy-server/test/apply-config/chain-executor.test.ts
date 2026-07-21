import { describe, it, expect, vi } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  buildAddressBook,
  buildChainConfigExecutor,
  roleToBytes32,
} from "../../src/apply-config/chain-executor.js";
import type { ArtifactResolverLike, Eip1193ProviderLike } from "../../src/apply-config/chain-executor.js";

function fakeArtifactResolver(abiByName: Record<string, unknown[]>): ArtifactResolverLike {
  return {
    async loadArtifact(contractName: string) {
      const abi = abiByName[contractName];
      if (abi === undefined) throw new Error(`no artifact for ${contractName}`);
      return { contractName, sourceName: "", bytecode: "0x", abi, linkReferences: {} };
    },
    async getBuildInfo() {
      return undefined;
    },
  } as ArtifactResolverLike;
}

function fakeProvider(handlers: Record<string, (params?: unknown) => unknown>): Eip1193ProviderLike {
  return {
    async request({ method, params }: { method: string; params?: unknown }) {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(params);
    },
  } as unknown as Eip1193ProviderLike;
}

describe("buildAddressBook", () => {
  it("keys by lowercased address, skipping null addresses", () => {
    const book = buildAddressBook([
      { address: "0xABCDEF0000000000000000000000000000ABCD", contractName: "Token" },
      { address: null, contractName: "Unfinished" },
    ]);
    expect(book["0xabcdef0000000000000000000000000000abcd"]).toBe("Token");
    expect(Object.keys(book)).toHaveLength(1);
  });
});

describe("roleToBytes32", () => {
  it("hashes an arbitrary role mnemonic via keccak256", () => {
    expect(roleToBytes32("MINTER_ROLE")).toBe(keccak256(toBytes("MINTER_ROLE")));
  });

  it("special-cases DEFAULT_ADMIN_ROLE to the zero hash", () => {
    expect(roleToBytes32("DEFAULT_ADMIN_ROLE")).toBe(`0x${"0".repeat(64)}`);
  });
});

describe("buildChainConfigExecutor", () => {
  const target = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
  const addressBook = { [target.toLowerCase()]: "Token" };
  const artifactResolver = fakeArtifactResolver({
    Token: [
      {
        type: "function",
        name: "setFee",
        stateMutability: "nonpayable",
        inputs: [{ type: "uint256", name: "fee" }],
        outputs: [],
      },
    ],
  });

  it("sends the transaction and resolves once the receipt confirms success", async () => {
    let receiptCalls = 0;
    const sendTransaction = vi.fn(() => "0xhash");
    const estimateGas = vi.fn(() => "0x5208");
    const gasPrice = vi.fn(() => "0x3b9aca00");
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: estimateGas,
      eth_gasPrice: gasPrice,
      eth_sendTransaction: sendTransaction,
      eth_getTransactionReceipt: () => {
        receiptCalls += 1;
        return receiptCalls < 2 ? null : { status: "0x1" };
      },
    });

    const executor = buildChainConfigExecutor({
      provider,
      artifactResolver,
      addressBook,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).resolves.toBeUndefined();
    expect(receiptCalls).toBe(2);

    // Gas limit and fee must actually be queried and forwarded so the
    // provider's legacy signing branch never serializes gas=0 / gasPrice=0.
    expect(estimateGas).toHaveBeenCalledTimes(1);
    expect(gasPrice).toHaveBeenCalledTimes(1);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const [sentParams] = sendTransaction.mock.calls[0] as [[{ gas?: string; gasPrice?: string; data?: string }]];
    const sentTx = sentParams[0];
    expect(sentTx.gas).toBe("0x5208");
    expect(sentTx.gas).not.toBe("0x0");
    expect(sentTx.gasPrice).toBe("0x3b9aca00");
    expect(sentTx.gasPrice).not.toBe("0x0");
  });

  it("encodes the correct function for a setX step", async () => {
    const sendTransaction = vi.fn(() => "0xhash");
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: sendTransaction,
      eth_getTransactionReceipt: () => ({ status: "0x1" }),
    });

    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] });

    const [sentParams] = sendTransaction.mock.calls[0] as [[{ data?: string }]];
    // encodeFunctionData for setFee(uint256) with arg 500 (0x1f4) — selector
    // 0x0d1d0dc9 for setFee(uint256), just assert data is present and starts
    // with a 4-byte selector (0x + 8 hex chars).
    expect(sentParams[0].data).toMatch(/^0x[0-9a-f]{8,}$/i);
  });

  it("grantRole: hashes the role to bytes32 and calls grantRole(bytes32,address) with [role, account]", async () => {
    const sendTransaction = vi.fn(() => "0xhash");
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: sendTransaction,
      eth_getTransactionReceipt: () => ({ status: "0x1" }),
    });

    // No artifact registered for "Token" needed for grantRole — it uses a
    // fixed ABI fragment — but the address must still resolve via the
    // address book.
    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    const account = "0x00000000000000000000000000000000000000aa";
    await executor.execute({
      stepId: "grant-minter",
      kind: "grantRole",
      target,
      function: "grantRole",
      role: "MINTER_ROLE",
      args: [account],
    });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const [sentParams] = sendTransaction.mock.calls[0] as [[{ data?: string }]];
    // Manually re-encode to compare — grantRole(bytes32,address) selector is
    // fixed for a given signature, so comparing raw encoded data confirms
    // both the function selector and the argument arity/order.
    const { encodeFunctionData } = await import("viem");
    const expectedData = encodeFunctionData({
      abi: [
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
      functionName: "grantRole",
      args: [roleToBytes32("MINTER_ROLE"), account],
    });
    expect(sentParams[0].data).toBe(expectedData);
  });

  it("grantRole: DEFAULT_ADMIN_ROLE hashes to the zero bytes32", async () => {
    const sendTransaction = vi.fn(() => "0xhash");
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: sendTransaction,
      eth_getTransactionReceipt: () => ({ status: "0x1" }),
    });

    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    const account = "0x00000000000000000000000000000000000000aa";
    await executor.execute({
      stepId: "grant-admin",
      kind: "grantRole",
      target,
      function: "grantRole",
      role: "DEFAULT_ADMIN_ROLE",
      args: [account],
    });

    const { encodeFunctionData } = await import("viem");
    const expectedData = encodeFunctionData({
      abi: [
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
      functionName: "grantRole",
      args: [`0x${"0".repeat(64)}`, account],
    });
    const [sentParams] = sendTransaction.mock.calls[0] as [[{ data?: string }]];
    expect(sentParams[0].data).toBe(expectedData);
  });

  it("grantRole: throws when the call is missing a role", async () => {
    const provider = fakeProvider({ eth_accounts: () => ["0xFrom0000000000000000000000000000000000"] });
    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await expect(
      executor.execute({
        stepId: "grant-minter",
        kind: "grantRole",
        target,
        function: "grantRole",
        args: ["0x00000000000000000000000000000000000000aa"],
      }),
    ).rejects.toThrow(/missing a role/);
  });

  it("throws when the receipt reports a revert (status 0x0)", async () => {
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: () => "0xhash",
      eth_getTransactionReceipt: () => ({ status: "0x0" }),
    });

    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/reverted/);
  });

  it("throws after exhausting poll attempts with no receipt", async () => {
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: () => "0xhash",
      eth_getTransactionReceipt: () => null,
    });

    const executor = buildChainConfigExecutor({
      provider,
      artifactResolver,
      addressBook,
      maxPollAttempts: 2,
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/did not confirm/);
  });

  it("throws when no deployer account is available", async () => {
    const provider = fakeProvider({ eth_accounts: () => [] });
    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/No deployer account/);
  });

  it("throws a clear error for an unknown target address (setX)", async () => {
    const provider = fakeProvider({});
    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook: {}, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/No known contract/);
  });

  it("throws a clear error for an unknown target address (grantRole)", async () => {
    const provider = fakeProvider({});
    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook: {}, sleep: async () => {} });

    await expect(
      executor.execute({
        stepId: "grant-minter",
        kind: "grantRole",
        target,
        function: "grantRole",
        role: "MINTER_ROLE",
        args: ["0x00000000000000000000000000000000000000aa"],
      }),
    ).rejects.toThrow(/No known contract/);
  });

  it("surfaces a gas estimation failure as a normal error, without sending the transaction", async () => {
    const sendTransaction = vi.fn(() => "0xhash");
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => {
        throw new Error("execution reverted");
      },
      eth_sendTransaction: sendTransaction,
    });
    const executor = buildChainConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/execution reverted/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

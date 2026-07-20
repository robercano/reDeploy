import { describe, it, expect, vi } from "vitest";
import { buildAddressBook, buildChainReader, buildConfigExecutor } from "../src/chain.js";
import type { ArtifactResolverLike, Eip1193ProviderLike } from "../src/deps.js";

const TOKEN_ABI = [
  {
    type: "function",
    name: "getFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
  },
];

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

describe("buildChainReader", () => {
  const address = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
  const addressBook = { [address.toLowerCase()]: "Token" };

  it("resolves the ABI via the artifact resolver and delegates to the injected readContract", async () => {
    const readContract = vi.fn().mockResolvedValue(500n);
    const reader = buildChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      artifactResolver: fakeArtifactResolver({ Token: TOKEN_ABI }),
      addressBook,
      readContract,
    });

    const result = await reader.call({ address, function: "getFee", args: [] });

    expect(result).toBe(500n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address, functionName: "getFee", args: [] }),
    );
  });

  it("throws a clear error for an address not in the address book", async () => {
    const reader = buildChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      artifactResolver: fakeArtifactResolver({}),
      addressBook: {},
      readContract: vi.fn(),
    });

    await expect(reader.call({ address, function: "getFee" })).rejects.toThrow(/No known contract/);
  });

  it("defaults args to an empty array when omitted", async () => {
    const readContract = vi.fn().mockResolvedValue(true);
    const reader = buildChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      artifactResolver: fakeArtifactResolver({ Token: TOKEN_ABI }),
      addressBook,
      readContract,
    });
    await reader.call({ address, function: "getFee" });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ args: [] }));
  });
});

function fakeProvider(handlers: Record<string, (params?: unknown) => unknown>): Eip1193ProviderLike {
  return {
    async request({ method, params }: { method: string; params?: unknown }) {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(params);
    },
  } as unknown as Eip1193ProviderLike;
}

describe("buildConfigExecutor", () => {
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

    const executor = buildConfigExecutor({
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
    // provider's legacy signing branch (core/src/provider/jsonRpc.ts) never
    // serializes gas=0 / gasPrice=0 into the raw signed transaction.
    expect(estimateGas).toHaveBeenCalledTimes(1);
    expect(gasPrice).toHaveBeenCalledTimes(1);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const [sentParams] = sendTransaction.mock.calls[0] as [[{ gas?: string; gasPrice?: string }]];
    const sentTx = sentParams[0];
    expect(sentTx.gas).toBe("0x5208");
    expect(sentTx.gas).not.toBe("0x0");
    expect(sentTx.gasPrice).toBe("0x3b9aca00");
    expect(sentTx.gasPrice).not.toBe("0x0");
  });

  it("throws when the receipt reports a revert (status 0x0)", async () => {
    const provider = fakeProvider({
      eth_accounts: () => ["0xFrom0000000000000000000000000000000000"],
      eth_estimateGas: () => "0x5208",
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: () => "0xhash",
      eth_getTransactionReceipt: () => ({ status: "0x0" }),
    });

    const executor = buildConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

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

    const executor = buildConfigExecutor({
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
    const executor = buildConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/No deployer account/);
  });

  it("throws a clear error for an unknown target address", async () => {
    const provider = fakeProvider({});
    const executor = buildConfigExecutor({ provider, artifactResolver, addressBook: {}, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
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
    const executor = buildConfigExecutor({ provider, artifactResolver, addressBook, sleep: async () => {} });

    await expect(
      executor.execute({ stepId: "set-fee", kind: "setX", target, function: "setFee", args: [500] }),
    ).rejects.toThrow(/execution reverted/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

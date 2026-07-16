/**
 * Tests for chain-reader.ts's createRpcChainReader().
 *
 * viem is mocked (mirroring packages/core/test/jsonRpc.test.ts's pattern) so
 * no real RPC connection is required. We assert the reader correctly:
 *   - resolves the ABI via the injected abiLoader, keyed off the address's
 *     known contract name
 *   - strips a canonical signature's parameter list before calling readContract
 *   - throws (does not swallow) when the address is unknown, or when
 *     readContract itself throws — verifyConfig() relies on these throwing so
 *     it can turn them into per-step "error" results.
 *   - SECURITY: sanitizes readContract failures before rethrowing — viem
 *     embeds the RPC transport URL (which may carry an API key) in its raw
 *     error message, and that message is returned verbatim to HTTP clients
 *     by /api/verify/config, so it must never reach the caller unsanitized.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const readContractSpy = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem")>();
  return {
    ...original,
    createPublicClient: vi.fn(() => ({
      readContract: (...args: unknown[]) => readContractSpy(...args),
    })),
    http: vi.fn((url: string) => ({ type: "http", url })),
  };
});

import { createRpcChainReader } from "../../src/verify/chain-reader.js";

const ADDRESS = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";

beforeEach(() => {
  readContractSpy.mockReset();
});

describe("createRpcChainReader", () => {
  it("resolves the ABI via abiLoader (keyed by lowercased address) and calls readContract", async () => {
    const fakeAbi = [{ type: "function", name: "getFee", inputs: [], outputs: [] }];
    const loadArtifact = vi.fn().mockResolvedValue({ abi: fakeAbi });
    readContractSpy.mockResolvedValue(500n);

    const reader = createRpcChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      addressToContractName: new Map([[ADDRESS.toLowerCase(), "FeeController"]]),
      abiLoader: { loadArtifact },
    });

    const result = await reader.call({ address: ADDRESS, function: "getFee", args: [] });

    expect(result).toBe(500n);
    expect(loadArtifact).toHaveBeenCalledWith("FeeController");
    expect(readContractSpy).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS, abi: fakeAbi, functionName: "getFee", args: [] }),
    );
  });

  it("strips a canonical signature's parameter list before calling readContract", async () => {
    const loadArtifact = vi.fn().mockResolvedValue({ abi: [] });
    readContractSpy.mockResolvedValue(1n);

    const reader = createRpcChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      addressToContractName: new Map([[ADDRESS.toLowerCase(), "Vault"]]),
      abiLoader: { loadArtifact },
    });

    await reader.call({ address: ADDRESS, function: "getLimit(uint256)", args: [1] });

    expect(readContractSpy).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getLimit" }));
  });

  it("throws for an address not in addressToContractName", async () => {
    const reader = createRpcChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      addressToContractName: new Map(),
      abiLoader: { loadArtifact: vi.fn() },
    });

    await expect(reader.call({ address: ADDRESS, function: "getFee" })).rejects.toThrow(/No known deployed contract/);
  });

  it("propagates a readContract failure (never swallows it), sanitized", async () => {
    const loadArtifact = vi.fn().mockResolvedValue({ abi: [] });
    readContractSpy.mockRejectedValue(new Error("execution reverted"));

    const reader = createRpcChainReader({
      rpcUrl: "http://127.0.0.1:8545",
      addressToContractName: new Map([[ADDRESS.toLowerCase(), "Vault"]]),
      abiLoader: { loadArtifact },
    });

    // Still throws (verifyConfig() relies on this to produce a per-step
    // "error" result) — but the sanitized message names the failed call
    // instead of forwarding viem's raw error text verbatim.
    await expect(reader.call({ address: ADDRESS, function: "getLimit" })).rejects.toThrow(
      `On-chain read of "getLimit" at ${ADDRESS} failed`,
    );
  });

  it("SECURITY: never forwards viem's raw error message (which may embed the RPC URL/API key)", async () => {
    const loadArtifact = vi.fn().mockResolvedValue({ abi: [] });
    const SENTINEL_URL = "http://secret-rpc.internal.example.com/v3/SENTINELKEY123";
    // Mirrors viem's real HttpRequestError shape: the transport URL (and any
    // embedded API key) is baked into the thrown error's `.message`.
    readContractSpy.mockRejectedValue(
      new Error(`HTTP request failed.\n\nURL: ${SENTINEL_URL}\n\nRequest body: {"method":"eth_call"}`),
    );

    const reader = createRpcChainReader({
      rpcUrl: SENTINEL_URL,
      addressToContractName: new Map([[ADDRESS.toLowerCase(), "Vault"]]),
      abiLoader: { loadArtifact },
    });

    let caught: unknown;
    try {
      await reader.call({ address: ADDRESS, function: "getLimit" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("SENTINELKEY123");
    expect((caught as Error).message).not.toContain("secret-rpc.internal.example.com");
  });
});

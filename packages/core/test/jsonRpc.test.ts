/**
 * Tests for jsonRpcProvider().
 *
 * Strategy: mock viem at the module level via vi.mock so no actual HTTP
 * connections are made. We capture the `request` function that viem's wallet
 * client would use and assert that:
 *   1. jsonRpcProvider returns an object with a `request` method (EIP-1193 shape).
 *   2. Calling request() with any JSON-RPC method/params forwards those exact
 *      args to the underlying transport/client.
 *   3. Both "read" methods (eth_chainId) and "write/sign" methods
 *      (eth_sendTransaction) are forwarded correctly.
 *   4. The private key does NOT appear in any thrown error message.
 *
 * All tests pass fully offline — no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Viem mock setup
// ---------------------------------------------------------------------------

// We intercept viem's module so that `createWalletClient` and `createPublicClient`
// return spy objects with a controllable `request` function.

// These are set inside beforeEach so each test gets fresh spies.
let walletRequestSpy: Mock;
let publicRequestSpy: Mock;

vi.mock("viem", async (importOriginal) => {
  // Keep original types / exports that the test file doesn't need to call
  const original = await importOriginal<typeof import("viem")>();
  return {
    ...original,
    createWalletClient: vi.fn(() => ({
      request: (...args: unknown[]) => walletRequestSpy(...args),
    })),
    createPublicClient: vi.fn(() => ({
      request: (...args: unknown[]) => publicRequestSpy(...args),
    })),
    http: vi.fn((url: string) => ({ type: "http", url })),
  };
});

vi.mock("viem/accounts", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem/accounts")>();
  return {
    ...original,
    privateKeyToAccount: vi.fn((key: string) => ({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      _key: key, // stored only on the mock object, not on the real account
    })),
  };
});

// Import AFTER mock setup so the mock is in place
import { jsonRpcProvider } from "../src/index.js";

// ---------------------------------------------------------------------------
// Constants for tests
// ---------------------------------------------------------------------------

// A well-formed fake private key (never used for actual signing)
const FAKE_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FAKE_RPC_URL = "http://localhost:8545";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  walletRequestSpy = vi.fn();
  publicRequestSpy = vi.fn();
});

// ---------------------------------------------------------------------------
// Shape / interface compliance
// ---------------------------------------------------------------------------

describe("jsonRpcProvider — interface shape", () => {
  it("returns an object with a request method (EIP-1193 shape)", () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    expect(provider).toBeDefined();
    expect(typeof provider.request).toBe("function");
  });

  it("request method returns a Promise", () => {
    walletRequestSpy.mockResolvedValueOnce("0x1");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = provider.request({ method: "eth_chainId" });

    expect(result).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// Forwarding — read methods
// ---------------------------------------------------------------------------

describe("jsonRpcProvider — read method forwarding", () => {
  it("forwards eth_chainId to the wallet client", async () => {
    walletRequestSpy.mockResolvedValueOnce("0x7a69");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_chainId" });

    expect(result).toBe("0x7a69");
    expect(walletRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_chainId" }),
    );
  });

  it("forwards eth_blockNumber correctly", async () => {
    walletRequestSpy.mockResolvedValueOnce("0xabcd");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_blockNumber" });

    expect(result).toBe("0xabcd");
  });

  it("forwards eth_call with params", async () => {
    const expectedResult = "0x0000000000000000000000000000000000000000000000000000000000000001";
    walletRequestSpy.mockResolvedValueOnce(expectedResult);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const callParams = [{ to: "0x1234", data: "0xabcd" }, "latest"];
    const result = await provider.request({ method: "eth_call", params: callParams });

    expect(result).toBe(expectedResult);
    expect(walletRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_call", params: callParams }),
    );
  });

  it("forwards eth_getTransactionReceipt", async () => {
    const receipt = { status: "0x1", contractAddress: null };
    walletRequestSpy.mockResolvedValueOnce(receipt);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({
      method: "eth_getTransactionReceipt",
      params: ["0xabcdef"],
    });

    expect(result).toEqual(receipt);
  });
});

// ---------------------------------------------------------------------------
// Forwarding — write/sign methods
// ---------------------------------------------------------------------------

describe("jsonRpcProvider — write/sign method forwarding", () => {
  it("forwards eth_sendTransaction to the wallet client", async () => {
    const fakeTxHash = "0x" + "ab".repeat(32);
    walletRequestSpy.mockResolvedValueOnce(fakeTxHash);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const txParams = [{ from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", to: "0x1234", value: "0x0" }];
    const result = await provider.request({ method: "eth_sendTransaction", params: txParams });

    expect(result).toBe(fakeTxHash);
    expect(walletRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_sendTransaction", params: txParams }),
    );
  });

  it("forwards eth_accounts", async () => {
    walletRequestSpy.mockResolvedValueOnce(["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"]);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_accounts" });

    expect(result).toEqual(["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"]);
  });
});

// ---------------------------------------------------------------------------
// Fallback to public client
// ---------------------------------------------------------------------------

describe("jsonRpcProvider — public client fallback", () => {
  it("falls back to public client when wallet client throws", async () => {
    // Wallet client fails (e.g. method not supported by wallet path)
    walletRequestSpy.mockRejectedValueOnce(new Error("Method not supported"));
    // Public client succeeds
    publicRequestSpy.mockResolvedValueOnce("0x1");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_chainId" });

    expect(result).toBe("0x1");
    expect(publicRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_chainId" }),
    );
  });

  it("re-throws the wallet client error when both clients fail", async () => {
    const walletError = new Error("Wallet client failure");
    walletRequestSpy.mockRejectedValueOnce(walletError);
    publicRequestSpy.mockRejectedValueOnce(new Error("Public client failure too"));

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    await expect(provider.request({ method: "eth_chainId" })).rejects.toThrow(
      "Wallet client failure",
    );
  });
});

// ---------------------------------------------------------------------------
// Security: private key must not leak into error messages
// ---------------------------------------------------------------------------

describe("jsonRpcProvider — private key security", () => {
  it("does not include the private key in error messages on request failure", async () => {
    const walletError = new Error("Connection refused");
    walletRequestSpy.mockRejectedValueOnce(walletError);
    publicRequestSpy.mockRejectedValueOnce(new Error("Also failed"));

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    let thrownError: Error | undefined;
    try {
      await provider.request({ method: "eth_chainId" });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    // The private key must NOT appear in any error message
    expect(thrownError!.message).not.toContain(FAKE_PRIVATE_KEY);
    // Neither the key without the 0x prefix
    expect(thrownError!.message).not.toContain(FAKE_PRIVATE_KEY.slice(2));
  });

  it("does not expose the private key in the returned provider object", () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    // The returned object should only have request — no key, no account
    const keys = Object.keys(provider);
    expect(keys).toEqual(["request"]);

    // Serializing the provider should not include the private key
    const serialized = JSON.stringify(provider);
    expect(serialized).not.toContain(FAKE_PRIVATE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Exact method + params forwarding
// ---------------------------------------------------------------------------

describe("jsonRpcProvider — exact forwarding of method and params", () => {
  it("forwards method and params without modification", async () => {
    const expectedReturn = "0xdeadbeef";
    walletRequestSpy.mockResolvedValueOnce(expectedReturn);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const methodArgs = {
      method: "eth_getBalance",
      params: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "latest"],
    };
    const result = await provider.request(methodArgs);

    expect(result).toBe(expectedReturn);
    expect(walletRequestSpy).toHaveBeenCalledTimes(1);
    expect(walletRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "eth_getBalance",
        params: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "latest"],
      }),
    );
  });

  it("returns undefined when client returns undefined", async () => {
    walletRequestSpy.mockResolvedValueOnce(undefined);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_getCode", params: ["0x1234", "latest"] });

    expect(result).toBeUndefined();
  });
});

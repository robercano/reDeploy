/**
 * Tests for jsonRpcProvider().
 *
 * Strategy: mock viem and viem/accounts at the module level via vi.mock so no
 * actual HTTP connections are made. We assert that:
 *   1. jsonRpcProvider returns an EIP-1193 shaped object.
 *   2. eth_accounts / eth_requestAccounts return [account.address] WITHOUT hitting
 *      the transport (purely local).
 *   3. eth_sendTransaction causes LOCAL signing via account.signTransaction and
 *      broadcasts via eth_sendRawTransaction -- the node NEVER receives a raw
 *      eth_sendTransaction.
 *   4. eth_signTransaction causes LOCAL signing and returns the signed tx (no broadcast).
 *   5. personal_sign / eth_sign route to account.signMessage locally.
 *   6. eth_signTypedData_v4 / _v3 route to account.signTypedData locally.
 *   7. Read methods forward verbatim to the transport.
 *   8. The private key does NOT appear in any thrown error message.
 *   9. The returned provider object exposes ONLY the `request` method.
 *
 * All tests pass fully offline -- no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Viem mock setup
// ---------------------------------------------------------------------------

let transportRequestSpy: Mock;
let signTransactionSpy: Mock;
let signMessageSpy: Mock;
let signTypedDataSpy: Mock;
let getTransactionCountSpy: Mock;
let getChainIdSpy: Mock;

const FAKE_ACCOUNT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

vi.mock("viem", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem")>();
  return {
    ...original,
    createPublicClient: vi.fn(() => ({
      request: (...args: unknown[]) => transportRequestSpy(...args),
      getTransactionCount: (...args: unknown[]) => getTransactionCountSpy(...args),
      getChainId: (...args: unknown[]) => getChainIdSpy(...args),
    })),
    http: vi.fn((url: string) => ({ type: "http", url })),
  };
});

vi.mock("viem/accounts", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem/accounts")>();
  return {
    ...original,
    privateKeyToAccount: vi.fn(() => ({
      address: FAKE_ACCOUNT_ADDRESS,
      signTransaction: (...args: unknown[]) => signTransactionSpy(...args),
      signMessage: (...args: unknown[]) => signMessageSpy(...args),
      signTypedData: (...args: unknown[]) => signTypedDataSpy(...args),
    })),
  };
});

import { jsonRpcProvider } from "../src/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FAKE_RPC_URL = "http://localhost:8545";
const FAKE_SIGNED_TX = "0x02f8748201c884028fa6aa8502540be4008252089412345678deadbeef00000000000000000000000087038d7ea4c6800080c001a0aabb00112233445566778899a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9a001122334455667788" as `0x${string}`;
const FAKE_TX_HASH = "0x" + "ab".repeat(32);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  transportRequestSpy = vi.fn();
  signTransactionSpy = vi.fn();
  signMessageSpy = vi.fn();
  signTypedDataSpy = vi.fn();
  getTransactionCountSpy = vi.fn().mockResolvedValue(5);
  getChainIdSpy = vi.fn().mockResolvedValue(1);
});

// ---------------------------------------------------------------------------
// Shape / interface compliance
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- interface shape", () => {
  it("returns an object with a request method (EIP-1193 shape)", () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    expect(provider).toBeDefined();
    expect(typeof provider.request).toBe("function");
  });

  it("request method returns a Promise", () => {
    transportRequestSpy.mockResolvedValueOnce("0x1");
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = provider.request({ method: "eth_chainId" });
    expect(result).toBeInstanceOf(Promise);
  });

  it("returned provider object exposes ONLY a request method", () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    expect(Object.keys(provider)).toEqual(["request"]);
  });
});

// ---------------------------------------------------------------------------
// eth_accounts / eth_requestAccounts -- local, no RPC
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- eth_accounts returns local address without hitting the transport", () => {
  it("eth_accounts returns [account.address] without calling the transport", async () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_accounts" });

    expect(result).toEqual([FAKE_ACCOUNT_ADDRESS]);
    expect(transportRequestSpy).not.toHaveBeenCalled();
  });

  it("eth_requestAccounts returns [account.address] without calling the transport", async () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_requestAccounts" });

    expect(result).toEqual([FAKE_ACCOUNT_ADDRESS]);
    expect(transportRequestSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// eth_sendTransaction -- LOCAL signing, broadcast via eth_sendRawTransaction
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- eth_sendTransaction: local signing, broadcast via eth_sendRawTransaction", () => {
  it("calls account.signTransaction locally (node never receives eth_sendTransaction)", async () => {
    signTransactionSpy.mockResolvedValueOnce(FAKE_SIGNED_TX);
    transportRequestSpy.mockResolvedValueOnce(FAKE_TX_HASH);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const txParams = {
      from: FAKE_ACCOUNT_ADDRESS,
      to: "0x1234567890123456789012345678901234567890",
      data: "0xabcdef",
      gas: "0x5208",
      gasPrice: "0x3b9aca00",
    };
    const result = await provider.request({ method: "eth_sendTransaction", params: [txParams] });

    // account.signTransaction must have been called
    expect(signTransactionSpy).toHaveBeenCalledTimes(1);
    expect(signTransactionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "legacy",
        gas: BigInt("0x5208"),
        gasPrice: BigInt("0x3b9aca00"),
      }),
    );

    // Transport must ONLY have been called with eth_sendRawTransaction, never eth_sendTransaction
    const allTransportMethods = transportRequestSpy.mock.calls.map(
      (call) => (call[0] as { method: string }).method,
    );
    expect(allTransportMethods).not.toContain("eth_sendTransaction");
    expect(allTransportMethods).toContain("eth_sendRawTransaction");

    // The signed tx must be passed to eth_sendRawTransaction
    const sendRawCall = transportRequestSpy.mock.calls.find(
      (call) => (call[0] as { method: string }).method === "eth_sendRawTransaction",
    );
    expect(sendRawCall?.[0]).toMatchObject({
      method: "eth_sendRawTransaction",
      params: [FAKE_SIGNED_TX],
    });

    expect(result).toBe(FAKE_TX_HASH);
  });

  it("fills in nonce from the network when not provided by Ignition", async () => {
    getTransactionCountSpy.mockResolvedValueOnce(7);
    signTransactionSpy.mockResolvedValueOnce(FAKE_SIGNED_TX);
    transportRequestSpy.mockResolvedValueOnce(FAKE_TX_HASH);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: FAKE_ACCOUNT_ADDRESS, to: "0x1234", gas: "0x5208", gasPrice: "0x1" }],
    });

    expect(signTransactionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 7 }),
    );
  });

  it("uses nonce from Ignition if already provided", async () => {
    signTransactionSpy.mockResolvedValueOnce(FAKE_SIGNED_TX);
    transportRequestSpy.mockResolvedValueOnce(FAKE_TX_HASH);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: FAKE_ACCOUNT_ADDRESS, to: "0x1234", nonce: "0x3", gas: "0x5208", gasPrice: "0x1" }],
    });

    expect(getTransactionCountSpy).not.toHaveBeenCalled();
    expect(signTransactionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 3 }),
    );
  });

  it("uses EIP-1559 tx type when maxFeePerGas is present", async () => {
    signTransactionSpy.mockResolvedValueOnce(FAKE_SIGNED_TX);
    transportRequestSpy.mockResolvedValueOnce(FAKE_TX_HASH);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    await provider.request({
      method: "eth_sendTransaction",
      params: [{
        from: FAKE_ACCOUNT_ADDRESS,
        to: "0x1234",
        gas: "0x5208",
        maxFeePerGas: "0x77359400",
        maxPriorityFeePerGas: "0x3b9aca00",
      }],
    });

    expect(signTransactionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "eip1559",
        maxFeePerGas: BigInt("0x77359400"),
        maxPriorityFeePerGas: BigInt("0x3b9aca00"),
      }),
    );

    const allTransportMethods = transportRequestSpy.mock.calls.map(
      (call) => (call[0] as { method: string }).method,
    );
    expect(allTransportMethods).not.toContain("eth_sendTransaction");
    expect(allTransportMethods).toContain("eth_sendRawTransaction");
  });
});

// ---------------------------------------------------------------------------
// eth_signTransaction -- LOCAL signing, no broadcast
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- eth_signTransaction: local signing, no broadcast", () => {
  it("returns the signed raw tx without broadcasting", async () => {
    signTransactionSpy.mockResolvedValueOnce(FAKE_SIGNED_TX);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({
      method: "eth_signTransaction",
      params: [{ from: FAKE_ACCOUNT_ADDRESS, to: "0x1234", gas: "0x5208", gasPrice: "0x1" }],
    });

    expect(signTransactionSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe(FAKE_SIGNED_TX);

    const allTransportMethods = transportRequestSpy.mock.calls.map(
      (call) => (call[0] as { method: string }).method,
    );
    expect(allTransportMethods).not.toContain("eth_sendRawTransaction");
  });
});

// ---------------------------------------------------------------------------
// personal_sign / eth_sign -- local message signing
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- personal_sign / eth_sign: local message signing", () => {
  it("personal_sign routes to account.signMessage with data from params[0]", async () => {
    const fakeSignature = "0xdeadbeef";
    signMessageSpy.mockResolvedValueOnce(fakeSignature);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const data = "0x68656c6c6f";
    const result = await provider.request({
      method: "personal_sign",
      params: [data, FAKE_ACCOUNT_ADDRESS],
    });

    expect(signMessageSpy).toHaveBeenCalledWith({ message: { raw: data } });
    expect(transportRequestSpy).not.toHaveBeenCalled();
    expect(result).toBe(fakeSignature);
  });

  it("eth_sign routes to account.signMessage with data from params[1]", async () => {
    const fakeSignature = "0xcafebabe";
    signMessageSpy.mockResolvedValueOnce(fakeSignature);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const data = "0x68656c6c6f";
    const result = await provider.request({
      method: "eth_sign",
      params: [FAKE_ACCOUNT_ADDRESS, data],
    });

    expect(signMessageSpy).toHaveBeenCalledWith({ message: { raw: data } });
    expect(transportRequestSpy).not.toHaveBeenCalled();
    expect(result).toBe(fakeSignature);
  });
});

// ---------------------------------------------------------------------------
// eth_signTypedData_v4 / _v3 -- local typed data signing
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- eth_signTypedData_v4: local typed-data signing", () => {
  const typedDataObject = {
    domain: { name: "TestApp", version: "1", chainId: 1 },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      Permit: [{ name: "owner", type: "address" }],
    },
    primaryType: "Permit",
    message: { owner: FAKE_ACCOUNT_ADDRESS },
  };

  it("eth_signTypedData_v4 with JSON string param routes to account.signTypedData", async () => {
    const fakeSig = "0xaabbccdd";
    signTypedDataSpy.mockResolvedValueOnce(fakeSig);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({
      method: "eth_signTypedData_v4",
      params: [FAKE_ACCOUNT_ADDRESS, JSON.stringify(typedDataObject)],
    });

    expect(signTypedDataSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: typedDataObject.domain,
        primaryType: typedDataObject.primaryType,
      }),
    );
    expect(transportRequestSpy).not.toHaveBeenCalled();
    expect(result).toBe(fakeSig);
  });

  it("eth_signTypedData_v3 also routes to account.signTypedData", async () => {
    const fakeSig = "0x11223344";
    signTypedDataSpy.mockResolvedValueOnce(fakeSig);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    await provider.request({
      method: "eth_signTypedData_v3",
      params: [FAKE_ACCOUNT_ADDRESS, JSON.stringify(typedDataObject)],
    });

    expect(signTypedDataSpy).toHaveBeenCalledTimes(1);
    expect(transportRequestSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Read method forwarding -- verbatim to transport
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- read methods forward verbatim to transport", () => {
  it("forwards eth_chainId to the transport", async () => {
    transportRequestSpy.mockResolvedValueOnce("0x7a69");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_chainId" });

    expect(result).toBe("0x7a69");
    expect(transportRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_chainId" }),
    );
    expect(signTransactionSpy).not.toHaveBeenCalled();
  });

  it("forwards eth_blockNumber to the transport", async () => {
    transportRequestSpy.mockResolvedValueOnce("0xabcd");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_blockNumber" });

    expect(result).toBe("0xabcd");
    expect(transportRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_blockNumber" }),
    );
  });

  it("forwards eth_call with params", async () => {
    const expectedResult = "0x0000000000000000000000000000000000000000000000000000000000000001";
    transportRequestSpy.mockResolvedValueOnce(expectedResult);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const callParams = [{ to: "0x1234", data: "0xabcd" }, "latest"];
    const result = await provider.request({ method: "eth_call", params: callParams });

    expect(result).toBe(expectedResult);
    expect(transportRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_call", params: callParams }),
    );
  });

  it("forwards eth_getTransactionReceipt to the transport", async () => {
    const receipt = { status: "0x1", contractAddress: null };
    transportRequestSpy.mockResolvedValueOnce(receipt);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({
      method: "eth_getTransactionReceipt",
      params: ["0xabcdef"],
    });

    expect(result).toEqual(receipt);
    expect(transportRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_getTransactionReceipt" }),
    );
  });

  it("forwards eth_getBalance with params", async () => {
    const expectedReturn = "0xdeadbeef";
    transportRequestSpy.mockResolvedValueOnce(expectedReturn);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({
      method: "eth_getBalance",
      params: [FAKE_ACCOUNT_ADDRESS, "latest"],
    });

    expect(result).toBe(expectedReturn);
    expect(transportRequestSpy).toHaveBeenCalledTimes(1);
    expect(transportRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "eth_getBalance",
        params: [FAKE_ACCOUNT_ADDRESS, "latest"],
      }),
    );
  });

  it("forwards eth_estimateGas to the transport", async () => {
    transportRequestSpy.mockResolvedValueOnce("0x5208");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_estimateGas", params: [{ to: "0x1234" }] });

    expect(result).toBe("0x5208");
    expect(transportRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_estimateGas" }),
    );
  });

  it("forwards eth_getCode to the transport", async () => {
    transportRequestSpy.mockResolvedValueOnce("0x6080");

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_getCode", params: ["0x1234", "latest"] });

    expect(result).toBe("0x6080");
  });

  it("returns undefined when transport returns undefined", async () => {
    transportRequestSpy.mockResolvedValueOnce(undefined);

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });
    const result = await provider.request({ method: "eth_getCode", params: ["0x1234", "latest"] });

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Security: private key must not leak into error messages
// ---------------------------------------------------------------------------

describe("jsonRpcProvider -- private key security", () => {
  it("does not include the private key in error messages on READ-path failure", async () => {
    transportRequestSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    let thrownError: Error | undefined;
    try {
      await provider.request({ method: "eth_chainId" });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).not.toContain(FAKE_PRIVATE_KEY);
    expect(thrownError!.message).not.toContain(FAKE_PRIVATE_KEY.slice(2));
  });

  it("does not include the private key in error messages on SIGNING-path failure", async () => {
    // Force a failure on the signing path so the private key is actually in scope
    // when the error is thrown.  A transport mock error (eth_chainId) never brings
    // the key into scope, so that test is intentionally kept separately above.
    signTransactionSpy.mockRejectedValueOnce(new Error("signing boom"));

    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    let thrownError: Error | undefined;
    try {
      await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: FAKE_ACCOUNT_ADDRESS,
          to: "0x1234567890123456789012345678901234567890",
          gas: "0x5208",
          gasPrice: "0x3b9aca00",
        }],
      });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    // The key must not appear in either its full 0x-prefixed form or the bare hex
    expect(thrownError!.message).not.toContain(FAKE_PRIVATE_KEY);
    expect(thrownError!.message).not.toContain(FAKE_PRIVATE_KEY.slice(2));
  });

  it("does not expose the private key in the returned provider object", () => {
    const provider = jsonRpcProvider({ rpcUrl: FAKE_RPC_URL, privateKey: FAKE_PRIVATE_KEY });

    expect(Object.keys(provider)).toEqual(["request"]);
    expect(JSON.stringify(provider)).not.toContain(FAKE_PRIVATE_KEY);
  });
});

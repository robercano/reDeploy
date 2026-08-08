/**
 * Tests for the pluggable Signer seam (provider/signer.ts, provider/jsonRpc.ts's
 * signerProvider()) — issue #154.
 *
 * Strategy: mock viem's createPublicClient/http at the module level (same
 * approach as test/jsonRpc.test.ts) so no actual HTTP connections are made,
 * then supply a HAND-ROLLED `Signer` object (NOT derived from
 * `privateKeyToAccount`) to `signerProvider()` — proving the seam is truly
 * pluggable: any object satisfying the narrow `Signer` interface works,
 * simulating an external signer (hardware wallet, remote KMS, etc.).
 *
 * We also assert `jsonRpcProvider()` is unchanged: it still derives its
 * signer via `privateKeySigner()` (which calls `privateKeyToAccount`
 * internally) and behaves identically to before this refactor — covered
 * already by test/jsonRpc.test.ts's full behavioral suite; here we only
 * check that `privateKeySigner()` returns an object satisfying `Signer`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

let transportRequestSpy: Mock;

vi.mock("viem", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem")>();
  return {
    ...original,
    createPublicClient: vi.fn(() => ({
      request: (...args: unknown[]) => transportRequestSpy(...args),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getChainId: vi.fn().mockResolvedValue(1),
    })),
    http: vi.fn((url: string) => ({ type: "http", url })),
  };
});

import { signerProvider, privateKeySigner } from "../src/index.js";
import type { Signer } from "../src/index.js";

const FAKE_RPC_URL = "http://localhost:8545";
const EXTERNAL_SIGNER_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const FAKE_SIGNED_TX =
  "0x02f8748201c884028fa6aa8502540be4008252089412345678deadbeef00000000000000000000000087038d7ea4c6800080c001a0aabb00112233445566778899a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9a001122334455667788" as `0x${string}`;
const FAKE_TX_HASH = "0x" + "cd".repeat(32);

beforeEach(() => {
  transportRequestSpy = vi.fn();
});

// ---------------------------------------------------------------------------
// signerProvider() accepts ANY object satisfying the Signer interface
// ---------------------------------------------------------------------------

describe("signerProvider -- pluggable external Signer", () => {
  function makeExternalSigner(): { signer: Signer; spies: Record<string, Mock> } {
    const signTransactionSpy = vi.fn().mockResolvedValue(FAKE_SIGNED_TX);
    const signMessageSpy = vi.fn().mockResolvedValue("0xexternalsig");
    const signTypedDataSpy = vi.fn().mockResolvedValue("0xexternaltypedsig");

    // Deliberately NOT built via privateKeyToAccount/privateKeySigner --
    // simulates an external signer (hardware wallet / remote KMS client)
    // that only implements the narrow Signer contract.
    const signer: Signer = {
      address: EXTERNAL_SIGNER_ADDRESS,
      signTransaction: signTransactionSpy,
      signMessage: signMessageSpy,
      signTypedData: signTypedDataSpy,
    };

    return { signer, spies: { signTransactionSpy, signMessageSpy, signTypedDataSpy } };
  }

  it("returns an EIP-1193 shaped provider exposing ONLY request()", () => {
    const { signer } = makeExternalSigner();
    const provider = signerProvider({ rpcUrl: FAKE_RPC_URL, signer });

    expect(typeof provider.request).toBe("function");
    expect(Object.keys(provider)).toEqual(["request"]);
  });

  it("eth_accounts returns the external signer's address without hitting the transport", async () => {
    const { signer } = makeExternalSigner();
    const provider = signerProvider({ rpcUrl: FAKE_RPC_URL, signer });

    const result = await provider.request({ method: "eth_accounts" });

    expect(result).toEqual([EXTERNAL_SIGNER_ADDRESS]);
    expect(transportRequestSpy).not.toHaveBeenCalled();
  });

  it("eth_sendTransaction signs via the external signer, never via a private key", async () => {
    const { signer, spies } = makeExternalSigner();
    transportRequestSpy.mockResolvedValueOnce(FAKE_TX_HASH);

    const provider = signerProvider({ rpcUrl: FAKE_RPC_URL, signer });
    const result = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: EXTERNAL_SIGNER_ADDRESS,
          to: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          data: "0x1234",
          gas: "0x5208",
          gasPrice: "0x3b9aca00",
          nonce: "0x0",
          chainId: "0x1",
        },
      ],
    });

    expect(spies.signTransactionSpy).toHaveBeenCalledTimes(1);
    // Node only ever sees the ALREADY-signed raw transaction.
    const methods = transportRequestSpy.mock.calls.map((c) => (c[0] as { method: string }).method);
    expect(methods).not.toContain("eth_sendTransaction");
    expect(methods).toContain("eth_sendRawTransaction");
    expect(result).toBe(FAKE_TX_HASH);
  });

  it("personal_sign routes to the external signer's signMessage", async () => {
    const { signer, spies } = makeExternalSigner();
    const provider = signerProvider({ rpcUrl: FAKE_RPC_URL, signer });

    const result = await provider.request({
      method: "personal_sign",
      params: ["0x68656c6c6f", EXTERNAL_SIGNER_ADDRESS],
    });

    expect(spies.signMessageSpy).toHaveBeenCalledWith({ message: { raw: "0x68656c6c6f" } });
    expect(result).toBe("0xexternalsig");
  });
});

// ---------------------------------------------------------------------------
// privateKeySigner() -- the extracted original behavior, still Signer-shaped
// ---------------------------------------------------------------------------

describe("privateKeySigner -- backwards-compatible private-key Signer", () => {
  it("returns an object satisfying the Signer interface (address + 3 sign methods)", () => {
    const FAKE_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const signer = privateKeySigner(FAKE_PRIVATE_KEY);

    expect(typeof signer.address).toBe("string");
    expect(signer.address.startsWith("0x")).toBe(true);
    expect(typeof signer.signTransaction).toBe("function");
    expect(typeof signer.signMessage).toBe("function");
    expect(typeof signer.signTypedData).toBe("function");
  });

  it("does not expose the private key on the returned signer object", () => {
    const FAKE_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const signer = privateKeySigner(FAKE_PRIVATE_KEY);

    expect(JSON.stringify(signer)).not.toContain(FAKE_PRIVATE_KEY);
    expect(JSON.stringify(signer)).not.toContain(FAKE_PRIVATE_KEY.slice(2));
  });
});

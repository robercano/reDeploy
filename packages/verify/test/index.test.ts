/**
 * Tests for @redeploy/verify
 *
 * All tests use injectable fakes — no real network calls.
 *
 * Coverage targets:
 *   - verifyDeployment() orchestration (setup errors, success, already-verified,
 *     failed, pending → polling)
 *   - EtherscanClient: submit payload fields, checkStatus, pollUntilDone,
 *     defensive response handling (non-JSON, HTTP non-2xx, unexpected shapes)
 *   - SourcifyClient: submit payload, 409 already-verified, HTTP non-2xx,
 *     defensive response handling
 *   - VerifyError codes and message content
 */

import { describe, it, expect, vi } from "vitest";
import {
  verifyDeployment,
  createEtherscanClient,
  createSourcifyClient,
  VerifyError,
} from "../src/index.js";
import type {
  FetchLike,
  EtherscanSubmitRequest,
} from "../src/index.js";
import type { SourcifySubmitRequest } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake FetchLike that always returns a JSON response. */
function makeFakeFetch(
  responseBody: unknown,
  opts: { ok?: boolean; status?: number } = {},
): FetchLike {
  const { ok = true, status = 200 } = opts;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
  });
}

/** Create a fake FetchLike that always rejects (network error). */
function makeNetworkErrorFetch(message = "connect ECONNREFUSED"): FetchLike {
  return vi.fn().mockRejectedValue(new Error(message));
}

/** Create a fake FetchLike that returns non-JSON text. */
function makeNonJsonFetch(
  text: string,
  opts: { ok?: boolean; status?: number } = {},
): FetchLike {
  const { ok = true, status = 200 } = opts;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => text,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });
}

const VALID_ADDRESS = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";
const VALID_ADDRESS_2 = "0x1111111111111111111111111111111111111111";

const minimalEntry = {
  id: "token",
  address: VALID_ADDRESS,
  contractName: "Token",
  compilerVersion: "v0.8.28+commit.7893614a",
  sourceCode: '{"language":"Solidity"}',
  constructorArguments: "000000000000000000000000000000000000000000000000000000000000000a",
};

/** Build a toSubmitRequest mapper for the Etherscan client. */
function etherscanMapper(entry: typeof minimalEntry): EtherscanSubmitRequest {
  return {
    address: entry.address,
    contractName: entry.contractName,
    sourceCode: entry.sourceCode,
    compilerVersion: entry.compilerVersion,
    constructorArguments: entry.constructorArguments,
  };
}

// ---------------------------------------------------------------------------
// verifyDeployment() — setup error tests
// ---------------------------------------------------------------------------

describe("verifyDeployment() — setup errors (VerifyError thrown)", () => {
  it("throws EMPTY_CONTRACT_SET for an empty contracts array", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    await expect(
      verifyDeployment({ contracts: [], client, toSubmitRequest: etherscanMapper }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof VerifyError && err.code === "EMPTY_CONTRACT_SET";
    });
  });

  it("throws MALFORMED_CONTRACT_ENTRY for an invalid address", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    await expect(
      verifyDeployment({
        contracts: [{ ...minimalEntry, address: "not-an-address" }],
        client,
        toSubmitRequest: (entry) => ({
          ...etherscanMapper(minimalEntry),
          address: entry.address,
        }),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof VerifyError && err.code === "MALFORMED_CONTRACT_ENTRY";
    });
  });

  it("throws MALFORMED_CONTRACT_ENTRY for an empty contractName", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    await expect(
      verifyDeployment({
        contracts: [{ ...minimalEntry, contractName: "" }],
        client,
        toSubmitRequest: (entry) => ({
          ...etherscanMapper(minimalEntry),
          contractName: entry.contractName,
        }),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof VerifyError && err.code === "MALFORMED_CONTRACT_ENTRY";
    });
  });

  it("throws MALFORMED_CONTRACT_ENTRY for an empty id", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    await expect(
      verifyDeployment({
        contracts: [{ ...minimalEntry, id: "" }],
        client,
        toSubmitRequest: etherscanMapper,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof VerifyError && err.code === "MALFORMED_CONTRACT_ENTRY";
    });
  });

  it("VerifyError has .name 'VerifyError' and correct .code", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    try {
      await verifyDeployment({ contracts: [], client, toSubmitRequest: etherscanMapper });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError);
      expect((err as VerifyError).name).toBe("VerifyError");
      expect((err as VerifyError).code).toBe("EMPTY_CONTRACT_SET");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyDeployment() — successful verification
// ---------------------------------------------------------------------------

describe("verifyDeployment() — success paths", () => {
  it("returns success=true and status='verified' for a verified contract", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "abc-guid-123" });
    const client = createEtherscanClient(
      { apiKey: "test-api-key", maxPollAttempts: 1, pollIntervalMs: 0 },
      fakeFetch,
      () => Promise.resolve(),
    );
    // Make pollUntilDone return verified
    const mockPoll = vi.fn().mockResolvedValue({ status: "verified" });
    const patchedClient = { ...client, pollUntilDone: mockPoll };

    const result = await verifyDeployment({
      contracts: [minimalEntry],
      client: patchedClient,
      toSubmitRequest: etherscanMapper,
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("token");
    expect(result.results[0].address).toBe(VALID_ADDRESS);
    expect(result.results[0].status).toBe("verified");
    expect(mockPoll).toHaveBeenCalledWith("abc-guid-123");
  });

  it("returns success=true and status='already-verified' for an already-verified contract", async () => {
    const fakeFetch = makeFakeFetch({
      status: "0",
      result: "Contract source code already verified",
    });
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      fakeFetch,
      () => Promise.resolve(),
    );

    const result = await verifyDeployment({
      contracts: [minimalEntry],
      client,
      toSubmitRequest: etherscanMapper,
    });

    expect(result.success).toBe(true);
    expect(result.results[0].status).toBe("already-verified");
  });

  it("returns overall success=false when one contract fails", async () => {
    const fakeFetch = makeFakeFetch({
      status: "0",
      result: "Invalid API key",
    });
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      fakeFetch,
      () => Promise.resolve(),
    );

    const result = await verifyDeployment({
      contracts: [minimalEntry],
      client,
      toSubmitRequest: etherscanMapper,
    });

    expect(result.success).toBe(false);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].message).toBeTruthy();
  });

  it("handles multiple contracts — partial success", async () => {
    let callCount = 0;
    const fakeFetch: FetchLike = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: "0", result: "Contract source code already verified" }),
          json: async () => ({ status: "0", result: "Contract source code already verified" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "0", result: "Invalid source code" }),
        json: async () => ({ status: "0", result: "Invalid source code" }),
      });
    });

    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      fakeFetch,
      () => Promise.resolve(),
    );

    const result = await verifyDeployment({
      contracts: [
        minimalEntry,
        { ...minimalEntry, id: "registry", address: VALID_ADDRESS_2 },
      ],
      client,
      toSubmitRequest: etherscanMapper,
    });

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe("already-verified");
    expect(result.results[1].status).toBe("failed");
  });

  it("does not call pollUntilDone when submit returns already-verified directly", async () => {
    const fakeFetch = makeFakeFetch({
      status: "0",
      result: "Contract source code already verified",
    });
    const pollSpy = vi.fn();
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      fakeFetch,
      () => Promise.resolve(),
    );
    const patchedClient = { ...client, pollUntilDone: pollSpy };

    const result = await verifyDeployment({
      contracts: [minimalEntry],
      client: patchedClient,
      toSubmitRequest: etherscanMapper,
    });

    expect(result.results[0].status).toBe("already-verified");
    expect(pollSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — payload field assertions
// ---------------------------------------------------------------------------

describe("createEtherscanClient — payload field assertions", () => {
  it("submits the correct payload fields to Etherscan", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "abc-guid" });
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      fakeFetch,
      () => Promise.resolve(),
    );

    await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: '{"language":"Solidity"}',
      compilerVersion: "v0.8.28+commit.7893614a",
      constructorArguments: "deadbeef",
      codeFormat: "solidity-standard-json-input",
    });

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body?: string }];
    expect(url).toBe("https://api.etherscan.io/api");
    expect(init.body).toBeDefined();
    const body = init.body as string;
    const parsed = Object.fromEntries(
      body.split("&").map((p) => {
        const [k, ...rest] = p.split("=");
        return [decodeURIComponent(k), decodeURIComponent(rest.join("=").replace(/\+/g, " "))];
      }),
    );
    expect(parsed["module"]).toBe("contract");
    expect(parsed["action"]).toBe("verifysourcecode");
    expect(parsed["contractaddress"]).toBe(VALID_ADDRESS);
    expect(parsed["contractname"]).toBe("Token");
    expect(parsed["compilerversion"]).toBe("v0.8.28+commit.7893614a");
    // Historical misspelling on the wire
    expect(parsed["constructorArguements"]).toBe("deadbeef");
    expect(parsed["codeformat"]).toBe("solidity-standard-json-input");
    expect(parsed["sourceCode"]).toBe('{"language":"Solidity"}');
    // API key must be present but we test existence not the actual value
    expect(parsed["apikey"]).toBeTruthy();
  });

  it("defaults codeformat to solidity-standard-json-input when not specified", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "guid" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());

    await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "pragma solidity ^0.8.0;",
      compilerVersion: "v0.8.28+commit.7893614a",
    });

    const body = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    const parsed = Object.fromEntries(
      body.split("&").map((p) => {
        const [k, ...rest] = p.split("=");
        return [decodeURIComponent(k), decodeURIComponent(rest.join("=").replace(/\+/g, " "))];
      }),
    );
    expect(parsed["codeformat"]).toBe("solidity-standard-json-input");
    expect(parsed["constructorArguements"]).toBe("");
  });

  it("uses custom apiUrl when configured", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "guid" });
    const client = createEtherscanClient(
      { apiKey: "test-api-key", apiUrl: "https://api.bscscan.com/api" },
      fakeFetch,
      () => Promise.resolve(),
    );

    await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://api.bscscan.com/api");
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — response handling
// ---------------------------------------------------------------------------

describe("createEtherscanClient — response handling", () => {
  it("returns status='already-verified' for case-insensitive 'already verified' result", async () => {
    const fakeFetch = makeFakeFetch({ status: "0", result: "Contract source code ALREADY VERIFIED" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("already-verified");
  });

  it("returns status='failed' for HTTP non-2xx (e.g. 429)", async () => {
    const fakeFetch = makeFakeFetch(
      { status: "0", result: "Rate limit exceeded" },
      { ok: false, status: 429 },
    );
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("429");
  });

  it("returns status='failed' and does not throw for non-JSON response body", async () => {
    const fakeFetch = makeNonJsonFetch("Internal Server Error", { ok: false, status: 500 });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("500");
  });

  it("returns status='failed' and does not throw for non-JSON body on 200 OK", async () => {
    const fakeFetch = makeNonJsonFetch("not json at all");
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected response shape");
  });

  it("returns status='failed' and does not throw for unexpected JSON shape", async () => {
    // Response is valid JSON but not an Etherscan envelope
    const fakeFetch = makeFakeFetch([1, 2, 3]); // array, not object
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected response shape");
  });

  it("returns status='failed' and does not throw for network error", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeNetworkErrorFetch("connect ECONNREFUSED"),
      () => Promise.resolve(),
    );
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Network error");
  });

  it("returns status='pending' for guid submission acceptance", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "some-guid-here" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("pending");
    expect(result.guid).toBe("some-guid-here");
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — checkStatus
// ---------------------------------------------------------------------------

describe("createEtherscanClient — checkStatus", () => {
  it("returns 'verified' when status='1' from checkverifystatus", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "Pass - Verified" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("verified");
  });

  it("returns 'pending' when result contains 'pending'", async () => {
    const fakeFetch = makeFakeFetch({ status: "0", result: "Pending in queue" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("pending");
  });

  it("returns 'already-verified' from checkStatus", async () => {
    const fakeFetch = makeFakeFetch({ status: "0", result: "Contract source code already verified" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("already-verified");
  });

  it("returns 'failed' for HTTP non-2xx in checkStatus", async () => {
    const fakeFetch = makeFakeFetch(
      { status: "0", result: "Too many requests" },
      { ok: false, status: 429 },
    );
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("429");
  });

  it("returns 'failed' for non-JSON response in checkStatus", async () => {
    const fakeFetch = makeNonJsonFetch("bad gateway");
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("failed");
  });

  it("returns 'failed' for network error in checkStatus", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeNetworkErrorFetch(),
      () => Promise.resolve(),
    );
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Network error");
  });

  it("checkStatus URL includes guid and action=checkverifystatus", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "Pass - Verified" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    await client.checkStatus("my-guid-xyz");

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("action=checkverifystatus");
    expect(url).toContain("guid=my-guid-xyz");
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — pollUntilDone (pending → verified)
// ---------------------------------------------------------------------------

describe("createEtherscanClient — pollUntilDone", () => {
  it("drives pending → verified over multiple polls (instant sleep)", async () => {
    let pollCount = 0;
    const fakeFetch: FetchLike = vi.fn().mockImplementation(() => {
      pollCount++;
      const body =
        pollCount < 3
          ? { status: "0", result: "Pending in queue" }
          : { status: "1", result: "Pass - Verified" };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      });
    });

    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const client = createEtherscanClient(
      { apiKey: "test-api-key", maxPollAttempts: 5, pollIntervalMs: 0 },
      fakeFetch,
      instantSleep,
    );

    const result = await client.pollUntilDone!("test-guid");
    expect(result.status).toBe("verified");
    expect(pollCount).toBe(3);
    // Sleep called between polls (not before first)
    expect(instantSleep).toHaveBeenCalledTimes(2);
  });

  it("returns 'pending' after exhausting maxPollAttempts", async () => {
    const fakeFetch = makeFakeFetch({ status: "0", result: "Pending in queue" });
    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const client = createEtherscanClient(
      { apiKey: "test-api-key", maxPollAttempts: 3, pollIntervalMs: 0 },
      fakeFetch,
      instantSleep,
    );

    const result = await client.pollUntilDone!("test-guid");
    expect(result.status).toBe("pending");
    expect(result.message).toContain("Exceeded 3 poll attempts");
  });

  it("verifyDeployment uses pollUntilDone when submit returns pending", async () => {
    // First call: submit returns pending
    // pollUntilDone returns verified
    const fakeFetch = makeFakeFetch({ status: "1", result: "guid-abc" });
    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const client = createEtherscanClient(
      { apiKey: "test-api-key", maxPollAttempts: 2, pollIntervalMs: 0 },
      fakeFetch,
      instantSleep,
    );

    // Patch pollUntilDone to return verified
    const patchedClient = {
      ...client,
      pollUntilDone: vi.fn().mockResolvedValue({ status: "verified" }),
    };

    const result = await verifyDeployment({
      contracts: [minimalEntry],
      client: patchedClient,
      toSubmitRequest: etherscanMapper,
    });

    expect(result.success).toBe(true);
    expect(result.results[0].status).toBe("verified");
    expect(result.results[0].guid).toBe("guid-abc");
    expect(patchedClient.pollUntilDone).toHaveBeenCalledWith("guid-abc");
  });
});

// ---------------------------------------------------------------------------
// Sourcify client — payload field assertions
// ---------------------------------------------------------------------------

describe("createSourcifyClient — payload field assertions", () => {
  const sourcifyEntry: SourcifySubmitRequest = {
    address: VALID_ADDRESS,
    contractName: "Token",
    chainId: 1,
    files: {
      "metadata.json": '{"compiler":{"version":"0.8.28"}}',
      "contracts/Token.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;",
    },
  };

  it("sends correct address, chain, and files in the request body", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "perfect" }],
    });
    const client = createSourcifyClient({}, fakeFetch);
    await client.submit(sourcifyEntry);

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body?: string },
    ];
    expect(url).toContain("/verify");
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    expect(body["address"]).toBe(VALID_ADDRESS);
    expect(body["chain"]).toBe("1");
    expect(body["files"]).toEqual(sourcifyEntry.files);
  });

  it("uses custom apiUrl when configured", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "perfect" }],
    });
    const client = createSourcifyClient({ apiUrl: "https://custom.sourcify.dev" }, fakeFetch);
    await client.submit(sourcifyEntry);

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://custom.sourcify.dev/verify");
  });

  it("returns 'verified' for status='perfect'", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "perfect" }],
    });
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("verified");
  });

  it("returns 'verified' for status='partial'", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "partial" }],
    });
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("verified");
  });

  it("returns 'already-verified' for HTTP 409", async () => {
    const fakeFetch = makeFakeFetch(
      { error: "Already verified" },
      { ok: false, status: 409 },
    );
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("already-verified");
  });

  it("returns 'failed' for HTTP non-2xx (non-409)", async () => {
    const fakeFetch = makeFakeFetch(
      { error: "Bad request: missing metadata" },
      { ok: false, status: 400 },
    );
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("400");
    expect(result.message).toContain("Bad request");
  });

  it("returns 'failed' for network error", async () => {
    const client = createSourcifyClient({}, makeNetworkErrorFetch("connection refused"));
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Network error");
  });

  it("returns 'failed' for non-JSON response body", async () => {
    const fakeFetch = makeNonJsonFetch("Gateway Timeout");
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected response shape");
  });

  it("returns 'failed' for unexpected JSON shape", async () => {
    const fakeFetch = makeFakeFetch({ something: "unexpected" });
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit(sourcifyEntry);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected response shape");
  });

  it("checkStatus returns 'failed' with a 'does not support' message (Sourcify has no GUID polling)", async () => {
    const client = createSourcifyClient({}, makeFakeFetch({}));
    const result = await client.checkStatus("any-guid");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Sourcify");
  });
});

// ---------------------------------------------------------------------------
// Sourcify client integration with verifyDeployment
// ---------------------------------------------------------------------------

describe("verifyDeployment() with Sourcify client", () => {
  it("verifies a contract with Sourcify and returns success=true", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "perfect" }],
    });
    const sourcifyClient = createSourcifyClient({}, fakeFetch);

    const result = await verifyDeployment({
      contracts: [
        {
          id: "token",
          address: VALID_ADDRESS,
          contractName: "Token",
          files: {
            "metadata.json": "{}",
            "contracts/Token.sol": "// SPDX-License-Identifier: MIT",
          },
        },
      ],
      client: sourcifyClient,
      toSubmitRequest: (entry): SourcifySubmitRequest => ({
        address: entry.address,
        contractName: entry.contractName,
        chainId: 1,
        files: entry.files ?? {},
      }),
    });

    expect(result.success).toBe(true);
    expect(result.results[0].status).toBe("verified");
    expect(result.results[0].id).toBe("token");
  });

  it("already-verified from Sourcify (409) counts as success", async () => {
    const fakeFetch = makeFakeFetch(
      { error: "Already verified" },
      { ok: false, status: 409 },
    );
    const sourcifyClient = createSourcifyClient({}, fakeFetch);

    const result = await verifyDeployment({
      contracts: [
        {
          id: "token",
          address: VALID_ADDRESS,
          contractName: "Token",
          files: { "metadata.json": "{}" },
        },
      ],
      client: sourcifyClient,
      toSubmitRequest: (entry): SourcifySubmitRequest => ({
        address: entry.address,
        contractName: entry.contractName,
        chainId: 1,
        files: entry.files ?? {},
      }),
    });

    expect(result.success).toBe(true);
    expect(result.results[0].status).toBe("already-verified");
  });
});

// ---------------------------------------------------------------------------
// VerifyError — code coverage for all codes
// ---------------------------------------------------------------------------

describe("VerifyError codes", () => {
  it("can be constructed with each VerifyErrorCode", () => {
    const codes = [
      "MISSING_API_KEY",
      "EMPTY_CONTRACT_SET",
      "UNKNOWN_CONTRACT_ID",
      "MALFORMED_CONTRACT_ENTRY",
      "UNSUPPORTED_PROVIDER",
    ] as const;

    for (const code of codes) {
      const err = new VerifyError(code, `test: ${code}`);
      expect(err.code).toBe(code);
      expect(err.name).toBe("VerifyError");
      expect(err.message).toBe(`test: ${code}`);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(VerifyError);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge case: address validation
// ---------------------------------------------------------------------------

describe("address validation edge cases", () => {
  it("accepts 0x-prefixed 40-char hex addresses (lower and upper)", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({ status: "0", result: "Contract source code already verified" }),
      () => Promise.resolve(),
    );

    // lowercase
    const r1 = await verifyDeployment({
      contracts: [{ ...minimalEntry, address: "0x" + "a".repeat(40) }],
      client,
      toSubmitRequest: etherscanMapper,
    });
    expect(r1.results[0].status).toBe("already-verified");

    // uppercase
    const r2 = await verifyDeployment({
      contracts: [{ ...minimalEntry, address: "0x" + "A".repeat(40) }],
      client,
      toSubmitRequest: etherscanMapper,
    });
    expect(r2.results[0].status).toBe("already-verified");
  });

  it("throws MALFORMED_CONTRACT_ENTRY for address missing 0x prefix", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    await expect(
      verifyDeployment({
        contracts: [{ ...minimalEntry, address: "AbCdEf1234567890AbCdEf1234567890AbCdEf12" }],
        client,
        toSubmitRequest: etherscanMapper,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof VerifyError && err.code === "MALFORMED_CONTRACT_ENTRY";
    });
  });

  it("throws MALFORMED_CONTRACT_ENTRY for address that is too short", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeFakeFetch({}),
    );
    await expect(
      verifyDeployment({
        contracts: [{ ...minimalEntry, address: "0x1234" }],
        client,
        toSubmitRequest: etherscanMapper,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof VerifyError && err.code === "MALFORMED_CONTRACT_ENTRY";
    });
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — isVerified
// ---------------------------------------------------------------------------

describe("createEtherscanClient — isVerified", () => {
  it("returns true when getsourcecode returns status='1' with a verified result", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "ABI data here" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(true);

    const [url] = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("action=getsourcecode");
    expect(url).toContain(VALID_ADDRESS);
  });

  it("returns false when contract is not verified ('Contract source code not verified')", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "Contract source code not verified" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false when getsourcecode returns status='0'", async () => {
    const fakeFetch = makeFakeFetch({ status: "0", result: "Max rate limit reached" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for HTTP non-2xx from isVerified", async () => {
    const fakeFetch = makeFakeFetch({}, { ok: false, status: 500 });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for network error from isVerified", async () => {
    const client = createEtherscanClient(
      { apiKey: "test-api-key" },
      makeNetworkErrorFetch(),
      () => Promise.resolve(),
    );
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for unexpected JSON shape from isVerified", async () => {
    const fakeFetch = makeFakeFetch([1, 2, 3]); // array, not envelope
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — unexpected status edge case in checkStatus
// ---------------------------------------------------------------------------

describe("createEtherscanClient — checkStatus unexpected status", () => {
  it("returns 'failed' for unexpected status code in checkStatus response", async () => {
    const fakeFetch = makeFakeFetch({ status: "2", result: "Unknown response" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected status");
  });

  it("returns 'failed' for status='0' non-pending/non-already-verified in checkStatus", async () => {
    // status=0 with a result that is not "pending" or "already verified" — e.g. a failure message
    const fakeFetch = makeFakeFetch({ status: "0", result: "Fail - Unable to verify" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.checkStatus("test-guid");
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Fail - Unable to verify");
  });
});

// ---------------------------------------------------------------------------
// Sourcify client — isVerified
// ---------------------------------------------------------------------------

describe("createSourcifyClient — isVerified", () => {
  it("returns true for perfect match from check-by-addresses", async () => {
    const fakeFetch = makeFakeFetch([{ address: VALID_ADDRESS, status: "perfect" }]);
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(true);
  });

  it("returns true for partial match from check-by-addresses", async () => {
    const fakeFetch = makeFakeFetch([{ address: VALID_ADDRESS, status: "partial" }]);
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(true);
  });

  it("returns false for 'false' status from check-by-addresses", async () => {
    const fakeFetch = makeFakeFetch([{ address: VALID_ADDRESS, status: "false" }]);
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for HTTP non-2xx", async () => {
    const fakeFetch = makeFakeFetch({}, { ok: false, status: 500 });
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for network error", async () => {
    const client = createSourcifyClient({}, makeNetworkErrorFetch());
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for empty array from check-by-addresses", async () => {
    const fakeFetch = makeFakeFetch([]);
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for non-array response from check-by-addresses", async () => {
    const fakeFetch = makeFakeFetch({ error: "not an array" });
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });

  it("returns false for JSON parse error in isVerified", async () => {
    const fakeFetch: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "not json",
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    const client = createSourcifyClient({}, fakeFetch);
    const verified = await client.isVerified!(VALID_ADDRESS);
    expect(verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sourcify client — already_verified status string variant
// ---------------------------------------------------------------------------

describe("createSourcifyClient — already_verified status variant", () => {
  it("returns 'already-verified' for status='already_verified'", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "already_verified" }],
    });
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      chainId: 1,
      files: { "metadata.json": "{}" },
    });
    expect(result.status).toBe("already-verified");
  });

  it("returns 'failed' for an unexpected Sourcify status string", async () => {
    const fakeFetch = makeFakeFetch({
      result: [{ address: VALID_ADDRESS, status: "unknown_status" }],
    });
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      chainId: 1,
      files: { "metadata.json": "{}" },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected status");
  });

  it("returns 'failed' with fallback message when error body has neither 'error' nor 'message' fields", async () => {
    // HTTP 400 with a body that has no 'error' or 'message' keys — exercises parseSourcifyError fallback
    const fakeFetch = makeFakeFetch(
      { code: 400, detail: "bad request" }, // no 'error' or 'message' key
      { ok: false, status: 400 },
    );
    const client = createSourcifyClient({}, fakeFetch);
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      chainId: 1,
      files: { "metadata.json": "{}" },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("400");
  });
});

// ---------------------------------------------------------------------------
// Etherscan client — unexpected status in submit (final fallback path)
// ---------------------------------------------------------------------------

describe("createEtherscanClient — submit unexpected status fallback", () => {
  it("returns 'failed' when status is not '0' or '1'", async () => {
    const fakeFetch = makeFakeFetch({ status: "2", result: "Unknown" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("unexpected status");
  });

  it("returns 'failed' when status='1' but result is empty string", async () => {
    const fakeFetch = makeFakeFetch({ status: "1", result: "" });
    const client = createEtherscanClient({ apiKey: "test-api-key" }, fakeFetch, () => Promise.resolve());
    const result = await client.submit({
      address: VALID_ADDRESS,
      contractName: "Token",
      sourceCode: "src",
      compilerVersion: "v0.8.28+commit.7893614a",
    });
    expect(result.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// createEtherscanClient — MISSING_API_KEY guard
// ---------------------------------------------------------------------------

describe("createEtherscanClient — MISSING_API_KEY guard", () => {
  it("throws VerifyError MISSING_API_KEY for an empty apiKey", () => {
    try {
      createEtherscanClient({ apiKey: "" }, makeFakeFetch({}));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError);
      expect((err as VerifyError).code).toBe("MISSING_API_KEY");
    }
  });

  it("throws VerifyError MISSING_API_KEY for a whitespace-only apiKey", () => {
    try {
      createEtherscanClient({ apiKey: "   " }, makeFakeFetch({}));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerifyError);
      expect((err as VerifyError).code).toBe("MISSING_API_KEY");
    }
  });

  it("sentinel apiKey never leaks into returned SubmitResult or StatusResult messages", async () => {
    // A real key that must never appear in any returned .message field.
    // (It IS placed in the request body/URL handed to fakeFetch — that is
    // expected and intentional.  The assertion is only about RETURNED messages.)
    const SENTINEL_KEY = "SENTINEL_ETHERSCAN_KEY_abc123_DO_NOT_LOG";

    // --- path 1: submit() with HTTP non-2xx response ---
    const httpErrorFetch = makeFakeFetch(
      { status: "0", result: "internal server error" },
      { ok: false, status: 500 },
    );
    const clientHttp = createEtherscanClient(
      { apiKey: SENTINEL_KEY, pollIntervalMs: 0 },
      httpErrorFetch,
      () => Promise.resolve(),
    );
    const submitHttpResult = await clientHttp.submit(etherscanMapper(minimalEntry));
    expect(submitHttpResult.status).toBe("failed");
    expect(submitHttpResult.message).toBeDefined();
    expect(submitHttpResult.message).not.toContain(SENTINEL_KEY);

    // --- path 2: submit() with a network-throw fetch ---
    const networkThrowFetch = makeNetworkErrorFetch("connect ECONNREFUSED 127.0.0.1:9999");
    const clientNet = createEtherscanClient(
      { apiKey: SENTINEL_KEY, pollIntervalMs: 0 },
      networkThrowFetch,
      () => Promise.resolve(),
    );
    const submitNetResult = await clientNet.submit(etherscanMapper(minimalEntry));
    expect(submitNetResult.status).toBe("failed");
    expect(submitNetResult.message).toBeDefined();
    expect(submitNetResult.message).not.toContain(SENTINEL_KEY);

    // --- path 3: checkStatus() with HTTP non-2xx response ---
    const statusHttpFetch = makeFakeFetch(
      { status: "0", result: "rate limited" },
      { ok: false, status: 429 },
    );
    const clientStatus = createEtherscanClient(
      { apiKey: SENTINEL_KEY, pollIntervalMs: 0 },
      statusHttpFetch,
      () => Promise.resolve(),
    );
    const checkStatusResult = await clientStatus.checkStatus("some-guid-abc");
    expect(checkStatusResult.status).toBe("failed");
    expect(checkStatusResult.message).toBeDefined();
    expect(checkStatusResult.message).not.toContain(SENTINEL_KEY);

    // --- path 4: checkStatus() with a network-throw fetch ---
    const statusNetFetch = makeNetworkErrorFetch("connect ETIMEDOUT");
    const clientStatusNet = createEtherscanClient(
      { apiKey: SENTINEL_KEY, pollIntervalMs: 0 },
      statusNetFetch,
      () => Promise.resolve(),
    );
    const checkStatusNetResult = await clientStatusNet.checkStatus("some-guid-xyz");
    expect(checkStatusNetResult.status).toBe("failed");
    expect(checkStatusNetResult.message).toBeDefined();
    expect(checkStatusNetResult.message).not.toContain(SENTINEL_KEY);
  });

  it("does NOT throw for a valid non-empty apiKey (sanity check)", () => {
    expect(() =>
      createEtherscanClient({ apiKey: "valid-api-key" }, makeFakeFetch({})),
    ).not.toThrow();
  });
});

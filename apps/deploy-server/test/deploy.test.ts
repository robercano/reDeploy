/**
 * Tests for POST /api/deploy SSE endpoint.
 *
 * All tests use vitest module mocks to stub @redeploy/core and @redeploy/reader
 * so no live chain/Anvil is required.
 *
 * Accounts-derivation approach:
 * The mock jsonRpcProvider returns an object whose .request({method:"eth_accounts"})
 * resolves ["0xDeployer0000000000000000000000000000000001"]. This mirrors how the
 * real provider works (answered locally, no RPC) and avoids importing viem
 * directly into deploy-server.
 *
 * Secret-leak tests:
 * We set DEPLOYER_PRIVATE_KEY and RPC_URL to sentinel values, run success and
 * failure paths, and assert neither sentinel appears anywhere in the raw SSE
 * output or error body. Env vars are restored after each test.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import { Server, request as httpRequest } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../src/server.js";
import type { DeploymentView } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// Module mocks — must be at top level before any imports from the modules
// vi.mock() is hoisted so factory functions cannot reference variables defined
// below. We use vi.fn() stubs here and configure them in beforeEach.
// ---------------------------------------------------------------------------

// Mock @redeploy/core
vi.mock("@redeploy/core", async (importActual) => {
  const actual = await importActual<typeof import("@redeploy/core")>();
  return {
    ...actual,
    // Keep simulate and DeployError from actual; stub deploy, jsonRpcProvider, foundryArtifactResolver
    deploy: vi.fn(),
    jsonRpcProvider: vi.fn(),
    foundryArtifactResolver: vi.fn(),
  };
});

// Mock @redeploy/reader
// buildSnapshot is stubbed as a vi.fn() *wrapping* the real implementation
// (call-through) so tests can assert on call args/count while still exercising
// the real, pure snapshot-building logic (no filesystem access inside it).
vi.mock("@redeploy/reader", async (importActual) => {
  const actual = await importActual<typeof import("@redeploy/reader")>();
  return {
    ...actual,
    readDeployment: vi.fn(),
    buildSnapshot: vi.fn(actual.buildSnapshot),
  };
});

// ---------------------------------------------------------------------------
// Fake DeploymentView — defined after mocks so it can be used in helpers
// ---------------------------------------------------------------------------

// Fake DeploymentView returned by the mocked readDeployment
const FAKE_DEPLOYMENT_VIEW: DeploymentView = {
  contracts: [
    {
      id: "token",
      contractName: "Token",
      address: "0xTOKEN000000000000000000000000000000000001",
      args: [],
      links: { dependencies: [], libraries: {} },
    },
    {
      id: "vault",
      contractName: "Vault",
      address: "0xVAULT000000000000000000000000000000000002",
      args: [],
      links: { dependencies: ["token"], libraries: {} },
    },
  ],
  configSteps: [],
  warnings: [],
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function doRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const contentHeaders =
      body !== undefined
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
          }
        : {};

    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...contentHeaders, ...extraHeaders },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSse(body: string): SseEvent[] {
  const messages = body.split("\n\n").filter((m) => m.trim().length > 0);
  return messages.map((msg) => {
    const lines = msg.split("\n");
    let event = "";
    let dataRaw = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice("event: ".length);
      } else if (line.startsWith("data: ")) {
        dataRaw = line.slice("data: ".length);
      }
    }
    return { event, data: JSON.parse(dataRaw) };
  });
}

// ---------------------------------------------------------------------------
// Real server setup
// ---------------------------------------------------------------------------

let server: Server;
let port: number;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

// ---------------------------------------------------------------------------
// Save/restore env vars around tests that manipulate them
// ---------------------------------------------------------------------------

let savedPrivateKey: string | undefined;
let savedRpcUrl: string | undefined;
let savedDeploymentDir: string | undefined;

beforeEach(async () => {
  savedPrivateKey = process.env["DEPLOYER_PRIVATE_KEY"];
  savedRpcUrl = process.env["RPC_URL"];
  savedDeploymentDir = process.env["DEPLOYMENT_DIR"];

  // Set up default mock implementations
  const coreMod = vi.mocked(await import("@redeploy/core"));
  coreMod.deploy.mockResolvedValue({
    success: true,
    deployedAddresses: { token: "0xTOKEN0001", vault: "0xVAULT0002" },
    ignitionResult: { type: "SUCCESSFUL_DEPLOYMENT", contracts: {} },
  });
  coreMod.jsonRpcProvider.mockReturnValue({
    request: vi.fn().mockImplementation((args: { method: string }) => {
      if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") {
        return Promise.resolve(["0xDeployer0000000000000000000000000000000001"]);
      }
      if (args.method === "eth_chainId") {
        return Promise.resolve("0x1");
      }
      return Promise.resolve(null);
    }),
  });
  coreMod.foundryArtifactResolver.mockReturnValue({});

  const readerActual = await vi.importActual<typeof import("@redeploy/reader")>(
    "@redeploy/reader",
  );
  const readerMod = vi.mocked(await import("@redeploy/reader"));
  readerMod.readDeployment.mockReturnValue(FAKE_DEPLOYMENT_VIEW);
  // Re-wire the call-through implementation each test — vi.resetAllMocks()
  // (afterEach) clears it after every test.
  readerMod.buildSnapshot.mockImplementation(readerActual.buildSnapshot);
});

afterEach(() => {
  // Restore env vars
  if (savedPrivateKey === undefined) {
    delete process.env["DEPLOYER_PRIVATE_KEY"];
  } else {
    process.env["DEPLOYER_PRIVATE_KEY"] = savedPrivateKey;
  }
  if (savedRpcUrl === undefined) {
    delete process.env["RPC_URL"];
  } else {
    process.env["RPC_URL"] = savedRpcUrl;
  }
  if (savedDeploymentDir === undefined) {
    delete process.env["DEPLOYMENT_DIR"];
  } else {
    process.env["DEPLOYMENT_DIR"] = savedDeploymentDir;
  }
  // Mock implementations are reset by beforeEach on the next test.
  vi.resetAllMocks();
});

// A minimal valid spec
const VALID_SPEC = {
  version: 1,
  contracts: [
    { id: "token", contract: "Token" },
    {
      id: "vault",
      contract: "Vault",
      args: [{ kind: "ref", contract: "token" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// POST /api/deploy — success path
// ---------------------------------------------------------------------------

describe("POST /api/deploy — success", () => {
  it("emits a progress frame then terminal done{success:true, deployment} with contracts", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);

    // First event must be progress
    const progressEvent = events[0];
    expect(progressEvent?.event).toBe("progress");
    expect((progressEvent?.data as Record<string, unknown>)["phase"]).toBe("deploying");

    // Last event must be done
    const doneEvent = events[events.length - 1];
    expect(doneEvent?.event).toBe("done");

    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(true);

    const deployment = done["deployment"] as Record<string, unknown>;
    expect(deployment).not.toBeNull();

    const contracts = deployment["contracts"] as Array<Record<string, unknown>>;
    expect(Array.isArray(contracts)).toBe(true);
    expect(contracts.length).toBeGreaterThan(0);

    // Each contract carries an address
    for (const contract of contracts) {
      expect(typeof contract["address"]).toBe("string");
      expect(contract["id"]).toBeDefined();
    }
  });

  it("progress event precedes the terminal done event", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    const events = parseSse(res.body);

    const progressIdx = events.findIndex((e) => e.event === "progress");
    const doneIdx = events.findIndex((e) => e.event === "done");

    expect(progressIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(progressIdx);
  });

  it("calls core.deploy with spec, provider, accounts, deploymentDir, and artifactResolver", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const coreMod = vi.mocked(await import("@redeploy/core"));

    // Capture the provider mock that jsonRpcProvider returns so we can inspect it
    const mockProviderRequest = vi.fn().mockImplementation((args: { method: string }) => {
      if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") {
        return Promise.resolve(["0xDeployer0000000000000000000000000000000001"]);
      }
      return Promise.resolve(null);
    });
    const mockProvider = { request: mockProviderRequest };
    coreMod.jsonRpcProvider.mockReturnValue(mockProvider);

    const mockArtifactResolver = { resolveArtifact: vi.fn() };
    coreMod.foundryArtifactResolver.mockReturnValue(mockArtifactResolver);

    await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    // The provider's eth_accounts method must have been called
    expect(mockProviderRequest).toHaveBeenCalledWith({ method: "eth_accounts" });

    // core.deploy must have been called with the correct wired-up arguments
    expect(coreMod.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: ["0xDeployer0000000000000000000000000000000001"],
        deploymentDir: expect.any(String),
        spec: VALID_SPEC,
        provider: mockProvider,
        artifactResolver: mockArtifactResolver,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/deploy — DEPLOYER_PRIVATE_KEY without a "0x" prefix
// ---------------------------------------------------------------------------

describe("POST /api/deploy — DEPLOYER_PRIVATE_KEY normalization", () => {
  it("normalizes a non-0x-prefixed key before passing it to jsonRpcProvider", async () => {
    const unprefixedKey = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env["DEPLOYER_PRIVATE_KEY"] = unprefixedKey;

    const coreMod = vi.mocked(await import("@redeploy/core"));

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect((doneEvent?.data as Record<string, unknown>)["success"]).toBe(true);

    expect(coreMod.jsonRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: `0x${unprefixedKey}` }),
    );

    // SECURITY: the raw (unprefixed) key must not leak into the response either.
    expect(res.body).not.toContain(unprefixedKey);
  });
});

// ---------------------------------------------------------------------------
// POST /api/deploy — deploy failure (success:false from deploy())
// ---------------------------------------------------------------------------

describe("POST /api/deploy — deploy failure (success:false)", () => {
  it("emits done{success:false, errors:[...]} when deploy() resolves with success:false", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const coreMod = vi.mocked(await import("@redeploy/core"));
    coreMod.deploy.mockResolvedValueOnce({
      success: false,
      deployedAddresses: {},
      ignitionResult: { type: "FAILED_DEPLOYMENT", contracts: {} } as unknown as import("@nomicfoundation/ignition-core").DeploymentResult,
    });

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();

    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
    expect((done["errors"] as unknown[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/deploy — DeployError thrown
// ---------------------------------------------------------------------------

describe("POST /api/deploy — DeployError thrown", () => {
  it("emits done{success:false, errors:[...]} when deploy() throws DeployError(INVALID_SPEC)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { DeployError } = await import("@redeploy/core");
    const coreMod = vi.mocked(await import("@redeploy/core"));

    const specErrors = [
      { code: "DUPLICATE_ID" as const, message: "Duplicate contract id: token" },
    ];
    coreMod.deploy.mockRejectedValueOnce(
      new DeployError("INVALID_SPEC", "Spec validation failed", specErrors),
    );

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();

    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    const errors = done["errors"] as Array<Record<string, unknown>>;
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    // Error messages should contain spec error message (not private key)
    expect(errors[0]!["message"]).toContain("Duplicate");
  });

  it("emits done{success:false, errors:[...]} when deploy() throws DeployError(COMPILE_ERROR)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { DeployError } = await import("@redeploy/core");
    const coreMod = vi.mocked(await import("@redeploy/core"));

    coreMod.deploy.mockRejectedValueOnce(
      new DeployError("COMPILE_ERROR", "Compilation failed"),
    );

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();

    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/deploy — body validation errors (non-SSE)
// ---------------------------------------------------------------------------

describe("POST /api/deploy — body validation errors", () => {
  it("malformed JSON body → 400 Bad Request (non-SSE)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const res = await doRequest(port, "POST", "/api/deploy", "{ not valid json }");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });

  it("oversized body (> 1 MiB) → 413 Payload Too Large (non-SSE)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const oversize = "x".repeat(1024 * 1024 + 1);
    const res = await doRequest(port, "POST", "/api/deploy", oversize);
    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// POST /api/deploy — missing DEPLOYER_PRIVATE_KEY
// ---------------------------------------------------------------------------

describe("POST /api/deploy — missing DEPLOYER_PRIVATE_KEY", () => {
  it("emits done{success:false, errors:[...]} when key is absent", async () => {
    delete process.env["DEPLOYER_PRIVATE_KEY"];

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    // Must be SSE (200), not a 500
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();

    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
    expect((done["errors"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("emits done{success:false} when key is empty string", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "";

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SECRET LEAK TESTS
// ---------------------------------------------------------------------------

describe("POST /api/deploy — secret leak prevention", () => {
  const SENTINEL_KEY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const SENTINEL_RPC = "http://secret-rpc.internal.example.com";

  it("success path: sentinel key and rpcUrl do NOT appear in raw SSE output", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    // The full raw body must not contain either sentinel
    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("failure path (DeployError): neither sentinel appears in raw SSE output", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const { DeployError } = await import("@redeploy/core");
    const coreMod = vi.mocked(await import("@redeploy/core"));
    // DeployError message intentionally does NOT embed any sentinel —
    // env-var leaks never come through DeployError anyway.
    coreMod.deploy.mockRejectedValueOnce(
      new DeployError("INVALID_SPEC", "Spec validation failed"),
    );

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    // Neither the private key nor the RPC URL sentinel must appear in the response
    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("failure path (success:false): sentinel key and rpcUrl do NOT appear in raw SSE output", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const coreMod = vi.mocked(await import("@redeploy/core"));
    coreMod.deploy.mockResolvedValueOnce({
      success: false,
      deployedAddresses: {},
      ignitionResult: { type: "FAILED_DEPLOYMENT", contracts: {} } as unknown as import("@nomicfoundation/ignition-core").DeploymentResult,
    });

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("missing key path: sentinel rpcUrl does NOT appear in done{success:false} response", async () => {
    delete process.env["DEPLOYER_PRIVATE_KEY"];
    process.env["RPC_URL"] = SENTINEL_RPC;

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("unexpected deploy error: sentinels do NOT appear in stderr or client SSE, client receives done{success:false}", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const coreMod = vi.mocked(await import("@redeploy/core"));
    // Simulate a viem transport error whose message embeds the RPC URL
    const transportError = new Error(
      `HttpRequestError: URL: ${SENTINEL_RPC}/v3/apikey — request failed`,
    );
    coreMod.deploy.mockRejectedValueOnce(transportError);

    // Spy on stderr to capture what gets written
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        stderrChunks.push(String(chunk));
        return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as Parameters<typeof origWrite>[1][]));
      });

    try {
      const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

      // (a) Neither sentinel must appear in stderr
      const stderrOutput = stderrChunks.join("");
      expect(stderrOutput).not.toContain(SENTINEL_RPC);
      expect(stderrOutput).not.toContain(SENTINEL_KEY);

      // (b) Neither sentinel must appear in the client SSE body
      expect(res.body).not.toContain(SENTINEL_RPC);
      expect(res.body).not.toContain(SENTINEL_KEY);

      // (c) Client must still receive a terminal done{success:false} with a generic message
      const events = parseSse(res.body);
      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent).toBeDefined();
      const done = doneEvent!.data as Record<string, unknown>;
      expect(done["success"]).toBe(false);
      expect(Array.isArray(done["errors"])).toBe(true);
      const errors = done["errors"] as Array<Record<string, unknown>>;
      expect(errors.length).toBeGreaterThan(0);
      // The error message must be generic (not contain the sentinel)
      expect(String(errors[0]!["message"])).not.toContain(SENTINEL_RPC);
      expect(String(errors[0]!["message"])).not.toContain(SENTINEL_KEY);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/deploy — malformed/invalid private key (provider construction throws)
// ---------------------------------------------------------------------------

describe("POST /api/deploy — malformed DEPLOYER_PRIVATE_KEY", () => {
  it("emits terminal done{success:false} (generic message) when jsonRpcProvider throws, with no sentinel in output", async () => {
    const SENTINEL_BAD_KEY = "NOT_A_VALID_KEY_0xbadbadbad";
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_BAD_KEY;

    const coreMod = vi.mocked(await import("@redeploy/core"));
    // Simulate privateKeyToAccount throwing for a malformed key.
    // The thrown message includes the bad-key sentinel to verify it doesn't leak.
    coreMod.jsonRpcProvider.mockImplementationOnce(() => {
      throw new Error(`Invalid private key: ${SENTINEL_BAD_KEY}`);
    });

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    // Response must be SSE (stream was already opened before provider construction)
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    // Client must receive a terminal done{success:false}
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
    const errors = done["errors"] as Array<Record<string, unknown>>;
    expect(errors.length).toBeGreaterThan(0);

    // The caught error's message (containing the sentinel) must NOT appear in
    // client output or stderr
    expect(res.body).not.toContain(SENTINEL_BAD_KEY);

    // core.deploy must NOT have been called (we bailed before reaching it)
    expect(coreMod.deploy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readDeployment failure — success:true deploy but ReadError
// ---------------------------------------------------------------------------

describe("POST /api/deploy — readDeployment failure after success", () => {
  it("emits done{success:true, deployment:null, warning} when readDeployment throws ReadError", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { ReadError } = await import("@redeploy/reader");
    const readerMod = vi.mocked(await import("@redeploy/reader"));
    readerMod.readDeployment.mockImplementationOnce(() => {
      throw new ReadError("DEPLOYMENT_DIR_NOT_FOUND", "dir not found");
    });

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();

    const done = doneEvent!.data as Record<string, unknown>;
    // Successful deploy must not become a hard failure
    expect(done["success"]).toBe(true);
    expect(done["deployment"]).toBeNull();
    expect(typeof done["warning"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Deployment snapshot persistence (issue #104)
// ---------------------------------------------------------------------------

describe("POST /api/deploy — snapshot persistence on success", () => {
  const SENTINEL_KEY =
    "0xcafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe";
  const SENTINEL_RPC = "http://secret-rpc.snapshot-test.example.com";

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-snapshot-test-"));
    process.env["DEPLOYMENT_DIR"] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a snapshot file under <deploymentDir>/snapshots/*.json and calls buildSnapshot with the expected inputs", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const readerMod = vi.mocked(await import("@redeploy/reader"));

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(true);
    // No snapshot warning expected on the happy path.
    expect(done["warning"]).toBeUndefined();

    // buildSnapshot must be called with the reused DeploymentView, chainId
    // (derived from eth_chainId, mocked to "0x1" => 1), a toolVersion string,
    // and the request body as the spec.
    expect(readerMod.buildSnapshot).toHaveBeenCalledTimes(1);
    expect(readerMod.buildSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment: FAKE_DEPLOYMENT_VIEW,
        chainId: 1,
        toolVersion: expect.any(String),
        spec: { spec: VALID_SPEC },
      }),
    );

    // A snapshot file must exist under <deploymentDir>/snapshots/*.json
    const snapshotsDir = path.join(tmpDir, "snapshots");
    expect(fs.existsSync(snapshotsDir)).toBe(true);
    const files = fs.readdirSync(snapshotsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);

    // Its parsed content must match what buildSnapshot actually returned.
    const returnedSnapshot = readerMod.buildSnapshot.mock.results[0]!.value as unknown;
    const fileContent = JSON.parse(
      fs.readFileSync(path.join(snapshotsDir, files[0]!), "utf8"),
    ) as unknown;
    expect(fileContent).toEqual(returnedSnapshot);
  });

  it("SECURITY: persisted snapshot file and SSE output do not contain the private key or RPC URL", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);

    const snapshotsDir = path.join(tmpDir, "snapshots");
    const files = fs.readdirSync(snapshotsDir);
    expect(files.length).toBe(1);
    const rawFileContent = fs.readFileSync(path.join(snapshotsDir, files[0]!), "utf8");
    expect(rawFileContent).not.toContain(SENTINEL_KEY);
    expect(rawFileContent).not.toContain(SENTINEL_RPC);
  });
});

describe("POST /api/deploy — snapshot skipped on failure", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-snapshot-test-"));
    process.env["DEPLOYMENT_DIR"] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call buildSnapshot or write a snapshot file when deploy() resolves with success:false", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const coreMod = vi.mocked(await import("@redeploy/core"));
    coreMod.deploy.mockResolvedValueOnce({
      success: false,
      deployedAddresses: {},
      ignitionResult: { type: "FAILED_DEPLOYMENT", contracts: {} } as unknown as import("@nomicfoundation/ignition-core").DeploymentResult,
    });

    const readerMod = vi.mocked(await import("@redeploy/reader"));

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);

    expect(readerMod.buildSnapshot).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, "snapshots"))).toBe(false);
  });

  it("does not call buildSnapshot or write a snapshot file when deploy() throws DeployError", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { DeployError } = await import("@redeploy/core");
    const coreMod = vi.mocked(await import("@redeploy/core"));
    coreMod.deploy.mockRejectedValueOnce(new DeployError("COMPILE_ERROR", "Compilation failed"));

    const readerMod = vi.mocked(await import("@redeploy/reader"));

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);

    expect(readerMod.buildSnapshot).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, "snapshots"))).toBe(false);
  });

  it("does not call buildSnapshot or write a snapshot file when readDeployment fails (no DeploymentView to snapshot)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { ReadError } = await import("@redeploy/reader");
    const readerMod = vi.mocked(await import("@redeploy/reader"));
    readerMod.readDeployment.mockImplementationOnce(() => {
      throw new ReadError("DEPLOYMENT_DIR_NOT_FOUND", "dir not found");
    });

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(true);
    expect(done["deployment"]).toBeNull();

    expect(readerMod.buildSnapshot).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, "snapshots"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot persistence failure — success:true deploy but snapshot step throws
// (issue #104: a snapshot RPC/build/write failure must degrade to a warning,
// mirroring the "readDeployment failure after success" suite above, and must
// NOT turn a successful deploy into a hard failure).
// ---------------------------------------------------------------------------

describe("POST /api/deploy — snapshot failure degrades to warning", () => {
  const SENTINEL_KEY =
    "0xcafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe";
  const SENTINEL_RPC = "http://secret-rpc.snapshot-failure-test.example.com";

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-snapshot-failure-test-"));
    process.env["DEPLOYMENT_DIR"] = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits done{success:true, deployment, warning:'could not persist deployment snapshot'} when buildSnapshot throws, with HTTP 200 and no snapshot file written", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const readerMod = vi.mocked(await import("@redeploy/reader"));
    // Force the snapshot step to throw — a failure here (whether from the
    // eth_chainId RPC call, buildSnapshot itself, or the fs write) must
    // degrade gracefully rather than fail the whole deploy.
    readerMod.buildSnapshot.mockImplementationOnce(() => {
      throw new Error(`buildSnapshot boom: ${SENTINEL_RPC}`);
    });

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();

    const done = doneEvent!.data as Record<string, unknown>;
    // Successful deploy must not become a hard failure.
    expect(done["success"]).toBe(true);
    expect(done["warning"]).toBe("could not persist deployment snapshot");
    // The deployment view (read before the snapshot step) must still be present.
    expect(done["deployment"]).not.toBeNull();
    expect(done["deployment"]).toEqual(FAKE_DEPLOYMENT_VIEW);

    // No snapshot file was written since the snapshot step failed.
    expect(fs.existsSync(path.join(tmpDir, "snapshots"))).toBe(false);

    // SECURITY: the caught error (embedding the RPC sentinel) must never be
    // forwarded to the client, and the private key must never leak either.
    expect(res.body).not.toContain(SENTINEL_RPC);
    expect(res.body).not.toContain(SENTINEL_KEY);
  });
});

// ---------------------------------------------------------------------------
// Regression tests — ensure existing routes are unaffected
// ---------------------------------------------------------------------------

describe("Regression — existing routes unchanged by /api/deploy addition", () => {
  it("GET /health → 200 { status: 'ok' }", async () => {
    const res = await doRequest(port, "GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("GET /unknown → 404", async () => {
    const res = await doRequest(port, "GET", "/unknown");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not Found" });
  });

  it("POST /api/simulate with valid spec → SSE done{success:true}", async () => {
    const simpleSpec = {
      version: 1,
      contracts: [{ id: "token", contract: "Token" }],
    };
    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(simpleSpec));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent!.data as Record<string, unknown>)["success"]).toBe(true);
  });

  it("POST /api/simulate with invalid spec → done{success:false}", async () => {
    const invalidSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token" },
      ],
    };
    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(invalidSpec));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-network support (issue #139) — POST /api/deploy?network=<name>
// ---------------------------------------------------------------------------

describe("POST /api/deploy — multi-network (?network=)", () => {
  let tmpDir: string;
  let configPath: string;
  let savedNetworksConfig: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-networks-deploy-test-"));
    savedNetworksConfig = process.env["NETWORKS_CONFIG"];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedNetworksConfig === undefined) {
      delete process.env["NETWORKS_CONFIG"];
    } else {
      process.env["NETWORKS_CONFIG"] = savedNetworksConfig;
    }
  });

  function writeNetworksConfig(config: unknown): void {
    configPath = path.join(tmpDir, "networks.json");
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
    process.env["NETWORKS_CONFIG"] = configPath;
  }

  it("uses the selected network's rpcUrl, deployerPrivateKey, and deploymentDir", async () => {
    const networkADir = path.join(tmpDir, "network-a-journal");
    const networkBDir = path.join(tmpDir, "network-b-journal");
    writeNetworksConfig({
      networks: {
        alpha: {
          rpcUrl: "http://alpha-rpc.internal.example.com",
          deployerPrivateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deploymentDir: networkADir,
        },
        beta: {
          rpcUrl: "http://beta-rpc.internal.example.com",
          deployerPrivateKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          deploymentDir: networkBDir,
        },
      },
    });

    const coreMod = vi.mocked(await import("@redeploy/core"));

    const resA = await doRequest(port, "POST", "/api/deploy?network=alpha", JSON.stringify(VALID_SPEC));
    expect(resA.statusCode).toBe(200);

    expect(coreMod.jsonRpcProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rpcUrl: "http://alpha-rpc.internal.example.com",
        privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    expect(coreMod.deploy).toHaveBeenLastCalledWith(
      expect.objectContaining({ deploymentDir: networkADir }),
    );

    const resB = await doRequest(port, "POST", "/api/deploy?network=beta", JSON.stringify(VALID_SPEC));
    expect(resB.statusCode).toBe(200);

    expect(coreMod.jsonRpcProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rpcUrl: "http://beta-rpc.internal.example.com",
        privateKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    );
    expect(coreMod.deploy).toHaveBeenLastCalledWith(
      expect.objectContaining({ deploymentDir: networkBDir }),
    );

    // The two networks' journal directories must be distinct (resume state isolation).
    expect(networkADir).not.toBe(networkBDir);
  });

  it("forwards the network's deploymentParameters wrapped under moduleId to core.deploy", async () => {
    writeNetworksConfig({
      networks: {
        alpha: {
          rpcUrl: "http://alpha-rpc.internal.example.com",
          deployerPrivateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deploymentDir: path.join(tmpDir, "alpha-journal"),
          moduleId: "CustomModule",
          deploymentParameters: { someParam: 42 },
        },
      },
    });

    const coreMod = vi.mocked(await import("@redeploy/core"));

    const res = await doRequest(port, "POST", "/api/deploy?network=alpha", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    expect(coreMod.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleId: "CustomModule",
        deploymentParameters: { CustomModule: { someParam: 42 } },
      }),
    );
  });

  it("defaults moduleId to 'Deployment' and omits deploymentParameters when not configured", async () => {
    writeNetworksConfig({
      networks: {
        alpha: {
          rpcUrl: "http://alpha-rpc.internal.example.com",
          deployerPrivateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deploymentDir: path.join(tmpDir, "alpha-journal"),
        },
      },
    });

    const coreMod = vi.mocked(await import("@redeploy/core"));

    const res = await doRequest(port, "POST", "/api/deploy?network=alpha", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    expect(coreMod.deploy).toHaveBeenCalledWith(expect.objectContaining({ moduleId: "Deployment" }));
    const callArgs = coreMod.deploy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs["deploymentParameters"]).toBeUndefined();
  });

  it("an unknown ?network= value → 400 Bad Request (non-SSE), core.deploy never called, no secret leak", async () => {
    writeNetworksConfig({
      networks: {
        alpha: { rpcUrl: "http://alpha-rpc.internal.example.com" },
      },
    });

    const coreMod = vi.mocked(await import("@redeploy/core"));

    const res = await doRequest(port, "POST", "/api/deploy?network=nonexistent", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
    expect(res.body).not.toContain("nonexistent");

    expect(coreMod.deploy).not.toHaveBeenCalled();
    expect(coreMod.jsonRpcProvider).not.toHaveBeenCalled();
  });

  it("stops at 400 before opening the SSE stream for an unknown network", async () => {
    writeNetworksConfig({ networks: { alpha: { rpcUrl: "http://alpha-rpc.internal.example.com" } } });

    const res = await doRequest(port, "POST", "/api/deploy?network=nonexistent", JSON.stringify(VALID_SPEC));
    expect(res.headers["content-type"]).not.toMatch(/text\/event-stream/);
  });

  it("omitting ?network= falls back to the default network (backward compat with legacy env vars)", async () => {
    writeNetworksConfig({ networks: { alpha: { rpcUrl: "http://alpha-rpc.internal.example.com" } } });
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env["RPC_URL"] = "http://legacy-default-rpc.example.com";

    const coreMod = vi.mocked(await import("@redeploy/core"));

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    expect(coreMod.jsonRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ rpcUrl: "http://legacy-default-rpc.example.com" }),
    );
  });

  it("a network missing a configured deployer private key → done{success:false}, names the network, no crash", async () => {
    writeNetworksConfig({
      networks: {
        alpha: { rpcUrl: "http://alpha-rpc.internal.example.com" }, // no deployerPrivateKey / deployerPrivateKeyEnv
      },
    });

    const res = await doRequest(port, "POST", "/api/deploy?network=alpha", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    const errors = done["errors"] as Array<Record<string, unknown>>;
    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0]!["message"])).toContain("alpha");
  });

  it("a malformed NETWORKS_CONFIG file → 500 generic error, never leaking the file path", async () => {
    configPath = path.join(tmpDir, "bad-networks.json");
    fs.writeFileSync(configPath, "{ not valid json", "utf8");
    process.env["NETWORKS_CONFIG"] = configPath;

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
    expect(res.body).not.toContain(configPath);
    expect(res.body).not.toContain(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Multi-network support (issue #139) — snapshot network label
// ---------------------------------------------------------------------------

describe("POST /api/deploy — snapshot records the selected network label", () => {
  let tmpDir: string;
  let savedNetworksConfig: string | undefined;
  let savedDeploymentDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-networks-snapshot-test-"));
    savedNetworksConfig = process.env["NETWORKS_CONFIG"];
    savedDeploymentDir = process.env["DEPLOYMENT_DIR"];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedNetworksConfig === undefined) {
      delete process.env["NETWORKS_CONFIG"];
    } else {
      process.env["NETWORKS_CONFIG"] = savedNetworksConfig;
    }
    if (savedDeploymentDir === undefined) {
      delete process.env["DEPLOYMENT_DIR"];
    } else {
      process.env["DEPLOYMENT_DIR"] = savedDeploymentDir;
    }
  });

  it("buildSnapshot is called with network: '<name>' for a selected non-default network", async () => {
    const journalDir = path.join(tmpDir, "alpha-journal");
    const configPath = path.join(tmpDir, "networks.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        networks: {
          alpha: {
            rpcUrl: "http://alpha-rpc.internal.example.com",
            deployerPrivateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            deploymentDir: journalDir,
          },
        },
      }),
      "utf8",
    );
    process.env["NETWORKS_CONFIG"] = configPath;

    const readerMod = vi.mocked(await import("@redeploy/reader"));

    const res = await doRequest(port, "POST", "/api/deploy?network=alpha", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    expect(readerMod.buildSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ network: "alpha" }),
    );
  });

  it("buildSnapshot is called with network: 'default' when no ?network= is given", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env["DEPLOYMENT_DIR"] = tmpDir;

    const readerMod = vi.mocked(await import("@redeploy/reader"));

    const res = await doRequest(port, "POST", "/api/deploy", JSON.stringify(VALID_SPEC));
    expect(res.statusCode).toBe(200);

    expect(readerMod.buildSnapshot).toHaveBeenCalledWith(expect.objectContaining({ network: "default" }));
  });
});

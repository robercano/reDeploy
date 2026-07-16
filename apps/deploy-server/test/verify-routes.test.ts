/**
 * Tests for POST /api/verify/config and POST /api/verify/source.
 *
 * Mirrors deployment.test.ts's approach: @redeploy/reader and
 * @redeploy/core's foundryArtifactResolver are exercised for REAL against
 * temp-dir fixtures (a real journal + real Foundry artifact JSON), so only
 * the network layer ("viem"'s createPublicClient, and global fetch for
 * Etherscan submissions) is mocked — no live chain/Anvil required.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Server, request as httpRequest } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// viem mock — controls chainId + readContract for both endpoints.
// ---------------------------------------------------------------------------

const getChainIdSpy = vi.fn();
const readContractSpy = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const original = await importOriginal<typeof import("viem")>();
  return {
    ...original,
    createPublicClient: vi.fn(() => ({
      getChainId: (...args: unknown[]) => getChainIdSpy(...args),
      readContract: (...args: unknown[]) => readContractSpy(...args),
    })),
    http: vi.fn((url: string) => ({ type: "http", url })),
  };
});

import { createServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Test helpers (mirrors deployment.test.ts / deploy.test.ts)
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function doRequest(port: number, method: string, urlPath: string, body?: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers =
      body !== undefined
        ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }
        : {};
    const req = httpRequest({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
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
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function writeJournal(dir: string, records: object[]): void {
  const lines = records.map((r) => "\n" + JSON.stringify(r));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), lines.join(""), "utf8");
}

function writeDeployedAddresses(dir: string, addresses: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, "deployed_addresses.json"), JSON.stringify(addresses), "utf8");
}

function writeArtifact(outDir: string, contractsRoot: string, name: string, abi: unknown[]): void {
  const sourceRel = `src/${name}.sol`;
  const srcAbs = path.join(contractsRoot, sourceRel);
  fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
  fs.writeFileSync(srcAbs, `contract ${name} {}`);

  const dir = path.join(outDir, `${name}.sol`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      abi,
      bytecode: { object: "0x00" },
      metadata: {
        language: "Solidity",
        compiler: { version: "0.8.28+commit.7893614a" },
        sources: { [sourceRel]: {} },
        settings: {},
      },
    }),
  );
}

const FEE_CONTROLLER_ADDRESS = "0x1111111111111111111111111111111111111111";

const GET_FEE_ABI = [
  {
    type: "function",
    name: "getFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
  },
];

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
// Env + fixture setup
// ---------------------------------------------------------------------------

let deploymentDir: string;
let contractsRoot: string;
let outDir: string;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = ["DEPLOYMENT_DIR", "FOUNDRY_OUT", "RPC_URL", "ETHERSCAN_API_KEY", "ETHERSCAN_API_URL"];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-verify-routes-deployment-"));
  contractsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-verify-routes-contracts-"));
  outDir = path.join(contractsRoot, "out");
  fs.mkdirSync(outDir, { recursive: true });

  writeJournal(deploymentDir, [
    {
      type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
      futureId: "Deployment#feeController",
      contractName: "FeeController",
      constructorArgs: [],
      libraries: {},
      dependencies: [],
    },
    {
      type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
      futureId: "Deployment#feeController",
      result: { type: "SUCCESS", address: FEE_CONTROLLER_ADDRESS },
    },
  ]);
  writeDeployedAddresses(deploymentDir, { "Deployment#feeController": FEE_CONTROLLER_ADDRESS });
  writeArtifact(outDir, contractsRoot, "FeeController", GET_FEE_ABI);

  process.env["DEPLOYMENT_DIR"] = deploymentDir;
  process.env["FOUNDRY_OUT"] = outDir;
  process.env["RPC_URL"] = "http://127.0.0.1:8545";
  delete process.env["ETHERSCAN_API_KEY"];
  delete process.env["ETHERSCAN_API_URL"];

  getChainIdSpy.mockReset();
  readContractSpy.mockReset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(deploymentDir, { recursive: true, force: true });
  fs.rmSync(contractsRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// POST /api/verify/config
// ---------------------------------------------------------------------------

describe("POST /api/verify/config", () => {
  const SET_FEE_SPEC = JSON.stringify({
    version: 1,
    steps: [
      {
        kind: "setX",
        id: "set-fee",
        target: "feeController",
        function: "setFee",
        args: [{ kind: "literal", value: 500 }],
      },
    ],
  });

  it("malformed JSON body -> 400", async () => {
    const res = await doRequest(port, "POST", "/api/verify/config", "{ not valid json }");
    expect(res.statusCode).toBe(400);
  });

  it("body missing a steps array -> 400", async () => {
    const res = await doRequest(port, "POST", "/api/verify/config", JSON.stringify({ version: 1 }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: expect.stringContaining("steps") });
  });

  it("200s with clean:true and a 'match' result when the on-chain value equals expected", async () => {
    readContractSpy.mockResolvedValue(500n);

    const res = await doRequest(port, "POST", "/api/verify/config", SET_FEE_SPEC);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body) as { clean: boolean; results: Array<Record<string, unknown>> };
    expect(body.clean).toBe(true);
    // bigint on-chain values are normalized to { $bigint: "<decimal>" } for
    // JSON-safety (JSON.stringify() throws on a raw bigint).
    expect(body.results).toEqual([
      { id: "set-fee", status: "match", expected: 500, actual: { $bigint: "500" } },
    ]);
    expect(readContractSpy).toHaveBeenCalledWith(
      expect.objectContaining({ address: FEE_CONTROLLER_ADDRESS, functionName: "getFee" }),
    );
  });

  it("200s with clean:false and a 'drift' result when the on-chain value differs", async () => {
    readContractSpy.mockResolvedValue(999n);

    const res = await doRequest(port, "POST", "/api/verify/config", SET_FEE_SPEC);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { clean: boolean; results: Array<Record<string, unknown>> };
    expect(body.clean).toBe(false);
    expect(body.results[0]).toMatchObject({ id: "set-fee", status: "drift" });
  });

  it("a step with no derivable getter mapping is 'skipped', not a 500", async () => {
    const spec = JSON.stringify({
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "update-fee",
          target: "feeController",
          function: "updateFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    });

    const res = await doRequest(port, "POST", "/api/verify/config", spec);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { clean: boolean; results: Array<Record<string, unknown>> };
    expect(body.clean).toBe(true);
    expect(body.results[0]).toMatchObject({ id: "update-fee", status: "skipped" });
    expect(readContractSpy).not.toHaveBeenCalled();
  });

  it("a step referencing an undeployed contract id is an 'error' result, not a 500", async () => {
    const spec = JSON.stringify({
      version: 1,
      steps: [{ kind: "setX", id: "set-x", target: "notDeployed", function: "setFee", args: [{ kind: "literal", value: 1 }] }],
    });

    const res = await doRequest(port, "POST", "/api/verify/config", spec);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { clean: boolean; results: Array<Record<string, unknown>> };
    expect(body.clean).toBe(false);
    expect(body.results[0]).toMatchObject({ id: "set-x", status: "error" });
  });

  it("SECURITY: RPC_URL sentinel never appears in the response", async () => {
    process.env["RPC_URL"] = "http://secret-rpc.internal.example.com";
    readContractSpy.mockResolvedValue(500n);

    const res = await doRequest(port, "POST", "/api/verify/config", SET_FEE_SPEC);

    expect(res.body).not.toContain("secret-rpc.internal.example.com");
  });
});

// ---------------------------------------------------------------------------
// POST /api/verify/source
// ---------------------------------------------------------------------------

describe("POST /api/verify/source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("malformed JSON body -> 400", async () => {
    const res = await doRequest(port, "POST", "/api/verify/source", "{ not valid json }");
    expect(res.statusCode).toBe(400);
  });

  it("200s with skipped:true when ETHERSCAN_API_KEY is not configured", async () => {
    getChainIdSpy.mockResolvedValue(1);

    const res = await doRequest(port, "POST", "/api/verify/source", "{}");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { skipped: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toContain("ETHERSCAN_API_KEY");
  });

  it("200s with skipped:true on a local Anvil chainId (31337), even with an API key configured", async () => {
    process.env["ETHERSCAN_API_KEY"] = "test-etherscan-key";
    getChainIdSpy.mockResolvedValue(31337);

    const res = await doRequest(port, "POST", "/api/verify/source", "{}");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { skipped: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toContain("Anvil");
  });

  it("502s with a generic error when the RPC endpoint cannot be reached (chainId lookup fails)", async () => {
    process.env["ETHERSCAN_API_KEY"] = "test-etherscan-key";
    getChainIdSpy.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await doRequest(port, "POST", "/api/verify/source", "{}");

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: expect.any(String) });
  });

  it("submits the deployed contract to Etherscan and returns its result when a key is configured on a public chainId", async () => {
    const SENTINEL_KEY = "sentinel-etherscan-key-0xdeadbeef";
    process.env["ETHERSCAN_API_KEY"] = SENTINEL_KEY;
    getChainIdSpy.mockResolvedValue(1);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "1", result: "already verified" }),
      text: async () => JSON.stringify({ status: "1", result: "already verified" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await doRequest(port, "POST", "/api/verify/source", "{}");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      skipped: boolean;
      results: Array<{ id: string; address: string; status: string }>;
    };
    expect(body.skipped).toBe(false);
    expect(body.results).toEqual([
      { id: "feeController", address: FEE_CONTROLLER_ADDRESS, status: "already-verified" },
    ]);

    // SECURITY: the API key must never appear in the response, even though it
    // was used to build the (mocked) outgoing request.
    expect(res.body).not.toContain(SENTINEL_KEY);
  });
});

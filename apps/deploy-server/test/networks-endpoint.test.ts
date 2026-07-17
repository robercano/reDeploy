/**
 * Tests for GET /api/networks (issue #139): the endpoint the studio uses to
 * populate its network selector.
 *
 * Covers:
 *   - Default (no NETWORKS_CONFIG) → single "default" network, no chainId.
 *   - A configured NETWORKS_CONFIG → every registered network is listed,
 *     including chainId when set.
 *   - defaultNetwork correctness (file-level override).
 *   - SECURITY: no secret/path field (rpcUrl, deployerPrivateKey,
 *     deploymentDir, deploymentParameters, moduleId) ever appears in the
 *     response body.
 *   - A malformed NETWORKS_CONFIG file → 500 generic error, never leaking
 *     the file path.
 *   - Method/route negatives.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Server, request as httpRequest } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function doRequest(port: number, method: string, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path }, (res) => {
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
    req.end();
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
// Save/restore NETWORKS_CONFIG / DEFAULT_NETWORK around tests
// ---------------------------------------------------------------------------

let savedNetworksConfig: string | undefined;
let savedDefaultNetwork: string | undefined;
let tmpDir: string | undefined;

beforeEach(() => {
  savedNetworksConfig = process.env["NETWORKS_CONFIG"];
  savedDefaultNetwork = process.env["DEFAULT_NETWORK"];
});

afterEach(() => {
  if (savedNetworksConfig === undefined) {
    delete process.env["NETWORKS_CONFIG"];
  } else {
    process.env["NETWORKS_CONFIG"] = savedNetworksConfig;
  }
  if (savedDefaultNetwork === undefined) {
    delete process.env["DEFAULT_NETWORK"];
  } else {
    process.env["DEFAULT_NETWORK"] = savedDefaultNetwork;
  }
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeNetworksConfig(content: unknown): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-networks-endpoint-test-"));
  const configPath = path.join(tmpDir, "networks.json");
  fs.writeFileSync(configPath, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return configPath;
}

// ---------------------------------------------------------------------------
// GET /api/networks — success
// ---------------------------------------------------------------------------

describe("GET /api/networks — success", () => {
  it("no NETWORKS_CONFIG → lists just the legacy 'default' network, no chainId", async () => {
    delete process.env["NETWORKS_CONFIG"];

    const res = await doRequest(port, "GET", "/api/networks");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body) as { networks: Array<{ name: string; chainId?: number }>; defaultNetwork: string };
    expect(body.defaultNetwork).toBe("default");
    expect(body.networks).toEqual([{ name: "default" }]);
  });

  it("lists every configured network by name, with chainId when set", async () => {
    const configPath = writeNetworksConfig({
      networks: {
        local: { rpcUrl: "http://127.0.0.1:9545" },
        sepolia: { rpcUrl: "https://sepolia.example.com/v3/KEY", chainId: 11155111 },
      },
    });
    process.env["NETWORKS_CONFIG"] = configPath;

    const res = await doRequest(port, "GET", "/api/networks");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { networks: Array<{ name: string; chainId?: number }>; defaultNetwork: string };
    expect(body.networks).toHaveLength(3); // default + local + sepolia
    expect(body.networks).toContainEqual({ name: "default" });
    expect(body.networks).toContainEqual({ name: "local" });
    expect(body.networks).toContainEqual({ name: "sepolia", chainId: 11155111 });
  });

  it("reflects a configured defaultNetwork", async () => {
    const configPath = writeNetworksConfig({
      defaultNetwork: "sepolia",
      networks: { sepolia: { rpcUrl: "https://sepolia.example.com" } },
    });
    process.env["NETWORKS_CONFIG"] = configPath;

    const res = await doRequest(port, "GET", "/api/networks");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { defaultNetwork: string };
    expect(body.defaultNetwork).toBe("sepolia");
  });

  it("DEFAULT_NETWORK env var override is reflected in defaultNetwork", async () => {
    const configPath = writeNetworksConfig({
      networks: {
        mainnet: { rpcUrl: "https://mainnet.example.com" },
      },
    });
    process.env["NETWORKS_CONFIG"] = configPath;
    process.env["DEFAULT_NETWORK"] = "mainnet";

    const res = await doRequest(port, "GET", "/api/networks");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { defaultNetwork: string };
    expect(body.defaultNetwork).toBe("mainnet");
  });
});

// ---------------------------------------------------------------------------
// GET /api/networks — secrets are never leaked
// ---------------------------------------------------------------------------

describe("GET /api/networks — no secret/path leakage", () => {
  it("never includes rpcUrl, deployerPrivateKey, deploymentDir, deploymentParameters, or moduleId", async () => {
    const configPath = writeNetworksConfig({
      networks: {
        sepolia: {
          rpcUrl: "https://sepolia.example.com/v3/SECRET_API_KEY",
          chainId: 11155111,
          deployerPrivateKey: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          deploymentDir: "/var/redeploy/secret-path",
          moduleId: "Deployment",
          deploymentParameters: { secretParam: "shh" },
        },
      },
    });
    process.env["NETWORKS_CONFIG"] = configPath;

    const res = await doRequest(port, "GET", "/api/networks");

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("SECRET_API_KEY");
    expect(res.body).not.toContain("deadbeef");
    expect(res.body).not.toContain("secret-path");
    expect(res.body).not.toContain("secretParam");
    expect(res.body).not.toContain("shh");
    expect(res.body).not.toContain("rpcUrl");
    expect(res.body).not.toContain("deployerPrivateKey");
    expect(res.body).not.toContain("deploymentDir");
    expect(res.body).not.toContain("deploymentParameters");
    expect(res.body).not.toContain("moduleId");

    const body = JSON.parse(res.body) as { networks: Array<Record<string, unknown>> };
    const sepolia = body.networks.find((n) => n["name"] === "sepolia");
    expect(sepolia).toBeDefined();
    expect(Object.keys(sepolia as object).sort()).toEqual(["chainId", "name"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/networks — malformed NETWORKS_CONFIG → 500
// ---------------------------------------------------------------------------

describe("GET /api/networks — bad config", () => {
  it("a malformed NETWORKS_CONFIG file → 500 generic error, never leaking the file path", async () => {
    const configPath = writeNetworksConfig("{ not valid json");
    process.env["NETWORKS_CONFIG"] = configPath;

    const res = await doRequest(port, "GET", "/api/networks");

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
    expect(res.body).not.toContain(configPath);
    expect(res.body).not.toContain(tmpDir as string);
  });
});

// ---------------------------------------------------------------------------
// GET /api/networks — route negatives
// ---------------------------------------------------------------------------

describe("POST /api/networks — falls through to 404", () => {
  it("404s for a non-GET method on /api/networks", async () => {
    const res = await doRequest(port, "POST", "/api/networks");
    expect(res.statusCode).toBe(404);
  });
});

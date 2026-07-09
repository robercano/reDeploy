/**
 * Tests for GET /api/deployment.
 *
 * Unlike deploy.test.ts, this suite does NOT mock @redeploy/reader — it
 * exercises the real readDeployment() against real journal fixtures written
 * to a temp DEPLOYMENT_DIR, mirroring the fixture-building conventions in
 * packages/reader/test/index.test.ts.
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

/**
 * Write Ignition's journal.jsonl format:
 * Each record is prepended with "\n" + JSON.stringify(record).
 * File starts with a blank line, no trailing newline.
 */
function writeJournal(dir: string, records: object[]): void {
  const lines = records.map((r) => "\n" + JSON.stringify(r));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), lines.join(""), "utf8");
}

function writeDeployedAddresses(dir: string, addresses: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, "deployed_addresses.json"), JSON.stringify(addresses), "utf8");
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
// Save/restore DEPLOYMENT_DIR around tests that manipulate it
// ---------------------------------------------------------------------------

let savedDeploymentDir: string | undefined;

beforeEach(() => {
  savedDeploymentDir = process.env["DEPLOYMENT_DIR"];
});

afterEach(() => {
  if (savedDeploymentDir === undefined) {
    delete process.env["DEPLOYMENT_DIR"];
  } else {
    process.env["DEPLOYMENT_DIR"] = savedDeploymentDir;
  }
});

// ---------------------------------------------------------------------------
// GET /api/deployment — success
// ---------------------------------------------------------------------------

describe("GET /api/deployment — success", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-deployment-endpoint-test-"));
    process.env["DEPLOYMENT_DIR"] = tmpDir;

    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#token",
        contractName: "Token",
        constructorArgs: ["My Token"],
        libraries: {},
        dependencies: [],
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
        futureId: "Deployment#token",
        result: { type: "SUCCESS", address: "0x2222222222222222222222222222222222222222" },
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#vault",
        contractName: "Vault",
        constructorArgs: [],
        libraries: {},
        dependencies: ["Deployment#token"],
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
        futureId: "Deployment#vault",
        result: { type: "SUCCESS", address: "0x3333333333333333333333333333333333333333" },
      },
    ]);

    writeDeployedAddresses(tmpDir, {
      "Deployment#token": "0x2222222222222222222222222222222222222222",
      "Deployment#vault": "0x3333333333333333333333333333333333333333",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("200s with a JSON DeploymentView reflecting the journal fixture", async () => {
    const res = await doRequest(port, "GET", "/api/deployment");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");

    const view = JSON.parse(res.body) as {
      contracts: Array<Record<string, unknown>>;
      configSteps: unknown[];
      warnings: unknown[];
    };

    expect(view.contracts).toHaveLength(2);
    const token = view.contracts.find((c) => c["id"] === "token");
    expect(token).toBeDefined();
    expect(token?.["contractName"]).toBe("Token");
    expect(token?.["address"]).toBe("0x2222222222222222222222222222222222222222");

    const vault = view.contracts.find((c) => c["id"] === "vault");
    expect(vault).toBeDefined();
    expect(vault?.["address"]).toBe("0x3333333333333333333333333333333333333333");

    expect(view.configSteps).toEqual([]);
    expect(Array.isArray(view.warnings)).toBe(true);
  });

  it("routes correctly even with a trailing query string", async () => {
    const res = await doRequest(port, "GET", "/api/deployment?foo=1");
    expect(res.statusCode).toBe(200);
    const view = JSON.parse(res.body) as { contracts: unknown[] };
    expect(view.contracts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/deployment — fresh / never-deployed directory
// ---------------------------------------------------------------------------

describe("GET /api/deployment — fresh deployment dir", () => {
  it("200s with an empty DeploymentView when DEPLOYMENT_DIR does not exist", async () => {
    const missingDir = path.join(
      os.tmpdir(),
      "redeploy-deployment-endpoint-test-missing",
      `does-not-exist-${Date.now()}`,
    );
    process.env["DEPLOYMENT_DIR"] = missingDir;

    const res = await doRequest(port, "GET", "/api/deployment");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ contracts: [], configSteps: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// GET /api/deployment — read error → 500 generic body
// ---------------------------------------------------------------------------

describe("GET /api/deployment — read error", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-deployment-endpoint-readerr-"));
    process.env["DEPLOYMENT_DIR"] = tmpDir;
    // journal.jsonl as a DIRECTORY forces readDeployment() to throw
    // ReadError("JOURNAL_READ_ERROR") — same technique used by
    // packages/reader/test/index.test.ts.
    fs.mkdirSync(path.join(tmpDir, "journal.jsonl"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("500s with a generic JSON error body that does not leak the directory path", async () => {
    const res = await doRequest(port, "GET", "/api/deployment");

    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "Failed to read deployment state" });
    expect(res.body).not.toContain(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// GET /api/deployment — method negative
// ---------------------------------------------------------------------------

describe("POST /api/deployment — falls through to 404", () => {
  it("404s for a non-GET method on /api/deployment", async () => {
    const res = await doRequest(port, "POST", "/api/deployment");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not Found" });
  });
});

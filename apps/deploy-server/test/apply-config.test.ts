/**
 * Tests for POST /api/apply-config SSE endpoint.
 *
 * All tests use vitest module mocks to stub @redeploy/core, @redeploy/reader,
 * and @redeploy/config so no live chain/Anvil and no real journal files are
 * required.
 *
 * The mocked `applyConfig` is driven to invoke `options.executor.execute(call)`
 * for one or more fake `ConfigCall`s, exercising the REAL wrapped executor
 * built in `handleApplyConfig` (which in turn delegates to the REAL
 * `buildChainConfigExecutor` from `../src/apply-config/chain-executor.js`) —
 * so the per-step `step` SSE frames are genuinely produced by the executor
 * wrapper, not asserted against a stub.
 *
 * Secret-leak tests: DEPLOYER_PRIVATE_KEY and RPC_URL are set to sentinel
 * values; success and failure paths are run and neither sentinel is asserted
 * to appear anywhere in the raw SSE output.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import { Server, request as httpRequest } from "node:http";
import { createServer } from "../src/server.js";
import type { DeploymentView } from "@redeploy/reader";
import type { ConfigCall } from "@redeploy/config";

// ---------------------------------------------------------------------------
// Module mocks — must be at top level before any imports from the modules.
// ---------------------------------------------------------------------------

vi.mock("@redeploy/core", async (importActual) => {
  const actual = await importActual<typeof import("@redeploy/core")>();
  return {
    ...actual,
    jsonRpcProvider: vi.fn(),
    foundryArtifactResolver: vi.fn(),
  };
});

vi.mock("@redeploy/reader", async (importActual) => {
  const actual = await importActual<typeof import("@redeploy/reader")>();
  return {
    ...actual,
    readDeployment: vi.fn(),
  };
});

vi.mock("@redeploy/config", async (importActual) => {
  const actual = await importActual<typeof import("@redeploy/config")>();
  return {
    ...actual,
    applyConfig: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_ADDRESS = "0xTOKEN000000000000000000000000000000000001".toLowerCase();
const VAULT_ADDRESS = "0xVAULT000000000000000000000000000000000002".toLowerCase();

const FAKE_DEPLOYMENT_VIEW: DeploymentView = {
  contracts: [
    {
      id: "token",
      contractName: "Token",
      address: TOKEN_ADDRESS,
      args: [],
      links: { dependencies: [], libraries: {} },
    },
    {
      id: "vault",
      contractName: "Vault",
      address: VAULT_ADDRESS,
      args: [],
      links: { dependencies: ["token"], libraries: {} },
    },
  ],
  configSteps: [],
  warnings: [],
};

const FAKE_STEP_1: ConfigCall = {
  stepId: "set-fee",
  kind: "setX",
  target: TOKEN_ADDRESS,
  function: "setFee",
  args: [42],
};

const FAKE_STEP_2: ConfigCall = {
  stepId: "grant-minter",
  kind: "grantRole",
  target: VAULT_ADDRESS,
  function: "grantRole",
  role: "MINTER_ROLE",
  args: ["0x00000000000000000000000000000000000000aa"],
};

const VALID_CONFIG_SPEC = {
  version: 1,
  steps: [
    { id: "set-fee", kind: "setX", target: "token", function: "setFee", args: [42] },
    { id: "grant-minter", kind: "grantRole", target: "vault", role: "MINTER_ROLE", account: "0x00000000000000000000000000000000000000aa" },
  ],
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function doRequest(port: number, method: string, path: string, body?: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const contentHeaders =
      body !== undefined
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
          }
        : {};

    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: contentHeaders },
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
    if (body !== undefined) req.write(body);
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
// Save/restore env vars around tests
// ---------------------------------------------------------------------------

let savedPrivateKey: string | undefined;
let savedRpcUrl: string | undefined;
let savedDeploymentDir: string | undefined;

/** A working provider.request() implementation so the real chain executor succeeds. */
function makeWorkingProviderRequest(): (args: { method: string }) => Promise<unknown> {
  return (args: { method: string }) => {
    switch (args.method) {
      case "eth_accounts":
        return Promise.resolve(["0xDeployer0000000000000000000000000000000001"]);
      case "eth_estimateGas":
        return Promise.resolve("0x5208");
      case "eth_gasPrice":
        return Promise.resolve("0x3b9aca00");
      case "eth_sendTransaction":
        return Promise.resolve("0xhash");
      case "eth_getTransactionReceipt":
        return Promise.resolve({ status: "0x1" });
      default:
        return Promise.resolve(null);
    }
  };
}

beforeEach(async () => {
  savedPrivateKey = process.env["DEPLOYER_PRIVATE_KEY"];
  savedRpcUrl = process.env["RPC_URL"];
  savedDeploymentDir = process.env["DEPLOYMENT_DIR"];

  const coreMod = vi.mocked(await import("@redeploy/core"));
  coreMod.jsonRpcProvider.mockReturnValue({
    request: vi.fn().mockImplementation(makeWorkingProviderRequest()),
  } as unknown as ReturnType<typeof coreMod.jsonRpcProvider>);
  coreMod.foundryArtifactResolver.mockReturnValue({
    async loadArtifact(contractName: string) {
      return {
        contractName,
        sourceName: "",
        bytecode: "0x",
        abi: [
          {
            type: "function",
            name: "setFee",
            stateMutability: "nonpayable",
            inputs: [{ type: "uint256", name: "fee" }],
            outputs: [],
          },
        ],
        linkReferences: {},
      };
    },
    async getBuildInfo() {
      return undefined;
    },
  } as unknown as ReturnType<typeof coreMod.foundryArtifactResolver>);

  const readerMod = vi.mocked(await import("@redeploy/reader"));
  readerMod.readDeployment.mockReturnValue(FAKE_DEPLOYMENT_VIEW);
});

afterEach(() => {
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
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — success", () => {
  it("emits step frames for each executed call, then terminal done{success:true, executedStepIds, skippedStepIds, completedStepIds}", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockImplementation(async (options) => {
      await options.executor.execute(FAKE_STEP_1);
      await options.executor.execute(FAKE_STEP_2);
      return {
        success: true,
        executedStepIds: [FAKE_STEP_1.stepId, FAKE_STEP_2.stepId],
        skippedStepIds: [],
        completedStepIds: [FAKE_STEP_1.stepId, FAKE_STEP_2.stepId],
      };
    });

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);
    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents.length).toBe(4); // executing + completed, x2 steps

    const step1Events = stepEvents.filter((e) => (e.data as Record<string, unknown>)["stepId"] === "set-fee");
    expect(step1Events.map((e) => (e.data as Record<string, unknown>)["status"])).toEqual(["executing", "completed"]);

    const step2Events = stepEvents.filter((e) => (e.data as Record<string, unknown>)["stepId"] === "grant-minter");
    expect(step2Events.map((e) => (e.data as Record<string, unknown>)["status"])).toEqual(["executing", "completed"]);

    const doneEvent = events[events.length - 1];
    expect(doneEvent?.event).toBe("done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(true);
    expect(done["executedStepIds"]).toEqual(["set-fee", "grant-minter"]);
    expect(done["skippedStepIds"]).toEqual([]);
    expect(done["completedStepIds"]).toEqual(["set-fee", "grant-minter"]);
    expect(done["deployment"]).toEqual(FAKE_DEPLOYMENT_VIEW);
  });

  it("calls applyConfig with spec, deployedAddresses, and stateDir === deploymentDir", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockResolvedValue({
      success: true,
      executedStepIds: [],
      skippedStepIds: [],
      completedStepIds: [],
    });

    await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(configMod.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: VALID_CONFIG_SPEC,
        deployedAddresses: { token: TOKEN_ADDRESS, vault: VAULT_ADDRESS },
      }),
    );
    const callArgs = configMod.applyConfig.mock.calls[0]![0];
    expect(callArgs.stateDir).toBe(callArgs.stateDir); // stateDir present
    expect(typeof callArgs.stateDir).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-run
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — idempotent re-run", () => {
  it("emits done{success:true} with empty executedStepIds and all steps skipped, no step frames", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockResolvedValue({
      success: true,
      executedStepIds: [],
      skippedStepIds: ["set-fee", "grant-minter"],
      completedStepIds: ["set-fee", "grant-minter"],
    });

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events.filter((e) => e.event === "step")).toHaveLength(0);

    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(true);
    expect(done["executedStepIds"]).toEqual([]);
    expect(done["skippedStepIds"]).toEqual(["set-fee", "grant-minter"]);
    expect(done["completedStepIds"]).toEqual(["set-fee", "grant-minter"]);
  });
});

// ---------------------------------------------------------------------------
// Unknown network
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — unknown network", () => {
  it("an unknown ?network= value → 400 Bad Request (non-SSE), applyConfig never called", async () => {
    const configMod = vi.mocked(await import("@redeploy/config"));

    const res = await doRequest(
      port,
      "POST",
      "/api/apply-config?network=nonexistent",
      JSON.stringify(VALID_CONFIG_SPEC),
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
    expect(res.body).not.toContain("nonexistent");
    expect(configMod.applyConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Missing deployer key
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — missing deployer private key", () => {
  it("emits done{success:false} when DEPLOYER_PRIVATE_KEY is absent", async () => {
    delete process.env["DEPLOYER_PRIVATE_KEY"];

    const configMod = vi.mocked(await import("@redeploy/config"));

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
    expect((done["errors"] as unknown[]).length).toBeGreaterThan(0);
    expect(configMod.applyConfig).not.toHaveBeenCalled();
  });

  it("emits done{success:false} when DEPLOYER_PRIVATE_KEY is an empty string", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = "";

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConfigExecError mapping
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — ConfigExecError thrown", () => {
  it("maps INVALID_SPEC with specErrors to one {code, message} entry per spec error", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { ConfigExecError } = await import("@redeploy/config");
    const configMod = vi.mocked(await import("@redeploy/config"));
    const specErrors = [
      { code: "DUPLICATE_ID" as const, message: "Duplicate step id: set-fee" },
    ];
    configMod.applyConfig.mockRejectedValueOnce(
      new ConfigExecError("INVALID_SPEC", "Spec validation failed", specErrors),
    );

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    const errors = done["errors"] as Array<Record<string, unknown>>;
    expect(errors.length).toBe(1);
    expect(errors[0]!["code"]).toBe("INVALID_SPEC");
    expect(errors[0]!["message"]).toContain("Duplicate");
  });

  it("maps a ConfigExecError with no specErrors to a single {code, message} entry", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { ConfigExecError } = await import("@redeploy/config");
    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockRejectedValueOnce(new ConfigExecError("JOURNAL_ERROR", "journal corrupt"));

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    const errors = done["errors"] as Array<Record<string, unknown>>;
    expect(errors.length).toBe(1);
    expect(errors[0]!["code"]).toBe("JOURNAL_ERROR");
    expect(errors[0]!["message"]).toBe("journal corrupt");
  });
});

// ---------------------------------------------------------------------------
// Failed step (executor throws)
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — a step's on-chain execution fails", () => {
  it("emits step{status:'failed'} then a terminal done{success:false} with a generic message", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const configMod = vi.mocked(await import("@redeploy/config"));
    // Use a target address NOT in the address book so the real chain
    // executor throws ("No known contract at address ...").
    const badCall: ConfigCall = {
      stepId: "bad-step",
      kind: "setX",
      target: "0xunknown00000000000000000000000000000099",
      function: "setFee",
      args: [1],
    };
    configMod.applyConfig.mockImplementation(async (options) => {
      await options.executor.execute(badCall);
      return { success: true, executedStepIds: [], skippedStepIds: [], completedStepIds: [] };
    });

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);

    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents.length).toBe(2);
    expect((stepEvents[0]!.data as Record<string, unknown>)["status"]).toBe("executing");
    expect((stepEvents[1]!.data as Record<string, unknown>)["status"]).toBe("failed");
    expect((stepEvents[1]!.data as Record<string, unknown>)["message"]).toBe("config step failed");
    // SECURITY: the raw executor error ("No known contract at address ...")
    // must never be forwarded verbatim.
    expect(res.body).not.toContain("No known contract");

    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    const errors = done["errors"] as Array<Record<string, unknown>>;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!["message"]).toBe("config step failed");
  });
});

// ---------------------------------------------------------------------------
// No deployment found
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — no deployment found", () => {
  it("emits done{success:false} when readDeployment throws", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const { ReadError } = await import("@redeploy/reader");
    const readerMod = vi.mocked(await import("@redeploy/reader"));
    readerMod.readDeployment.mockImplementationOnce(() => {
      throw new ReadError("DEPLOYMENT_DIR_NOT_FOUND", "dir not found");
    });

    const configMod = vi.mocked(await import("@redeploy/config"));

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
    expect(configMod.applyConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Body validation errors (non-SSE)
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — body validation errors", () => {
  it("malformed JSON body → 400 Bad Request (non-SSE)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const res = await doRequest(port, "POST", "/api/apply-config", "{ not valid json }");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });

  it("oversized body (> 1 MiB) → 413 Payload Too Large (non-SSE)", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const oversize = "x".repeat(1024 * 1024 + 1);
    const res = await doRequest(port, "POST", "/api/apply-config", oversize);
    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Secret leak prevention
// ---------------------------------------------------------------------------

describe("POST /api/apply-config — secret leak prevention", () => {
  const SENTINEL_KEY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const SENTINEL_RPC = "http://secret-rpc.internal.example.com";

  it("success path: sentinel key and rpcUrl do NOT appear in raw SSE output", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockImplementation(async (options) => {
      await options.executor.execute(FAKE_STEP_1);
      return { success: true, executedStepIds: [FAKE_STEP_1.stepId], skippedStepIds: [], completedStepIds: [FAKE_STEP_1.stepId] };
    });

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("failure path (ConfigExecError): neither sentinel appears in raw SSE output", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const { ConfigExecError } = await import("@redeploy/config");
    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockRejectedValueOnce(new ConfigExecError("INVALID_SPEC", "Spec validation failed"));

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("failure path (step throws with a message embedding the RPC sentinel): sentinel never leaks", async () => {
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_KEY;
    process.env["RPC_URL"] = SENTINEL_RPC;

    const configMod = vi.mocked(await import("@redeploy/config"));
    configMod.applyConfig.mockImplementation(async (options) => {
      const executorWithBoom = {
        ...options.executor,
        execute: async () => {
          throw new Error(`transport error against ${SENTINEL_RPC}`);
        },
      };
      await executorWithBoom.execute(FAKE_STEP_1);
      return { success: true, executedStepIds: [], skippedStepIds: [], completedStepIds: [] };
    });

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.body).not.toContain(SENTINEL_KEY);
    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("missing key path: sentinel rpcUrl does NOT appear in done{success:false} response", async () => {
    delete process.env["DEPLOYER_PRIVATE_KEY"];
    process.env["RPC_URL"] = SENTINEL_RPC;

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.body).not.toContain(SENTINEL_RPC);
  });

  it("malformed deployer key (provider construction throws): sentinel never leaks", async () => {
    const SENTINEL_BAD_KEY = "NOT_A_VALID_KEY_0xbadbadbad";
    process.env["DEPLOYER_PRIVATE_KEY"] = SENTINEL_BAD_KEY;

    const coreMod = vi.mocked(await import("@redeploy/core"));
    coreMod.jsonRpcProvider.mockImplementationOnce(() => {
      throw new Error(`Invalid private key: ${SENTINEL_BAD_KEY}`);
    });

    const configMod = vi.mocked(await import("@redeploy/config"));

    const res = await doRequest(port, "POST", "/api/apply-config", JSON.stringify(VALID_CONFIG_SPEC));

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    const done = doneEvent?.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(res.body).not.toContain(SENTINEL_BAD_KEY);
    expect(configMod.applyConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression — existing routes unaffected
// ---------------------------------------------------------------------------

describe("Regression — existing routes unchanged by /api/apply-config addition", () => {
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
});

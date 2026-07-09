import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IncomingMessage, ServerResponse, Server, request as httpRequest } from "node:http";
import { handleRequest, createServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Helpers — synchronous mock (for GET /health and 404 tests)
// ---------------------------------------------------------------------------

function makeMockReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  res: ServerResponse;
}

function makeMockRes(): MockRes {
  const mock: MockRes = {
    statusCode: 0,
    headers: {},
    body: "",
    res: null as unknown as ServerResponse,
  };

  const res = {
    writeHead(code: number, headers: Record<string, string | number>) {
      mock.statusCode = code;
      mock.headers = { ...headers };
    },
    end(data: string) {
      mock.body = data;
    },
  } as unknown as ServerResponse;

  mock.res = res;
  return mock;
}

// ---------------------------------------------------------------------------
// Helpers — real server on an ephemeral port (for POST /api/simulate tests)
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

/**
 * Parse an SSE stream body into an array of `{ event, data }` objects.
 * Each SSE message is separated by `\n\n`.
 */
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
// Real server setup (shared for POST /api/simulate tests)
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
// Synchronous route tests (GET /health, unknown routes)
// ---------------------------------------------------------------------------

describe("@redeploy/deploy-server — handleRequest", () => {
  describe("GET /health", () => {
    it("responds 200 with { status: 'ok' }", () => {
      const req = makeMockReq("GET", "/health");
      const mock = makeMockRes();

      handleRequest(req, mock.res);

      expect(mock.statusCode).toBe(200);
      expect(mock.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(mock.body)).toEqual({ status: "ok" });
    });
  });

  describe("createServer", () => {
    it("returns an http.Server with handleRequest wired as the request listener", () => {
      const s = createServer();
      expect(s).toBeInstanceOf(Server);
      // Verify the handler is actually registered so a regression to a
      // handler-less server is caught immediately.
      expect(s.listeners("request")).toContain(handleRequest);
    });
  });

  describe("unknown routes", () => {
    it("responds 404 for an unrecognised path", () => {
      const req = makeMockReq("GET", "/unknown");
      const mock = makeMockRes();

      handleRequest(req, mock.res);

      expect(mock.statusCode).toBe(404);
      expect(JSON.parse(mock.body)).toEqual({ error: "Not Found" });
    });

    it("responds 404 for a POST to /health", () => {
      const req = makeMockReq("POST", "/health");
      const mock = makeMockRes();

      handleRequest(req, mock.res);

      expect(mock.statusCode).toBe(404);
      expect(JSON.parse(mock.body)).toEqual({ error: "Not Found" });
    });

    it("responds 404 for root path /", () => {
      const req = makeMockReq("GET", "/");
      const mock = makeMockRes();

      handleRequest(req, mock.res);

      expect(mock.statusCode).toBe(404);
    });

    // Regression test: legal-but-malformed HTTP request-targets (e.g. a raw
    // request line "GET // HTTP/1.1") are passed through by Node as `req.url`
    // values that `new URL(url, "http://localhost")` throws on
    // (`TypeError: Invalid URL`). handleRequest must derive the pathname
    // without a throwing parse so a single malformed request can never crash
    // the whole server (no try/catch or uncaughtException handler wraps it).
    it("does not throw and responds 404 for a malformed request target '//'", () => {
      const req = makeMockReq("GET", "//");
      const mock = makeMockRes();

      expect(() => {
        handleRequest(req, mock.res);
      }).not.toThrow();

      expect(mock.statusCode).toBe(404);
      expect(JSON.parse(mock.body)).toEqual({ error: "Not Found" });
    });

    it("does not throw and responds 404 for a malformed request target '///'", () => {
      const req = makeMockReq("GET", "///");
      const mock = makeMockRes();

      expect(() => {
        handleRequest(req, mock.res);
      }).not.toThrow();

      expect(mock.statusCode).toBe(404);
      expect(JSON.parse(mock.body)).toEqual({ error: "Not Found" });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /health via real server (sanity check)
// ---------------------------------------------------------------------------

describe("GET /health — via real server", () => {
  it("responds 200 { status: ok }", async () => {
    const res = await doRequest(port, "GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Unknown route via real server
// ---------------------------------------------------------------------------

describe("unknown route — via real server", () => {
  it("responds 404 for GET /unknown", async () => {
    const res = await doRequest(port, "GET", "/unknown");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not Found" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/simulate — SSE stream
// ---------------------------------------------------------------------------

/**
 * A valid DeploymentSpec fixture mirroring the core simulate test:
 *   Registry (literal arg) + Token (2 literal args) + Vault (ref→token, after→registry).
 * Expected topological order: registry and token before vault.
 */
const VALID_SPEC = {
  version: 1,
  contracts: [
    {
      id: "registry",
      contract: "Registry",
      args: [{ kind: "literal", value: "0x0000000000000000000000000000000000000001" }],
    },
    {
      id: "token",
      contract: "Token",
      args: [
        { kind: "literal", value: "My Token" },
        { kind: "literal", value: "MTK" },
      ],
    },
    {
      id: "vault",
      contract: "Vault",
      args: [{ kind: "ref", contract: "token" }],
      after: ["registry"],
    },
  ],
};

describe("POST /api/simulate", () => {
  it("valid spec → SSE Content-Type, step events in order, terminal done {success:true}", async () => {
    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(VALID_SPEC));

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);

    // The last event is the terminal done
    const doneEvent = events[events.length - 1];
    expect(doneEvent?.event).toBe("done");
    expect(doneEvent?.data).toEqual({ success: true });

    // All events except the last are step events
    const stepEvents = events.slice(0, -1);
    expect(stepEvents.length).toBe(3);
    expect(stepEvents.every((e) => e.event === "step")).toBe(true);

    // Every step event data has address: null
    for (const e of stepEvents) {
      const d = e.data as Record<string, unknown>;
      expect(d["address"]).toBeNull();
    }

    // Steps include all three ids
    const stepIds = stepEvents.map((e) => (e.data as Record<string, unknown>)["id"]);
    expect(stepIds).toContain("registry");
    expect(stepIds).toContain("token");
    expect(stepIds).toContain("vault");

    // Topological order: vault must come after both registry and token
    const registryIdx = stepIds.indexOf("registry");
    const tokenIdx = stepIds.indexOf("token");
    const vaultIdx = stepIds.indexOf("vault");
    expect(registryIdx).toBeLessThan(vaultIdx);
    expect(tokenIdx).toBeLessThan(vaultIdx);
  });

  it("each step event data is augmented with address: null", async () => {
    const simpleSpec = {
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

    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(simpleSpec));
    const events = parseSse(res.body);
    const stepEvents = events.filter((e) => e.event === "step");

    for (const e of stepEvents) {
      const d = e.data as Record<string, unknown>;
      expect("address" in d).toBe(true);
      expect(d["address"]).toBeNull();
      expect(d["id"]).toBeDefined();
      expect(d["contract"]).toBeDefined();
      expect(Array.isArray(d["dependsOn"])).toBe(true);
    }
  });

  it("invalid spec (duplicate ids) → terminal done {success:false, errors:[...]} and NO step events", async () => {
    const invalidSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "token", contract: "Token" },
      ],
    };

    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(invalidSpec));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.body);

    // No step events
    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents).toHaveLength(0);

    // One done event
    const doneEvents = events.filter((e) => e.event === "done");
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0]!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);
    expect((done["errors"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("invalid spec (missing ref target) → done {success:false, errors:[...]}", async () => {
    const invalidSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "ref", contract: "nonexistent" }],
        },
      ],
    };

    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(invalidSpec));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const done = doneEvent!.data as Record<string, unknown>;
    expect(done["success"]).toBe(false);
    expect(Array.isArray(done["errors"])).toBe(true);

    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents).toHaveLength(0);
  });

  it("malformed JSON body → 400 Bad Request with JSON error body", async () => {
    const res = await doRequest(port, "POST", "/api/simulate", "{ not valid json }");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });

  it("oversized body (> 1 MiB) → 413 Payload Too Large with JSON error body", async () => {
    // Generate a body slightly over 1 MiB (1024 * 1024 + 1 bytes)
    const oversize = "x".repeat(1024 * 1024 + 1);
    const res = await doRequest(port, "POST", "/api/simulate", oversize);
    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });

  it("empty contracts array → done {success:true} with no step events", async () => {
    const emptySpec = { version: 1, contracts: [] };
    const res = await doRequest(port, "POST", "/api/simulate", JSON.stringify(emptySpec));
    expect(res.statusCode).toBe(200);

    const events = parseSse(res.body);
    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents).toHaveLength(0);

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent!.data as Record<string, unknown>)["success"]).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { IncomingMessage, ServerResponse, Server } from "node:http";
import { handleRequest, createServer } from "../src/server.js";

/**
 * Minimal mock for IncomingMessage / ServerResponse so we can exercise
 * handleRequest without binding a port.
 */
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
    it("returns an http.Server instance", () => {
      const server = createServer();
      expect(server).toBeInstanceOf(Server);
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
    });

    it("responds 404 for root path /", () => {
      const req = makeMockReq("GET", "/");
      const mock = makeMockRes();

      handleRequest(req, mock.res);

      expect(mock.statusCode).toBe(404);
    });
  });
});

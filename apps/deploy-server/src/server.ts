import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Dispatch an incoming request to the appropriate route handler.
 *
 * Current routes:
 *   GET /health  → 200 { status: "ok" }
 *
 * Placeholder: POST /api/simulate (SSE) lands in a follow-up sub-task.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const { method, url } = req;

  if (method === "GET" && url === "/health") {
    const body = JSON.stringify({ status: "ok" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // Catch-all: 404 for any unrecognised path/method.
  const body = JSON.stringify({ error: "Not Found" });
  res.writeHead(404, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Create (but do NOT bind) the HTTP server.  Keeping construction separate
 * from binding makes the handler unit-testable without opening a port.
 */
export function createServer(): Server {
  return createHttpServer(handleRequest);
}

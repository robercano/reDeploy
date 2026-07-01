import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { simulate } from "@redeploy/core";
import type { PlannedStep, SimulateError } from "@redeploy/core";

/** Maximum body size for POST /api/simulate requests (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Write a single SSE event to the response stream.
 * Format: `event: <name>\ndata: <json>\n\n`
 */
function writeSseEvent(res: ServerResponse, eventName: string, data: unknown): void {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Read the full request body with a size cap.
 *
 * Resolves with the raw string on success.
 * Rejects with `{ code: "TOO_LARGE" }` when the body exceeds MAX_BODY_BYTES.
 * Rejects with `{ code: "READ_ERROR", message: string }` on a stream error.
 *
 * When the body is too large, the incoming request stream is drained (resumed
 * until end) so the connection stays open and the server can write the 413
 * response to the client before closing.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let finished = false;

    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        finished = true;
        // Drain remaining data so the socket stays open long enough for the
        // 413 response to be flushed to the client.
        req.resume();
        reject({ code: "TOO_LARGE" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err: Error) => {
      if (finished) return;
      finished = true;
      reject({ code: "READ_ERROR", message: err.message });
    });
  });
}

/**
 * Handle `POST /api/simulate`.
 *
 * Reads the JSON body (capped at MAX_BODY_BYTES), calls simulate(), and
 * streams the result as SSE:
 *
 *   - ok:true  → one `step` event per PlannedStep (augmented with address:null),
 *                then a terminal `done` event with `{success:true}`.
 *   - ok:false → no `step` events; terminal `done` with
 *                `{success:false, errors:SimulateError[]}`.
 *
 * Error responses (non-SSE):
 *   - 413  body exceeds MAX_BODY_BYTES
 *   - 400  malformed JSON
 */
async function handleSimulate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // --- Read body -----------------------------------------------------------
  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    const e = err as { code: string; message?: string };
    if (e.code === "TOO_LARGE") {
      const body = JSON.stringify({ error: "Payload Too Large" });
      res.writeHead(413, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const body = JSON.stringify({ error: "Failed to read request body" });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // --- Parse JSON ----------------------------------------------------------
  let spec: unknown;
  try {
    spec = JSON.parse(rawBody);
  } catch {
    const body = JSON.stringify({ error: "Bad Request: invalid JSON" });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // --- Simulate ------------------------------------------------------------
  const result = simulate(spec);

  // --- Stream SSE response -------------------------------------------------
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (result.ok) {
    for (const step of result.steps) {
      const stepData: PlannedStep & { address: null } = { ...step, address: null };
      writeSseEvent(res, "step", stepData);
    }
    writeSseEvent(res, "done", { success: true });
  } else {
    const errors: SimulateError[] = [...result.errors];
    writeSseEvent(res, "done", { success: false, errors });
  }

  res.end();
}

/**
 * Dispatch an incoming request to the appropriate route handler.
 *
 * Routes:
 *   GET  /health        → 200 { status: "ok" }
 *   POST /api/simulate  → 200 SSE stream (planned steps or errors)
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

  if (method === "POST" && url === "/api/simulate") {
    // handleSimulate is async; fire-and-forget — errors are handled internally.
    handleSimulate(req, res).catch((err: unknown) => {
      // Unexpected error: attempt a 500 response if headers not yet sent.
      if (!res.headersSent) {
        const body = JSON.stringify({ error: "Internal Server Error" });
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.end();
      }
      // Re-surface the error for test/debug visibility.
      process.stderr.write(`[deploy-server] unhandled simulate error: ${String(err)}\n`);
    });
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

import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@redeploy/core";
import { simulate } from "@redeploy/core";
import type { PlannedStep, SimulateError, DeploymentSpec } from "@redeploy/core";
import { DeployError } from "@redeploy/core";
import { readDeployment, ReadError } from "@redeploy/reader";
import type { DeploymentView } from "@redeploy/reader";

/** Maximum body size for POST requests (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The directory of this compiled module (apps/deploy-server/dist/).
 * Used to compute the default FOUNDRY_OUT path from a relative offset.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default Foundry artifacts directory.
 *
 * When FOUNDRY_OUT is not set, we resolve relative to the compiled dist/ dir:
 *   apps/deploy-server/dist/ -> ../../.. -> repo root -> contracts/out
 *
 * So: path.resolve(__dirname, "../../../contracts/out")
 * which, when dist/ is apps/deploy-server/dist/, becomes:
 *   <repo-root>/contracts/out
 */
const DEFAULT_FOUNDRY_OUT = path.resolve(__dirname, "../../../contracts/out");

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
 * Shared body+JSON reader helper used by both /api/simulate and /api/deploy.
 *
 * Returns `{ ok: true, parsed }` on success.
 * Writes a 413 or 400 response and returns `{ ok: false }` on error.
 */
async function readAndParseBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; parsed: unknown } | { ok: false }> {
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
      return { ok: false };
    }
    const body = JSON.stringify({ error: "Failed to read request body" });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return { ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    const body = JSON.stringify({ error: "Bad Request: invalid JSON" });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return { ok: false };
  }

  return { ok: true, parsed };
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
  const result = await readAndParseBody(req, res);
  if (!result.ok) return;
  const spec = result.parsed;

  // --- Simulate ------------------------------------------------------------
  const simResult = simulate(spec);

  // --- Stream SSE response -------------------------------------------------
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (simResult.ok) {
    for (const step of simResult.steps) {
      const stepData: PlannedStep & { address: null } = { ...step, address: null };
      writeSseEvent(res, "step", stepData);
    }
    writeSseEvent(res, "done", { success: true });
  } else {
    const errors: SimulateError[] = [...simResult.errors];
    writeSseEvent(res, "done", { success: false, errors });
  }

  res.end();
}

/**
 * Handle `POST /api/deploy`.
 *
 * Reads the JSON body (capped at MAX_BODY_BYTES), then performs a REAL deploy
 * via @redeploy/core. Streams progress and result as SSE.
 *
 * SSE event sequence:
 *   1. `progress` { phase: "deploying" } — emitted immediately after stream opens.
 *   2. `done` { success: true, deployment: DeploymentView } — on success.
 *      OR
 *      `done` { success: false, errors: [{code?, message},...] } — on failure.
 *
 * Environment variables consumed (values are NEVER echoed in any response):
 *   - RPC_URL:              JSON-RPC endpoint (default: http://127.0.0.1:8545)
 *   - DEPLOYER_PRIVATE_KEY: 0x-prefixed private key (required; missing → SSE error)
 *   - FOUNDRY_OUT:          Foundry artifacts dir (default: <repo>/contracts/out)
 *   - DEPLOYMENT_DIR:       Where to persist the Ignition journal (default: OS temp)
 *
 * Accounts derivation: we call provider.request({ method: "eth_accounts" }) on
 * the freshly-built jsonRpcProvider. This is answered locally (no RPC round-trip)
 * by the provider's internal viem account, returning [account.address]. This
 * avoids importing viem directly into deploy-server.
 *
 * ReadError handling: on success:true, we call readDeployment() synchronously.
 * If it throws ReadError we still emit done{success:true, deployment:null,
 * warning:"could not read journal"} — a successful deploy must not become a 500.
 *
 * Error responses (non-SSE):
 *   - 413  body exceeds MAX_BODY_BYTES
 *   - 400  malformed JSON
 */
async function handleDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // --- Read / parse body (identical to /api/simulate) ----------------------
  const bodyResult = await readAndParseBody(req, res);
  if (!bodyResult.ok) return;
  const body = bodyResult.parsed;

  // --- Open SSE stream first so all outcomes flow through it ---------------
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // --- Validate private key presence BEFORE building the provider ----------
  // SECURITY: never include the key value in any message or log.
  const privateKey = process.env["DEPLOYER_PRIVATE_KEY"];
  if (!privateKey || privateKey.trim() === "") {
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "DEPLOYER_PRIVATE_KEY is not configured" }],
    });
    res.end();
    return;
  }

  // --- Build environment-driven inputs ------------------------------------
  // SECURITY: rpcUrl and privateKey are NEVER interpolated into any log or
  // response message — only passed to jsonRpcProvider() which is responsible
  // for not leaking them.
  const rpcUrl = process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
  const outDir = process.env["FOUNDRY_OUT"] ?? DEFAULT_FOUNDRY_OUT;

  // Default deploymentDir: an OS-temp-based stable directory.
  // We use "redeploy-default" as a stable-ish sub-path so repeated deploys
  // from the same server instance are resumable (same dir → journal replay).
  const deploymentDir =
    process.env["DEPLOYMENT_DIR"] ?? path.join(os.tmpdir(), "redeploy-deployments", "default");

  // Ensure deploymentDir exists before calling deploy() (Ignition expects it).
  try {
    fs.mkdirSync(deploymentDir, { recursive: true });
  } catch (mkdirErr) {
    // If we can't create the dir, emit a safe terminal error.
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "Failed to create deployment directory" }],
    });
    res.end();
    process.stderr.write(
      `[deploy-server] failed to mkdirSync deploymentDir: ${String(mkdirErr)}\n`,
    );
    return;
  }

  const provider = core.jsonRpcProvider({ rpcUrl, privateKey });
  const artifactResolver = core.foundryArtifactResolver(outDir);

  // Derive accounts from the provider (answered locally by viem, no RPC call).
  // The provider's eth_accounts handler returns [account.address] synchronously
  // without any network round-trip, so this is safe to await here.
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];

  // --- Emit progress frame so clients know we started ---------------------
  writeSseEvent(res, "progress", { phase: "deploying" });

  // --- Run deploy ---------------------------------------------------------
  let deployResult: core.DeployResult;
  try {
    deployResult = await core.deploy({
      spec: body as DeploymentSpec,
      provider,
      accounts,
      deploymentDir,
      artifactResolver,
    });
  } catch (caughtErr) {
    // deploy() throws DeployError for INVALID_SPEC and COMPILE_ERROR.
    // All other thrown values are unexpected errors.
    if (caughtErr instanceof DeployError) {
      const deployErr = caughtErr;
      const errors: Array<{ code?: string; message: string }> =
        deployErr.code === "INVALID_SPEC" &&
        deployErr.specErrors != null &&
        deployErr.specErrors.length > 0
          ? deployErr.specErrors.map((se) => ({ code: deployErr.code, message: se.message }))
          : [{ code: deployErr.code, message: deployErr.message }];
      writeSseEvent(res, "done", { success: false, errors });
      res.end();
      return;
    }
    // Unexpected error — emit generic terminal and log to stderr (no secret values).
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "An unexpected error occurred during deployment" }],
    });
    res.end();
    // Log the error's own message only (not privateKey or rpcUrl).
    const errMsg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
    process.stderr.write(`[deploy-server] unexpected deploy error: ${errMsg}\n`);
    return;
  }

  // --- Handle deploy result -----------------------------------------------
  if (!deployResult.success) {
    // On-chain failure (e.g. reverted transaction) — Ignition returns success:false.
    // We emit a safe generic message; details are in ignitionResult but may
    // contain chain-specific data we don't want to blindly forward.
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "Deployment failed on-chain" }],
    });
    res.end();
    return;
  }

  // --- Read deployment view -----------------------------------------------
  // readDeployment() is synchronous. On ReadError we still emit done{success:true}
  // with deployment:null and a warning — a successful deploy must not become a 500.
  let deployment: DeploymentView | null = null;
  let warning: string | undefined;
  try {
    deployment = readDeployment({ deploymentDir });
  } catch (readErr) {
    if (readErr instanceof ReadError) {
      warning = "could not read journal";
    } else {
      warning = "could not read journal";
      const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
      process.stderr.write(`[deploy-server] unexpected readDeployment error: ${errMsg}\n`);
    }
  }

  if (warning !== undefined) {
    writeSseEvent(res, "done", { success: true, deployment: null, warning });
  } else {
    writeSseEvent(res, "done", { success: true, deployment });
  }
  res.end();
}

/**
 * Dispatch an incoming request to the appropriate route handler.
 *
 * Routes:
 *   GET  /health        → 200 { status: "ok" }
 *   POST /api/simulate  → 200 SSE stream (planned steps or errors)
 *   POST /api/deploy    → 200 SSE stream (deploy progress + result)
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

  if (method === "POST" && url === "/api/deploy") {
    // handleDeploy is async; fire-and-forget — errors are handled internally.
    handleDeploy(req, res).catch((err: unknown) => {
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
      // Log only the error's own message — never privateKey or rpcUrl.
      process.stderr.write(`[deploy-server] unhandled deploy error: ${String(err)}\n`);
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

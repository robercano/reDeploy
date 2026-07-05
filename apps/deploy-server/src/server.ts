import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@redeploy/core";
import { simulate } from "@redeploy/core";
import type { PlannedStep, SimulateError, DeploymentSpec } from "@redeploy/core";
import { DeployError } from "@redeploy/core";
import { readDeployment, ReadError, buildSnapshot, snapshotRelativePath } from "@redeploy/reader";
import type { DeploymentView } from "@redeploy/reader";
import { normalizePrivateKey } from "./env.js";

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

/**
 * Path to this package's own `package.json`, resolved relative to the
 * compiled dist/ dir: apps/deploy-server/dist/ -> ../package.json ->
 * apps/deploy-server/package.json.
 */
const PACKAGE_JSON_PATH = path.resolve(__dirname, "../package.json");

/** Fallback tool version used when package.json cannot be read/parsed. */
const FALLBACK_TOOL_VERSION = "0.0.0";

/**
 * Read this package's `version` field, for stamping into deployment
 * snapshots as `toolVersion`. Never throws — falls back to
 * `FALLBACK_TOOL_VERSION` on any read/parse error.
 */
function readToolVersion(): string {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : FALLBACK_TOOL_VERSION;
  } catch {
    return FALLBACK_TOOL_VERSION;
  }
}

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
 *   - DEPLOYER_PRIVATE_KEY: private key, with or without a "0x" prefix (required;
 *                           missing → SSE error; normalized via normalizePrivateKey)
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
 * Snapshot persistence: on a successful deploy where readDeployment() also
 * succeeded, we build a DeploymentSnapshot via @redeploy/reader's
 * buildSnapshot() (reusing the already-read DeploymentView) and persist it to
 * `<deploymentDir>/snapshots/<takenAt>.json`. chainId is obtained via a
 * `eth_chainId` RPC call on the already-built provider; toolVersion is this
 * package's own `package.json` version; spec is the parsed request body. This
 * step is best-effort: any failure (RPC error, fs error, etc.) is caught and
 * surfaced as a `warning` on the success `done` payload — it never turns a
 * successful deploy into a failure, and is skipped entirely when
 * readDeployment() itself failed (no DeploymentView to snapshot).
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
  const rawPrivateKey = process.env["DEPLOYER_PRIVATE_KEY"];
  if (!rawPrivateKey || rawPrivateKey.trim() === "") {
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "DEPLOYER_PRIVATE_KEY is not configured" }],
    });
    res.end();
    return;
  }

  // Accept the key with or without a "0x" prefix — viem's
  // privateKeyToAccount (inside jsonRpcProvider) requires the prefix.
  const privateKey = normalizePrivateKey(rawPrivateKey);

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

  // Wrap provider construction and account derivation in a try/catch.
  // A malformed DEPLOYER_PRIVATE_KEY causes privateKeyToAccount (inside
  // jsonRpcProvider) to throw synchronously. We must catch it here — AFTER the
  // SSE stream is already open — and emit a terminal done frame so the client
  // always receives a well-formed response.
  // SECURITY: the caught error message is NOT forwarded (it may contain key
  // material or a formatted hex string); we emit a generic message only.
  let provider: ReturnType<typeof core.jsonRpcProvider>;
  let artifactResolver: ReturnType<typeof core.foundryArtifactResolver>;
  let accounts: string[];
  try {
    provider = core.jsonRpcProvider({ rpcUrl, privateKey });
    artifactResolver = core.foundryArtifactResolver(outDir);

    // Derive accounts from the provider (answered locally by viem, no RPC call).
    // The provider's eth_accounts handler returns [account.address] synchronously
    // without any network round-trip, so this is safe to await here.
    accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  } catch {
    // Do NOT log or forward the caught error — it may embed key material.
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "Invalid deployer configuration" }],
    });
    res.end();
    return;
  }

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
    // Unexpected error (e.g. viem transport/RPC error whose message may embed
    // the RPC URL including any API key in the path). SECURITY: emit only a
    // generic message to the client and a generic line to stderr — never log
    // or forward the error message itself.
    writeSseEvent(res, "done", {
      success: false,
      errors: [{ message: "deployment failed" }],
    });
    res.end();
    process.stderr.write("[deploy-server] unexpected deploy error\n");
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
    res.end();
    return;
  }

  // --- Persist deployment snapshot (best-effort, non-fatal) ---------------
  // Only attempted when readDeployment() succeeded above (deployment is
  // non-null here, since `warning` is undefined). A failure here must not
  // turn a successful deploy into a failure — it degrades to a `warning` on
  // the existing success `done` payload, mirroring the readDeployment
  // failure pattern above.
  // SECURITY: the caught error is never logged/forwarded verbatim — the
  // eth_chainId RPC call may fail with an error embedding rpcUrl.
  let snapshotWarning: string | undefined;
  try {
    const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
    const chainId = Number.parseInt(chainIdHex, 16);
    const toolVersion = readToolVersion();

    const snapshot = buildSnapshot({
      deployment: deployment as DeploymentView,
      chainId,
      toolVersion,
      spec: { spec: body },
    });

    const snapshotPath = path.join(deploymentDir, snapshotRelativePath(snapshot.takenAt));
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  } catch {
    snapshotWarning = "could not persist deployment snapshot";
    process.stderr.write("[deploy-server] unexpected snapshot error\n");
  }

  if (snapshotWarning !== undefined) {
    writeSseEvent(res, "done", { success: true, deployment, warning: snapshotWarning });
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
    handleDeploy(req, res).catch(() => {
      // Unexpected error escaping handleDeploy (should not happen in normal
      // operation — all paths inside handleDeploy have their own catch).
      // SECURITY: do NOT log or forward the error — it may embed RPC_URL or
      // other sensitive values from the environment.
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
      // Generic log line only — never the error value which may embed the URL/key.
      process.stderr.write("[deploy-server] unhandled deploy error\n");
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

import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as viemHttp } from "viem";
import * as core from "@redeploy/core";
import { simulate } from "@redeploy/core";
import type { PlannedStep, SimulateError, DeploymentSpec } from "@redeploy/core";
import { DeployError } from "@redeploy/core";
import { readDeployment, ReadError, buildSnapshot, snapshotRelativePath } from "@redeploy/reader";
import type { DeploymentView } from "@redeploy/reader";
import type { ConfigSpec } from "@redeploy/config";
import { normalizePrivateKey, readEtherscanConfig } from "./env.js";
import { runConfigDrift, validateConfigSpecShape } from "./verify/run-config-drift.js";
import type { ConfigDriftResponse } from "./verify/run-config-drift.js";
import { runSourceVerify } from "./verify/run-source-verify.js";
import type { SourceVerifyResponse } from "./verify/run-source-verify.js";
import { createRpcChainReader } from "./verify/chain-reader.js";

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
 * Resolve the deployment directory STRICTLY from server env — never from any
 * client-supplied input (query param, header, body, etc.). This is shared by
 * `handleDeploy` and `handleGetDeployment` so both stay in sync.
 *
 * SECURITY: keeping this env-only (no request-derived input) avoids
 * path-traversal / arbitrary-file-read via a client-controlled directory.
 */
function resolveDeploymentDir(): string {
  return process.env["DEPLOYMENT_DIR"] ?? path.join(os.tmpdir(), "redeploy-deployments", "default");
}

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
  const deploymentDir = resolveDeploymentDir();

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

/** Empty DeploymentView returned for a fresh / never-deployed deploymentDir. */
const EMPTY_DEPLOYMENT_VIEW: DeploymentView = { contracts: [], configSteps: [], warnings: [] };

/**
 * Handle `GET /api/deployment`.
 *
 * Reads the TRUE current on-chain/journal deployment state via
 * `readDeployment()` and returns it as JSON. This is a read-only endpoint
 * used by the studio to fetch live state on demand (e.g. to diff against a
 * spec before deploying).
 *
 * The deployment directory is resolved STRICTLY from server env via
 * `resolveDeploymentDir()` — no client-supplied input (query param, header,
 * etc.) may influence which directory is read. This is a deliberate security
 * boundary: accepting a client-controlled path would open a path-traversal /
 * arbitrary-file-read hole.
 *
 * Responses:
 *   - 200 { contracts, configSteps, warnings } — DeploymentView, on success.
 *   - 200 { contracts: [], configSteps: [], warnings: [] } — when
 *     readDeployment() throws ReadError("DEPLOYMENT_DIR_NOT_FOUND"): a fresh /
 *     never-deployed directory is not an error, it's the empty state.
 *   - 500 { error: "Failed to read deployment state" } — any other ReadError
 *     (e.g. JOURNAL_READ_ERROR) or unexpected error. SECURITY: the response
 *     body and stderr log never include the deployment directory path, the
 *     raw error message, or any env value.
 */
function handleGetDeployment(_req: IncomingMessage, res: ServerResponse): void {
  const deploymentDir = resolveDeploymentDir();

  let deployment: DeploymentView;
  try {
    deployment = readDeployment({ deploymentDir });
  } catch (err) {
    if (err instanceof ReadError && err.code === "DEPLOYMENT_DIR_NOT_FOUND") {
      deployment = EMPTY_DEPLOYMENT_VIEW;
    } else {
      const body = JSON.stringify({ error: "Failed to read deployment state" });
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      // Generic log line only — never the deployment dir path or raw error.
      process.stderr.write("[deploy-server] failed to read deployment state\n");
      return;
    }
  }

  const body = JSON.stringify(deployment);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Write a plain JSON response with an explicit Content-Length, mirroring the
 * inline pattern used throughout this file (GET /health, /api/deployment).
 */
function writeJsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Shared by both /api/verify/config and /api/verify/source: read the
 * persisted deployment from the server-resolved deploymentDir, treating a
 * fresh/never-deployed directory as the EMPTY_DEPLOYMENT_VIEW (not an error)
 * exactly like handleGetDeployment. On any other ReadError (or unexpected
 * error), writes a 500 response and returns `null` so the caller bails out.
 */
function readPersistedDeploymentOr500(res: ServerResponse, logLabel: string): DeploymentView | null {
  const deploymentDir = resolveDeploymentDir();
  try {
    return readDeployment({ deploymentDir });
  } catch (err) {
    if (err instanceof ReadError && err.code === "DEPLOYMENT_DIR_NOT_FOUND") {
      return EMPTY_DEPLOYMENT_VIEW;
    }
    writeJsonResponse(res, 500, { error: "Failed to read deployment state" });
    // Generic log line only — never the deployment dir path or raw error.
    process.stderr.write(`[deploy-server] failed to read deployment state for ${logLabel}\n`);
    return null;
  }
}

/**
 * Handle `POST /api/verify/config`.
 *
 * Reads the JSON body as a ConfigSpec (structurally validated via
 * validateConfigSpecShape — a 400 for anything not shaped like
 * `{version, steps, orderedSteps?}`), reads the persisted deployment (server
 * env only — see readPersistedDeploymentOr500), builds a read-only
 * (never-signing) chain reader over RPC_URL/FOUNDRY_OUT, and runs
 * runConfigDrift() (see verify/run-config-drift.ts for the full
 * graceful-degradation contract: unresolvable refs and non-derivable getter
 * mappings become per-step "error"/"skipped" results, never a 500).
 *
 * Response: 200 `{ clean: boolean, results: ConfigDriftResultEntry[] }`.
 * Error responses (non-streaming JSON):
 *   - 413  body exceeds MAX_BODY_BYTES
 *   - 400  malformed JSON, or body not shaped like a ConfigSpec
 *   - 500  the persisted deployment could not be read
 */
async function handleVerifyConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyResult = await readAndParseBody(req, res);
  if (!bodyResult.ok) return;
  const body = bodyResult.parsed;

  const shapeError = validateConfigSpecShape(body);
  if (shapeError !== null) {
    writeJsonResponse(res, 400, { error: shapeError });
    return;
  }

  const deployment = readPersistedDeploymentOr500(res, "verify/config");
  if (deployment === null) return;

  const rpcUrl = process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
  const outDir = process.env["FOUNDRY_OUT"] ?? DEFAULT_FOUNDRY_OUT;

  const addressToContractName = new Map<string, string>();
  for (const c of deployment.contracts) {
    if (c.address !== null) {
      addressToContractName.set(c.address.toLowerCase(), c.contractName);
    }
  }
  const reader = createRpcChainReader({
    rpcUrl,
    addressToContractName,
    abiLoader: core.foundryArtifactResolver(outDir),
  });

  let result: ConfigDriftResponse;
  try {
    result = await runConfigDrift({ spec: body as ConfigSpec, deployment, reader });
  } catch {
    // Defense in depth — runConfigDrift() is designed to never throw, but a
    // hard failure here must still degrade to a safe JSON error, never a
    // crash. SECURITY: no error detail is forwarded (RPC_URL may embed a key).
    writeJsonResponse(res, 500, { error: "Config drift check failed unexpectedly" });
    process.stderr.write("[deploy-server] unexpected config drift error\n");
    return;
  }

  writeJsonResponse(res, 200, result);
}

/**
 * Handle `POST /api/verify/source`.
 *
 * Takes no meaningful request body (verification runs against the SERVER's
 * persisted deployment + SERVER's ETHERSCAN_API_KEY only — never a
 * client-supplied path or key); the studio client sends `{}` for consistency
 * with the other POST endpoints. Body is still read/size-capped/JSON-parsed
 * via the shared readAndParseBody helper.
 *
 * Resolves chainId via a KEY-LESS read-only RPC client (source verification
 * must work — or rather, cleanly SKIP — even when DEPLOYER_PRIVATE_KEY is
 * unset) and delegates to runSourceVerify(), which:
 *   - skips cleanly (never errors) when ETHERSCAN_API_KEY is unset OR
 *     chainId is 31337 (local Anvil) OR there are no deployed contracts.
 *   - submits each deployed contract's Foundry-derived compiler input to
 *     Etherscan via @redeploy/verify's verifyDeployment().
 *
 * Response: 200 `{ success, skipped, reason?, results: SourceVerifyResultEntry[] }`.
 * Error responses (non-streaming JSON):
 *   - 413  body exceeds MAX_BODY_BYTES
 *   - 400  malformed JSON
 *   - 500  the persisted deployment could not be read
 *   - 502  the configured RPC endpoint could not be reached (chainId lookup)
 *
 * SECURITY: ETHERSCAN_API_KEY is read via env.ts's readEtherscanConfig() and
 * handed to @redeploy/verify's createEtherscanClient() — it is NEVER
 * included in this handler's response body or in any stderr log line.
 */
async function handleVerifySource(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bodyResult = await readAndParseBody(req, res);
  if (!bodyResult.ok) return;

  const deployment = readPersistedDeploymentOr500(res, "verify/source");
  if (deployment === null) return;

  const rpcUrl = process.env["RPC_URL"] ?? "http://127.0.0.1:8545";
  const outDir = process.env["FOUNDRY_OUT"] ?? DEFAULT_FOUNDRY_OUT;
  const contractsRoot = path.dirname(outDir);
  const etherscan = readEtherscanConfig();

  // Determine chainId via a lightweight, KEY-LESS read-only RPC client —
  // source verification must never require DEPLOYER_PRIVATE_KEY.
  let chainId: number;
  try {
    const publicClient = createPublicClient({ transport: viemHttp(rpcUrl) });
    chainId = await publicClient.getChainId();
  } catch {
    // SECURITY: the caught error may embed rpcUrl — never forwarded.
    writeJsonResponse(res, 502, { error: "Could not reach the configured RPC endpoint" });
    process.stderr.write("[deploy-server] unexpected RPC error resolving chainId for verify/source\n");
    return;
  }

  let result: SourceVerifyResponse;
  try {
    result = await runSourceVerify({
      deployment,
      outDir,
      contractsRoot,
      chainId,
      etherscan,
      fetchFn: fetch,
    });
  } catch {
    writeJsonResponse(res, 500, { error: "Source verification failed unexpectedly" });
    process.stderr.write("[deploy-server] unexpected source verify error\n");
    return;
  }

  writeJsonResponse(res, 200, result);
}

/**
 * Dispatch an incoming request to the appropriate route handler.
 *
 * Routes:
 *   GET  /health              → 200 { status: "ok" }
 *   GET  /api/deployment      → 200 { contracts, configSteps, warnings } (or 500)
 *   POST /api/simulate        → 200 SSE stream (planned steps or errors)
 *   POST /api/deploy          → 200 SSE stream (deploy progress + result)
 *   POST /api/verify/config   → 200 JSON { clean, results } (config-drift check)
 *   POST /api/verify/source   → 200 JSON { success, skipped, reason?, results } (Etherscan source verification)
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const { method, url } = req;

  // Match on the URL pathname only, so a trailing query string (e.g.
  // "/api/deployment?foo=1") still routes correctly. We deliberately avoid
  // `new URL(...)` here: Node passes through legal-but-malformed
  // request-targets (e.g. "//", "///") that make the WHATWG URL parser throw
  // `TypeError: Invalid URL`, which would otherwise crash the whole process
  // (no try/catch, no uncaughtException handler) on a single bad request. A
  // plain split on "?"/"#" can never throw and is sufficient since `url` is
  // always a request-target (path + optional query), never a full origin.
  const pathname = url !== undefined ? url.split(/[?#]/)[0] : undefined;

  if (method === "GET" && url === "/health") {
    const body = JSON.stringify({ status: "ok" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (method === "GET" && pathname === "/api/deployment") {
    handleGetDeployment(req, res);
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

  if (method === "POST" && url === "/api/verify/config") {
    // handleVerifyConfig is async; fire-and-forget — errors are handled internally.
    handleVerifyConfig(req, res).catch(() => {
      if (!res.headersSent) {
        writeJsonResponse(res, 500, { error: "Internal Server Error" });
      } else {
        res.end();
      }
      process.stderr.write("[deploy-server] unhandled verify/config error\n");
    });
    return;
  }

  if (method === "POST" && url === "/api/verify/source") {
    // handleVerifySource is async; fire-and-forget — errors are handled internally.
    handleVerifySource(req, res).catch(() => {
      // SECURITY: do NOT log or forward the error — it may embed RPC_URL or
      // the Etherscan API key from the environment.
      if (!res.headersSent) {
        writeJsonResponse(res, 500, { error: "Internal Server Error" });
      } else {
        res.end();
      }
      process.stderr.write("[deploy-server] unhandled verify/source error\n");
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

/**
 * Etherscan verification client for @redeploy/verify.
 *
 * DESIGN
 * ======
 *
 * This client wraps the Etherscan contract verification API:
 *   POST ?module=contract&action=verifysourcecode
 *   GET  ?module=contract&action=checkverifystatus&guid=<guid>
 *
 * The HTTP layer is fully injectable via a FetchLike function passed to
 * createEtherscanClient(). This makes it trivially testable with a fake fetch
 * and keeps the production code free of hard network dependencies.
 *
 * IMPORTANT ETHERSCAN-SPECIFIC QUIRKS (documented here for clarity):
 *   1. Historical misspelling: the wire field is `constructorArguements`
 *      (missing the 't'). The INPUT type uses `constructorArguments` (correct
 *      spelling) and this client maps it to the misspelled wire name.
 *   2. Success response: `{ status: "1", result: "<guid>" }` — result is the
 *      verification GUID, not a boolean.
 *   3. Already-verified: `{ status: "0", result: "... already verified ..." }`
 *      (case-insensitive, substring match). This is NOT an error.
 *   4. Pending: `checkverifystatus` may return `{ status: "0", result: "Pending in queue" }`.
 *   5. Verified (check): `{ status: "1", result: "Pass - Verified" }`.
 *
 * FIELDS POPULATED BY THIS CLIENT (from the input):
 *   - apikey          — from EtherscanConfig.apiKey
 *   - module          — always "contract"
 *   - action          — "verifysourcecode" or "checkverifystatus"
 *   - contractaddress — from EtherscanSubmitRequest.address
 *   - sourceCode      — from EtherscanSubmitRequest.sourceCode (caller-provided
 *                       standard-json-input or flat Solidity source; this client
 *                       does NOT recompile)
 *   - codeformat      — from EtherscanSubmitRequest.codeFormat (defaults to
 *                       "solidity-standard-json-input")
 *   - contractname    — from EtherscanSubmitRequest.contractName
 *   - compilerversion — from EtherscanSubmitRequest.compilerVersion
 *   - constructorArguements — mapped from EtherscanSubmitRequest.constructorArguments
 *                             (note the historical misspelling on the wire)
 *
 * TODO / CALLER RESPONSIBILITY:
 *   - Assembling the standard-json-input (sourceCode) is the caller's
 *     responsibility. This client accepts it as an opaque string.
 *   - Library linking (libraryname, libraryaddress) is not yet implemented.
 *   - License type (licenseType) is not yet implemented.
 */

import type { VerifierClient, SubmitRequest, SubmitResult, StatusResult } from "../types.js";

// ---------------------------------------------------------------------------
// Injectable HTTP type (no real http library)
// ---------------------------------------------------------------------------

/**
 * A minimal fetch-like interface for the HTTP transport layer.
 * The production caller passes the global `fetch`; tests pass a mock.
 *
 * Only the fields actually used by this client are required.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// ---------------------------------------------------------------------------
// Etherscan client configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Etherscan verification client.
 */
export interface EtherscanConfig {
  /**
   * Etherscan API key. REQUIRED — throws VerifyError("MISSING_API_KEY") if
   * absent or empty. Never logged.
   */
  readonly apiKey: string;
  /**
   * Base URL of the Etherscan-compatible API.
   * @default "https://api.etherscan.io/api"
   */
  readonly apiUrl?: string;
  /**
   * Maximum number of status-check poll attempts before treating the result
   * as still pending.
   * @default 10
   */
  readonly maxPollAttempts?: number;
  /**
   * Milliseconds to wait between status-check poll attempts.
   * Set to 0 in tests (with an injected sleep) to keep test suites instant.
   * @default 5000
   */
  readonly pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Etherscan submit request (input shape — correct spelling)
// ---------------------------------------------------------------------------

/**
 * A contract submission request for the Etherscan verifier.
 *
 * The caller is responsible for providing the sourceCode (standard-json-input
 * string or flat Solidity source). This client does NOT recompile.
 */
export interface EtherscanSubmitRequest extends SubmitRequest {
  /**
   * The Solidity source code. For `codeFormat: "solidity-standard-json-input"`
   * this should be the JSON.stringify'd standard-json-input object.
   * For `codeFormat: "solidity-single-file"` this is the raw Solidity source.
   * This client accepts it as an opaque string and passes it straight through.
   */
  readonly sourceCode: string;
  /**
   * Solidity compiler version string, e.g. "v0.8.28+commit.7893614a".
   * REQUIRED on the wire.
   */
  readonly compilerVersion: string;
  /**
   * ABI-encoded constructor arguments (hex string, without 0x prefix).
   * Note: the INPUT field uses the CORRECT spelling `constructorArguments`;
   * this client maps it to the historical Etherscan wire misspelling
   * `constructorArguements` automatically.
   */
  readonly constructorArguments?: string;
  /**
   * Source code format.
   * @default "solidity-standard-json-input"
   */
  readonly codeFormat?: "solidity-standard-json-input" | "solidity-single-file";
}

// ---------------------------------------------------------------------------
// Internal URL/body building helpers (no URLSearchParams — ES2022 lib only)
// ---------------------------------------------------------------------------

/**
 * Encode a string for use in application/x-www-form-urlencoded bodies.
 * Encodes every character except unreserved ones (RFC 3986), then replaces
 * `%20` with `+` for form compatibility.
 */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/**
 * Build an application/x-www-form-urlencoded body from a key→value record.
 * Keys and values are both form-encoded.
 *
 * SECURITY: this function is used to build the body that includes the API key.
 * The returned string must NOT be logged anywhere.
 */
function buildFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`)
    .join("&");
}

/**
 * Build a URL query string from a key→value record.
 *
 * SECURITY: this function is used to build URLs that include the API key.
 * The returned URL must NOT be logged anywhere.
 */
function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ---------------------------------------------------------------------------
// Etherscan API response shapes (internal — validated defensively)
// ---------------------------------------------------------------------------

/**
 * Raw response envelope from the Etherscan API.
 * Both `status` and `result` are strings on the wire.
 */
interface EtherscanEnvelope {
  status: string;
  result: string;
  message?: string;
}

/**
 * Narrow an unknown API response body to an EtherscanEnvelope.
 * Returns null if the shape does not match.
 */
function parseEtherscanEnvelope(raw: unknown): EtherscanEnvelope | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["status"] !== "string") return null;
  if (typeof obj["result"] !== "string") return null;
  return {
    status: obj["status"],
    result: obj["result"],
    message: typeof obj["message"] === "string" ? obj["message"] : undefined,
  };
}

/**
 * Detect Etherscan's "already verified" result.
 * Etherscan returns status "0" with a result containing "already verified"
 * (case-insensitive substring match).
 */
function isAlreadyVerified(result: string): boolean {
  return result.toLowerCase().includes("already verified");
}

/**
 * Detect Etherscan's "pending in queue" result.
 */
function isPending(result: string): boolean {
  return result.toLowerCase().includes("pending");
}

// ---------------------------------------------------------------------------
// Etherscan verifier client factory
// ---------------------------------------------------------------------------

/**
 * Create an Etherscan-compatible verifier client.
 *
 * @param config - API key and optional URL/poll settings.
 * @param fetchFn - Injectable fetch implementation. Pass `globalThis.fetch` in
 *                  production; pass a mock in tests.
 * @param sleepFn - Injectable sleep implementation. Pass the default sleep
 *                  implementation in production; pass `() => Promise.resolve()`
 *                  in tests for instant poll cycles.
 *
 * @example Production usage:
 * ```ts
 * const client = createEtherscanClient(
 *   { apiKey: process.env.ETHERSCAN_API_KEY! },
 *   globalThis.fetch,
 * );
 * ```
 *
 * @example Test usage with a fake fetch:
 * ```ts
 * const client = createEtherscanClient(
 *   { apiKey: "test-api-key", pollIntervalMs: 0 },
 *   fakeFetch,
 *   () => Promise.resolve(), // instant sleep
 * );
 * ```
 */
export function createEtherscanClient(
  config: EtherscanConfig,
  fetchFn: FetchLike,
  sleepFn?: (ms: number) => Promise<void>,
): VerifierClient<EtherscanSubmitRequest> {
  const apiUrl = config.apiUrl ?? "https://api.etherscan.io/api";
  const maxPollAttempts = config.maxPollAttempts ?? 10;
  const pollIntervalMs = config.pollIntervalMs ?? 5000;

  // Default sleep using a promise-based timeout; injectable for tests.
  // We use a local definition rather than globalThis.setTimeout to avoid
  // needing the DOM/Node lib — the injected sleepFn handles this in tests.
  const sleep =
    sleepFn ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // In production Node.js environments, setTimeout is available globally.
        // We cast through unknown to avoid the lib dependency on @types/node.
        const setTimeoutFn = (
          globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }
        ).setTimeout;
        setTimeoutFn(resolve, ms);
      }));

  /**
   * Build and return an application/x-www-form-urlencoded body for a
   * verifysourcecode request.
   *
   * SECURITY: the apiKey is included in the request body but MUST NOT be
   * logged anywhere in this module. The body string is opaque to callers.
   */
  function buildSubmitBody(request: EtherscanSubmitRequest): string {
    return buildFormBody({
      apikey: config.apiKey,
      module: "contract",
      action: "verifysourcecode",
      contractaddress: request.address,
      sourceCode: request.sourceCode,
      codeformat: request.codeFormat ?? "solidity-standard-json-input",
      contractname: request.contractName,
      compilerversion: request.compilerVersion,
      // Note: historical Etherscan API misspelling — "constructorArguements"
      constructorArguements: request.constructorArguments ?? "",
    });
  }

  /**
   * Build a URL for the checkverifystatus action.
   *
   * SECURITY: apiKey is in the query string but must not be logged.
   */
  function buildStatusUrl(guid: string): string {
    return `${apiUrl}?${buildQueryString({
      apikey: config.apiKey,
      module: "contract",
      action: "checkverifystatus",
      guid,
    })}`;
  }

  /**
   * Safely parse the HTTP response body as JSON, falling back to text on
   * parse error. Never throws.
   */
  async function safeParseResponse(response: {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }): Promise<{ body: unknown; rawText: string }> {
    let rawText = "";
    let body: unknown = null;
    try {
      rawText = await response.text();
      body = JSON.parse(rawText);
    } catch {
      // rawText is already set; body stays as the raw text string for error reporting
      body = rawText;
    }
    return { body, rawText };
  }

  const client: VerifierClient<EtherscanSubmitRequest> = {
    async submit(request: EtherscanSubmitRequest): Promise<SubmitResult> {
      let responseRef: {
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
        text(): Promise<string>;
      };

      try {
        responseRef = await fetchFn(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: buildSubmitBody(request),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          message: `Network error submitting ${request.address} to Etherscan: ${msg}`,
        };
      }

      const { body } = await safeParseResponse(responseRef);

      // Handle HTTP-level non-2xx (e.g. 429 rate limit, 503 maintenance)
      if (!responseRef.ok) {
        const envelope = parseEtherscanEnvelope(body);
        const detail = envelope?.result ?? String(body).slice(0, 200);
        return {
          status: "failed",
          message: `Etherscan HTTP ${responseRef.status} for ${request.address}: ${detail}`,
        };
      }

      const envelope = parseEtherscanEnvelope(body);
      if (envelope === null) {
        return {
          status: "failed",
          message: `Etherscan returned unexpected response shape for ${request.address}: ${String(body).slice(0, 200)}`,
        };
      }

      // Already-verified is success, not failure
      if (isAlreadyVerified(envelope.result)) {
        return { status: "already-verified" };
      }

      // Etherscan returns status "0" for errors
      if (envelope.status === "0") {
        return {
          status: "failed",
          message: `Etherscan rejected ${request.address}: ${envelope.result}`,
        };
      }

      // status "1" + a GUID string means the submission was accepted
      if (envelope.status === "1" && envelope.result.length > 0) {
        return { status: "pending", guid: envelope.result };
      }

      return {
        status: "failed",
        message: `Etherscan returned unexpected status "${envelope.status}" for ${request.address}: ${envelope.result}`,
      };
    },

    async checkStatus(guid: string): Promise<StatusResult> {
      let responseRef: {
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
        text(): Promise<string>;
      };

      try {
        responseRef = await fetchFn(buildStatusUrl(guid));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          message: `Network error checking status for guid ${guid}: ${msg}`,
        };
      }

      const { body } = await safeParseResponse(responseRef);

      if (!responseRef.ok) {
        const envelope = parseEtherscanEnvelope(body);
        const detail = envelope?.result ?? String(body).slice(0, 200);
        return {
          status: "failed",
          message: `Etherscan HTTP ${responseRef.status} checking status for guid ${guid}: ${detail}`,
        };
      }

      const envelope = parseEtherscanEnvelope(body);
      if (envelope === null) {
        return {
          status: "failed",
          message: `Etherscan returned unexpected response shape for guid ${guid}: ${String(body).slice(0, 200)}`,
        };
      }

      if (isAlreadyVerified(envelope.result)) {
        return { status: "already-verified" };
      }

      if (isPending(envelope.result)) {
        return { status: "pending" };
      }

      if (envelope.status === "0") {
        return {
          status: "failed",
          message: `Etherscan verification failed for guid ${guid}: ${envelope.result}`,
        };
      }

      // status "1" means verified
      if (envelope.status === "1") {
        return { status: "verified" };
      }

      return {
        status: "failed",
        message: `Etherscan returned unexpected status "${envelope.status}" for guid ${guid}: ${envelope.result}`,
      };
    },

    async isVerified(address: string): Promise<boolean> {
      const url = `${apiUrl}?${buildQueryString({
        apikey: config.apiKey,
        module: "contract",
        action: "getsourcecode",
        address,
      })}`;

      let responseRef: {
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
        text(): Promise<string>;
      };
      try {
        responseRef = await fetchFn(url);
      } catch {
        return false;
      }

      if (!responseRef.ok) return false;

      const { body } = await safeParseResponse(responseRef);
      const envelope = parseEtherscanEnvelope(body);
      if (envelope === null) return false;

      // If the ABI is not empty, the contract is verified
      return (
        envelope.status === "1" &&
        envelope.result !== "Contract source code not verified"
      );
    },

    /**
     * Poll checkStatus for a submitted GUID until it reaches a terminal state
     * (verified, already-verified, or failed) or maxPollAttempts is exhausted.
     *
     * Returns the final StatusResult. If maxPollAttempts is exhausted while
     * still pending, returns a "pending" status with a message.
     */
    async pollUntilDone(guid: string): Promise<StatusResult> {
      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        if (attempt > 0) {
          await sleep(pollIntervalMs);
        }
        const result = await client.checkStatus(guid);
        if (result.status !== "pending") {
          return result;
        }
      }
      return {
        status: "pending",
        message: `Exceeded ${maxPollAttempts} poll attempts for guid ${guid}`,
      };
    },
  };

  return client;
}

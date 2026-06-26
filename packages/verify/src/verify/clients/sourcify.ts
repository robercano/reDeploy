/**
 * Sourcify verification client for @redeploy/verify.
 *
 * DESIGN
 * ======
 *
 * This client wraps the Sourcify contract verification API:
 *   POST /verify
 *
 * The HTTP layer is fully injectable via a FetchLike function passed to
 * createSourcifyClient(). This makes it trivially testable with a fake fetch
 * and keeps the production code free of hard network dependencies.
 *
 * SOURCIFY API NOTES:
 *   1. Request body: JSON with `address`, `chain` (or `chainId`), and `files`
 *      (a map of filename → file content string).
 *   2. Success response: HTTP 200 with `{ result: [{ address, status }] }`.
 *      `status` is "perfect" (exact match) or "partial" (metadata mismatch).
 *   3. Already-verified: HTTP 200 with `status` "perfect" or "partial" (same as
 *      normal success), OR HTTP 409 (Conflict) which means already verified.
 *   4. Error: HTTP 4xx/5xx with `{ error: "<message>" }` or similar.
 *
 * FIELDS POPULATED BY THIS CLIENT (from the input):
 *   - address   — from SourcifySubmitRequest.address
 *   - chain     — from SourcifySubmitRequest.chainId (as a string)
 *   - files     — from SourcifySubmitRequest.files (metadata.json + sources map)
 *
 * TODO / CALLER RESPONSIBILITY:
 *   - Assembling the `files` map (metadata.json content, source files) is the
 *     caller's responsibility. This client accepts it as an opaque
 *     Record<string, string> and passes it straight through.
 *   - Session-based verification (for large batches) is not yet implemented.
 */

import type { FetchLike } from "./etherscan.js";
import type { VerifierClient, SubmitResult, StatusResult } from "../types.js";

// ---------------------------------------------------------------------------
// Sourcify client configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Sourcify verification client.
 */
export interface SourcifyConfig {
  /**
   * Base URL of the Sourcify API.
   * @default "https://sourcify.dev/server"
   */
  readonly apiUrl?: string;
}

// ---------------------------------------------------------------------------
// Sourcify submit request
// ---------------------------------------------------------------------------

/**
 * A contract submission request for the Sourcify verifier.
 *
 * The caller is responsible for providing the `files` map (metadata.json +
 * Solidity sources). This client does NOT recompile.
 */
export interface SourcifySubmitRequest {
  /** Deployed contract address (checksummed or lowercase hex). */
  readonly address: string;
  /** Contract name (used in result tracking; not sent to Sourcify directly). */
  readonly contractName: string;
  /**
   * Chain ID as a number (e.g. 1 for Ethereum mainnet, 11155111 for Sepolia).
   * Sent as the `chain` field in the Sourcify request body.
   */
  readonly chainId: number;
  /**
   * File map: filename → file content string.
   *
   * Must include at minimum:
   *   - "metadata.json" (the Solidity compiler metadata.json)
   *   - Source files referenced in metadata.json (relative paths as keys)
   *
   * @example
   * ```ts
   * {
   *   "metadata.json": JSON.stringify(metadata),
   *   "contracts/Token.sol": soliditySource,
   * }
   * ```
   */
  readonly files: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Sourcify API response shapes (internal — validated defensively)
// ---------------------------------------------------------------------------

/**
 * Narrow an unknown API response body to a Sourcify result envelope.
 * Returns the status string from the first result entry, or null.
 */
function parseSourcifySuccess(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;
  const result = obj["result"];
  if (!Array.isArray(result) || result.length === 0) return null;
  const first = result[0];
  if (typeof first !== "object" || first === null) return null;
  const firstObj = first as Record<string, unknown>;
  if (typeof firstObj["status"] !== "string") return null;
  return firstObj["status"];
}

/**
 * Narrow an unknown API error body to an error message string.
 * Returns a fallback message if the shape does not match.
 */
function parseSourcifyError(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fallback;
  const obj = body as Record<string, unknown>;
  if (typeof obj["error"] === "string" && obj["error"].length > 0) return obj["error"];
  if (typeof obj["message"] === "string" && obj["message"].length > 0) return obj["message"];
  return fallback;
}

// ---------------------------------------------------------------------------
// Sourcify verifier client factory
// ---------------------------------------------------------------------------

/**
 * Create a Sourcify verifier client.
 *
 * @param config - Optional API URL override.
 * @param fetchFn - Injectable fetch implementation. Pass `globalThis.fetch` in
 *                  production; pass a mock in tests.
 *
 * @example Production usage:
 * ```ts
 * const client = createSourcifyClient({}, globalThis.fetch);
 * ```
 *
 * @example Test usage with a fake fetch:
 * ```ts
 * const client = createSourcifyClient({}, fakeFetch);
 * ```
 */
export function createSourcifyClient(
  config: SourcifyConfig,
  fetchFn: FetchLike,
): VerifierClient<SourcifySubmitRequest> {
  const apiUrl = config.apiUrl ?? "https://sourcify.dev/server";

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
      body = rawText;
    }
    return { body, rawText };
  }

  return {
    async submit(request: SourcifySubmitRequest): Promise<SubmitResult> {
      const payload = {
        address: request.address,
        chain: String(request.chainId),
        files: request.files,
      };

      let responseRef: {
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
        text(): Promise<string>;
      };

      try {
        responseRef = await fetchFn(`${apiUrl}/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          message: `Network error submitting ${request.address} to Sourcify: ${msg}`,
        };
      }

      const { body } = await safeParseResponse(responseRef);

      // HTTP 409 Conflict means the contract is already verified on Sourcify
      if (responseRef.status === 409) {
        return { status: "already-verified" };
      }

      // Handle other HTTP non-2xx
      if (!responseRef.ok) {
        const detail = parseSourcifyError(body, String(body).slice(0, 200));
        return {
          status: "failed",
          message: `Sourcify HTTP ${responseRef.status} for ${request.address}: ${detail}`,
        };
      }

      // Parse the successful response
      const verificationStatus = parseSourcifySuccess(body);
      if (verificationStatus === null) {
        return {
          status: "failed",
          message: `Sourcify returned unexpected response shape for ${request.address}: ${String(body).slice(0, 200)}`,
        };
      }

      // "perfect" or "partial" both count as verified
      if (verificationStatus === "perfect" || verificationStatus === "partial") {
        return { status: "verified" };
      }

      // "already_verified" can also appear in some Sourcify versions
      if (verificationStatus === "already_verified" || verificationStatus.toLowerCase().includes("already")) {
        return { status: "already-verified" };
      }

      return {
        status: "failed",
        message: `Sourcify returned unexpected status "${verificationStatus}" for ${request.address}`,
      };
    },

    async checkStatus(guid: string): Promise<StatusResult> {
      void guid; // Sourcify has no GUID-based async polling; parameter ignored.
      // Sourcify does not use GUID-based async status polling — verification
      // is synchronous via the /verify endpoint. This method is a no-op stub
      // that returns "failed" to satisfy the VerifierClient interface.
      // TODO: Implement Sourcify session-based verification status if needed.
      return {
        status: "failed",
        message: "Sourcify does not support GUID-based status polling. Use submit() directly.",
      };
    },

    async isVerified(address: string): Promise<boolean> {
      // Use the Sourcify check-by-addresses endpoint to determine if verified
      const url = `${apiUrl}/check-by-addresses?addresses=${encodeURIComponent(address)}&chainIds=1`;
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

      let body: unknown = null;
      try {
        body = await responseRef.json();
      } catch {
        return false;
      }

      if (!Array.isArray(body) || body.length === 0) return false;
      const first = body[0];
      if (typeof first !== "object" || first === null) return false;
      const firstObj = first as Record<string, unknown>;
      const status = firstObj["status"];
      return status === "perfect" || status === "partial";
    },
  };
}

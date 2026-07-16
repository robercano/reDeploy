/**
 * verify-client.ts
 *
 * Browser-safe fetch clients for the deploy-server's two verification
 * endpoints. UNLIKE simulate-client.ts / deploy-client.ts, both endpoints
 * here respond with a single plain JSON payload (no SSE) — each check
 * completes and returns a full batch result in one round trip, matching
 * `/api/deployment`'s convention rather than the streamed simulate/deploy
 * conventions.
 *
 * ## Protocol — POST /api/verify/config
 *   Request:  Content-Type: application/json  body = ConfigSpec JSON
 *   Response: 200 application/json
 *     { clean: boolean, results: ConfigDriftResultEntry[] }
 *   Non-200 responses are read as text/json error bodies (same convention as
 *   simulate-client.ts / deploy-client.ts).
 *
 * ## Protocol — POST /api/verify/source
 *   Request:  Content-Type: application/json  body = "{}" (the server-side
 *             deployment + server-side ETHERSCAN_API_KEY are the only inputs
 *             — nothing meaningful is sent from the client).
 *   Response: 200 application/json
 *     { success: boolean, skipped: boolean, reason?: string, results: SourceVerifyResultEntry[] }
 *
 * ## Usage
 * ```ts
 * const drift = await runVerifyConfig(configSpec);
 * const source = await runVerifySource();
 * ```
 */

// ---------------------------------------------------------------------------
// Config-drift types (mirrors apps/deploy-server/src/verify/run-config-drift.ts)
// ---------------------------------------------------------------------------

export type ConfigDriftStatus = "match" | "drift" | "error" | "skipped";

export interface ConfigDriftResultEntry {
  id: string;
  status: ConfigDriftStatus;
  expected: unknown;
  actual: unknown;
  message?: string;
}

export interface ConfigDriftResponse {
  clean: boolean;
  results: ConfigDriftResultEntry[];
}

export type VerifyConfigResult =
  | { ok: true; result: ConfigDriftResponse }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Source-verify types (mirrors apps/deploy-server/src/verify/run-source-verify.ts)
// ---------------------------------------------------------------------------

export type SourceVerifyStatus = "verified" | "already-verified" | "pending" | "failed" | "skipped";

export interface SourceVerifyResultEntry {
  id: string;
  address: string;
  status: SourceVerifyStatus;
  message?: string;
}

export interface SourceVerifyResponse {
  success: boolean;
  skipped: boolean;
  reason?: string;
  results: SourceVerifyResultEntry[];
}

export type VerifySourceResult =
  | { ok: true; result: SourceVerifyResponse }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Shared response-reading helper
// ---------------------------------------------------------------------------

async function readJsonOrError<T>(response: Response): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore
    }
    const msg = detail ? `${response.status}: ${detail}` : `HTTP ${response.status}`;
    return { ok: false, error: msg };
  }

  try {
    const parsed = (await response.json()) as T;
    return { ok: true, result: parsed };
  } catch {
    return { ok: false, error: "Response body is empty or invalid JSON" };
  }
}

// ---------------------------------------------------------------------------
// POST /api/verify/config
// ---------------------------------------------------------------------------

/**
 * POST the config spec to /api/verify/config and return the parsed
 * config-drift report.
 *
 * @param spec     - The ConfigSpec JSON object to send (as the request body).
 * @param fetchFn  - The fetch implementation to use (defaults to global fetch;
 *                   accepted as a parameter for testability).
 */
export async function runVerifyConfig(
  spec: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<VerifyConfigResult> {
  let response: Response;
  try {
    response = await fetchFn("/api/verify/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }

  return readJsonOrError<ConfigDriftResponse>(response);
}

// ---------------------------------------------------------------------------
// POST /api/verify/source
// ---------------------------------------------------------------------------

/**
 * POST to /api/verify/source (empty body — verification runs entirely
 * against server-side state) and return the parsed source-verification report.
 *
 * @param fetchFn  - The fetch implementation to use (defaults to global fetch;
 *                   accepted as a parameter for testability).
 */
export async function runVerifySource(fetchFn: typeof fetch = fetch): Promise<VerifySourceResult> {
  let response: Response;
  try {
    response = await fetchFn("/api/verify/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }

  return readJsonOrError<SourceVerifyResponse>(response);
}

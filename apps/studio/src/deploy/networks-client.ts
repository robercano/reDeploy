/**
 * networks-client.ts
 *
 * Browser-safe client for the deploy-server's `GET /api/networks` endpoint
 * (issue #139), used to populate the studio's network selector.
 *
 * ## Contract
 * `GET /api/networks` → 200 `{ networks: [{ name, chainId? }, ...], defaultNetwork }`
 * (see apps/deploy-server/src/networks.ts's `listNetworks()`).
 *
 * ## Graceful fallback (NEVER throws)
 * The studio must keep working even when:
 *   - the deploy-server is unreachable (network error / not running yet),
 *   - the deploy-server predates this endpoint (404, or any non-2xx status),
 *   - the response isn't JSON (e.g. a dev proxy misconfiguration serving an
 *     HTML error page), or
 *   - the response is JSON but doesn't match the expected shape.
 *
 * In every one of these cases `fetchNetworks()` resolves to
 * `FALLBACK_NETWORKS_RESULT` — a single `"default"` network — rather than
 * throwing or rejecting, so App.tsx's toolbar selector always has at least
 * one option and the studio never crashes on mount.
 *
 * ## Why content-type is checked BEFORE reading the body
 * A response's body can only be consumed once. Several existing tests reuse
 * a single mocked `Response` instance (via `vi.fn().mockResolvedValue(...)`)
 * for EVERY fetch call the component under test makes, including this
 * module's own mount-time call. If we called `response.json()`
 * unconditionally, we could accidentally consume (and "poison" for a later
 * real read) a `Response` instance actually intended for a DIFFERENT
 * endpoint (e.g. the SSE body of `/api/simulate`) in a test harness that
 * doesn't distinguish requests by URL. Checking `Content-Type` first and
 * bailing out to the fallback for anything that isn't
 * `application/json` means we never touch `.body`/`.json()` on a response
 * that isn't actually shaped like our own — safe both for production (a real
 * deploy-server always sends `application/json` here) and for tests.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single network entry as returned by `GET /api/networks` — public fields only. */
export interface NetworkSummary {
  readonly name: string;
  readonly chainId?: number;
}

/** The parsed result of `fetchNetworks()`. */
export interface NetworksListResult {
  readonly networks: NetworkSummary[];
  readonly defaultNetwork: string;
}

/**
 * The fallback result used whenever the endpoint can't be reached, doesn't
 * exist yet, or returns something unexpected. A single `"default"` entry
 * mirrors `DEFAULT_NETWORK_NAME` in `apps/deploy-server/src/networks.ts` —
 * the network name the server itself falls back to when unconfigured.
 */
export const FALLBACK_NETWORKS_RESULT: NetworksListResult = {
  networks: [{ name: "default" }],
  defaultNetwork: "default",
};

// ---------------------------------------------------------------------------
// Response-shape validation
// ---------------------------------------------------------------------------

function isValidNetworkSummary(value: unknown): value is NetworkSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["name"] !== "string" || v["name"] === "") return false;
  if ("chainId" in v && v["chainId"] !== undefined && typeof v["chainId"] !== "number") {
    return false;
  }
  return true;
}

function parseNetworksListResult(data: unknown): NetworksListResult | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d["networks"]) || typeof d["defaultNetwork"] !== "string" || d["defaultNetwork"] === "") {
    return null;
  }
  const networks = d["networks"].filter(isValidNetworkSummary);
  if (networks.length === 0) return null;
  return { networks, defaultNetwork: d["defaultNetwork"] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * GET `/api/networks` and return its parsed listing, or
 * {@link FALLBACK_NETWORKS_RESULT} on any failure. Never throws/rejects.
 *
 * @param fetchFn - The fetch implementation to use (defaults to global fetch;
 *                  accepted as a parameter for testability).
 */
export async function fetchNetworks(fetchFn: typeof fetch = fetch): Promise<NetworksListResult> {
  try {
    const response = await fetchFn("/api/networks", { method: "GET" });
    if (!response || !response.ok) return FALLBACK_NETWORKS_RESULT;

    // See the module doc comment: never touch the body unless the response
    // is actually declared as JSON — protects shared-mock test Response
    // instances intended for a different endpoint from being consumed here.
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!contentType.includes("application/json")) return FALLBACK_NETWORKS_RESULT;

    const data: unknown = await response.json();
    const parsed = parseNetworksListResult(data);
    return parsed ?? FALLBACK_NETWORKS_RESULT;
  } catch {
    return FALLBACK_NETWORKS_RESULT;
  }
}

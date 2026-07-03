/**
 * deploy-client.ts
 *
 * Browser-safe SSE streaming client for the deploy-server POST /api/deploy
 * endpoint. This is the REAL-deploy sibling of simulate-client.ts.
 *
 * ## Protocol
 * POST /api/deploy
 *   Request:  Content-Type: application/json  body = DeploymentSpec JSON
 *   Response: text/event-stream
 *     - One `event: progress` frame, data = { phase: "deploying" } (emitted
 *       immediately after the stream opens).
 *     - Terminal `event: done` frame:
 *         - { success: true, deployment: DeploymentView } — on success. The
 *           DeploymentView's contracts carry REAL deployed addresses.
 *         - { success: true, deployment: null, warning: string } — deploy
 *           succeeded but the journal could not be read.
 *         - { success: false, errors: DeployError[] } — on failure.
 *   Non-200 responses are NOT SSE — read as text/json error body.
 *
 * ## CRITICAL DIFFERENCE FROM SIMULATE
 * The simulate stream emits per-step frames whose `address` is always null
 * (nothing is broadcast). The deploy stream instead delivers the fully-read
 * DeploymentView inside the terminal `done` frame, and its contracts carry
 * REAL `address` strings. We surface those addresses directly so the Inspector
 * renders a deployed view (blue monospace address) rather than the planned
 * "(not deployed)" state.
 *
 * ## Usage
 * ```ts
 * const result = await runDeploy(deploymentSpec, fetch);
 * if (result.ok) {
 *   // result.view is a DeploymentView whose contracts have addresses
 * } else {
 *   // result.error is an error message string
 * }
 * ```
 *
 * This module is browser-safe (no node-only imports). We reuse the generic SSE
 * frame splitter (`consumeSseFrames`) from simulate-client so the chunk-boundary
 * handling stays in one place.
 */

import type { DeploymentView } from "@redeploy/reader";
import { consumeSseFrames } from "./simulate-client.js";
import type { StructuredDeployError } from "./field-errors.js";

// ---------------------------------------------------------------------------
// SSE frame shapes coming from the /api/deploy server
// ---------------------------------------------------------------------------

/**
 * A deploy error received in the terminal done frame.
 *
 * `path` is a JSON-pointer-ish string relative to the DeploymentSpec's
 * `contracts` array (e.g. "contracts[2].id"), used by field-errors.ts to
 * highlight the offending input/node in the studio canvas (issue #83).
 */
export interface DeployStreamError {
  code?: string;
  path?: string;
  message?: string;
  [key: string]: unknown;
}

/** Terminal done frame data for a real deploy. */
export type DeployDone =
  | { success: true; deployment: DeploymentView | null; warning?: string }
  | { success: false; errors: DeployStreamError[] };

/** A parsed SSE event from the deploy stream. */
export type DeployEvent =
  | { kind: "progress"; phase: string }
  | { kind: "done"; done: DeployDone };

// ---------------------------------------------------------------------------
// Result type — mirrors SimulateResult
// ---------------------------------------------------------------------------

export type DeployResult =
  | { ok: true; view: DeploymentView }
  | { ok: false; error: string; errors?: StructuredDeployError[] };

// ---------------------------------------------------------------------------
// SSE frame parser (deploy-specific event union)
// ---------------------------------------------------------------------------

/**
 * Parse a single complete SSE frame into a DeployEvent. Returns null if the
 * frame is empty or unrecognised.
 *
 * A frame may contain multiple lines; we pick the first `event:` and `data:`
 * lines we find (case-sensitive, as per the SSE spec).
 */
export function parseDeployFrame(frame: string): DeployEvent | null {
  const lines = frame.split("\n");
  let eventName = "";
  let dataLine = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLine = line.slice("data:".length).trim();
    }
  }

  if (!eventName || !dataLine) return null;

  try {
    const data: unknown = JSON.parse(dataLine);
    if (eventName === "progress") {
      const phase =
        typeof data === "object" && data !== null && "phase" in data
          ? String((data as { phase: unknown }).phase)
          : "";
      return { kind: "progress", phase };
    }
    if (eventName === "done") {
      return { kind: "done", done: data as DeployDone };
    }
  } catch {
    // Malformed JSON — ignore this frame
  }
  return null;
}

// ---------------------------------------------------------------------------
// High-level deploy runner
// ---------------------------------------------------------------------------

/**
 * POST the deployment spec to /api/deploy and stream the SSE response into a
 * DeploymentView (or an error).
 *
 * The returned view's contracts carry the REAL deployed addresses (from the
 * done frame's `deployment` field), which is what makes the Inspector render a
 * deployed view rather than the planned/"(not deployed)" state.
 *
 * @param spec     - The DeploymentSpec JSON object to send (as the request body).
 * @param fetchFn  - The fetch implementation to use (defaults to global fetch;
 *                   accept as a parameter for testability).
 */
export async function runDeploy(
  spec: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<DeployResult> {
  let response: Response;

  try {
    response = await fetchFn("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
  } catch (err) {
    // Network error (server unreachable, CORS, etc.)
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    // Non-200 response — try to read an error message from the body
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore
    }
    const msg = detail ? `${response.status}: ${detail}` : `HTTP ${response.status}`;
    return { ok: false, error: msg };
  }

  if (!response.body) {
    return { ok: false, error: "Response body is empty" };
  }

  // Stream the SSE frames looking for the terminal done frame.
  let doneEvent: DeployDone | null = null;

  try {
    for await (const frame of consumeSseFrames(response.body)) {
      const event = parseDeployFrame(frame);
      if (event === null) continue;
      if (event.kind === "done") {
        doneEvent = event.done;
        break;
      }
      // "progress" frames are informational only — nothing to accumulate.
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Stream parse error: ${msg}` };
  }

  if (!doneEvent) {
    return { ok: false, error: "Stream ended without a done event" };
  }

  if (!doneEvent.success) {
    const rawErrors = (doneEvent as { success: false; errors: DeployStreamError[] }).errors ?? [];
    // Normalize into the structured shape shared with the simulate client so
    // App.tsx can highlight the offending field/node (issue #83), while still
    // keeping a joined plain-text message for the banner fallback.
    const structuredErrors: StructuredDeployError[] = rawErrors.map((e) => ({
      code: typeof e.code === "string" ? e.code : undefined,
      path: typeof e.path === "string" ? e.path : undefined,
      message: e.message ?? JSON.stringify(e),
    }));
    const msgs = structuredErrors.map((e) => e.message).join("; ");
    return { ok: false, error: `Deployment failed: ${msgs}`, errors: structuredErrors };
  }

  // success:true — the deployment view carries contracts WITH real addresses.
  // If the journal could not be read the server sends deployment:null + warning;
  // surface an empty-but-valid view carrying the warning so the app still shows
  // a (contract-less) deployed context rather than crashing.
  // Loose `== null` catches both an explicit `deployment:null` AND a done frame
  // where the field is entirely absent (`undefined`) — without this, `undefined`
  // would fall through and throw on `deployment.contracts.map(...)`.
  const deployment = doneEvent.deployment;
  if (deployment == null) {
    const warning = doneEvent.warning ?? "deployment succeeded but the journal could not be read";
    const view: DeploymentView = {
      contracts: [],
      configSteps: [],
      warnings: [warning],
    };
    return { ok: true, view };
  }

  // Normalise each contract to guarantee address is a string | null (the server
  // already provides real addresses; fall back to null only if a contract genuinely
  // lacks one).
  const contracts: DeploymentView["contracts"][number][] = deployment.contracts.map((c) => ({
    id: c.id,
    contractName: c.contractName,
    address: c.address ?? null,
    args: c.args,
    links: {
      dependencies: c.links?.dependencies ?? [],
      libraries: c.links?.libraries ?? {},
    },
  }));

  const view: DeploymentView = {
    contracts,
    configSteps: deployment.configSteps ?? [],
    warnings: deployment.warnings ?? [],
  };

  return { ok: true, view };
}

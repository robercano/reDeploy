/**
 * simulate-client.ts
 *
 * Browser-safe SSE streaming client for the deploy-server POST /api/simulate
 * endpoint.
 *
 * ## Protocol
 * POST /api/simulate
 *   Request:  Content-Type: application/json  body = DeploymentSpec JSON
 *   Response: text/event-stream
 *     - Zero or more `event: step` frames, each data = { id, contract, args?,
 *       after?, dependsOn, address: null } (topological order).
 *     - Terminal `event: done` frame: data = { success: true } or
 *       { success: false, errors: SimulateError[] }
 *   Non-200 responses are NOT SSE — read as text/json error body.
 *
 * ## Usage
 * ```ts
 * const result = await runSimulate(deploymentSpec, fetch);
 * if (result.ok) {
 *   // result.view is a DeploymentView
 * } else {
 *   // result.error is an error message string (always present — banner fallback)
 *   // result.errors, when present, carries the structured { code, path, message }[]
 *   // errors so callers can highlight the offending field/node (issue #83)
 * }
 * ```
 *
 * This module is browser-safe (no node-only imports). It is extracted
 * as a standalone helper for unit-testability.
 */

import type { DeploymentView } from "@redeploy/reader";
import type { StructuredDeployError } from "./field-errors.js";

// ---------------------------------------------------------------------------
// SSE step shape coming from the server
// ---------------------------------------------------------------------------

/** A single step frame received from the simulate SSE stream. */
export interface SimulateStep {
  id: string;
  contract: string;
  args?: unknown[];
  after?: string[];
  dependsOn: string[];
  address: null;
}

/**
 * A simulate error received in the done frame.
 *
 * `path` is a JSON-pointer-ish string relative to the DeploymentSpec's
 * `contracts` array (e.g. "contracts[2].id"), used by field-errors.ts to
 * highlight the offending input/node in the studio canvas (issue #83).
 */
export interface SimulateError {
  code?: string;
  path?: string;
  message?: string;
  [key: string]: unknown;
}

/** Terminal done frame data. */
export type SimulateDone =
  | { success: true }
  | { success: false; errors: SimulateError[] };

// ---------------------------------------------------------------------------
// Parsed SSE event union
// ---------------------------------------------------------------------------

export type SimulateEvent =
  | { kind: "step"; step: SimulateStep }
  | { kind: "done"; done: SimulateDone };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type SimulateResult =
  | { ok: true; view: DeploymentView }
  | { ok: false; error: string; errors?: StructuredDeployError[] };

// ---------------------------------------------------------------------------
// SSE frame parser
// ---------------------------------------------------------------------------

/**
 * Parse a single complete SSE frame (text between double-newline separators)
 * into a SimulateEvent. Returns null if the frame is empty or unrecognised.
 *
 * A frame may contain multiple lines; we pick the first `event:` and `data:`
 * lines we find (case-sensitive, as per the SSE spec).
 */
export function parseSseFrame(frame: string): SimulateEvent | null {
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
    if (eventName === "step") {
      return { kind: "step", step: data as SimulateStep };
    }
    if (eventName === "done") {
      return { kind: "done", done: data as SimulateDone };
    }
  } catch {
    // Malformed JSON — ignore this frame
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stream consumer
// ---------------------------------------------------------------------------

/**
 * Read the SSE response body via the WHATWG ReadableStream API (browser-safe)
 * and yield each complete SSE frame as a trimmed string (event-agnostic).
 *
 * This is the generic transport layer shared by both the simulate and deploy
 * clients: it handles chunk-boundary buffering and the trailing-frame flush,
 * but does NOT interpret event names — callers parse the yielded frames with
 * their own event-specific parser.
 *
 * @param body  - The response body ReadableStream<Uint8Array>
 */
export async function* consumeSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newlines to extract complete frames.
      // A trailing partial frame stays in the buffer.
      const parts = buffer.split("\n\n");
      // The last element is either "" (buffer ended cleanly) or a partial frame.
      buffer = parts.pop() ?? "";

      for (const frame of parts) {
        const trimmed = frame.trim();
        if (!trimmed) continue;
        yield trimmed;
      }
    }

    // Flush the decoder
    const remaining = decoder.decode();
    buffer += remaining;

    // Process any trailing complete frame (e.g. if stream ended without a
    // final \n\n)
    if (buffer.trim()) {
      yield buffer.trim();
    }
  } finally {
    // cancel() signals the underlying stream that no more data is needed
    // (e.g. when the consumer breaks early after a done event) and also
    // implicitly releases the lock, so we prefer it over releaseLock().
    await reader.cancel();
  }
}

/**
 * Read the SSE response body and yield SimulateEvents in arrival order.
 *
 * Thin wrapper over {@link consumeSseFrames} that applies {@link parseSseFrame}
 * to each raw frame. Kept as the simulate-specific public API (its behavior and
 * signature are unchanged).
 *
 * @param body  - The response body ReadableStream<Uint8Array>
 */
export async function* consumeSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SimulateEvent> {
  for await (const frame of consumeSseFrames(body)) {
    const event = parseSseFrame(frame);
    if (event) yield event;
  }
}

// ---------------------------------------------------------------------------
// High-level simulate runner
// ---------------------------------------------------------------------------

/**
 * POST the deployment spec to /api/simulate and stream the SSE response into
 * a DeploymentView (or an error).
 *
 * @param spec     - The DeploymentSpec JSON object to send (as the request body).
 * @param fetchFn  - The fetch implementation to use (defaults to global fetch;
 *                   accept as a parameter for testability).
 */
export async function runSimulate(
  spec: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<SimulateResult> {
  let response: Response;

  try {
    response = await fetchFn("/api/simulate", {
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

  // Stream the SSE frames and accumulate step events
  const contracts: DeploymentView["contracts"][number][] = [];
  let doneEvent: SimulateDone | null = null;

  try {
    for await (const event of consumeSseStream(response.body)) {
      if (event.kind === "step") {
        const step = event.step;
        contracts.push({
          id: step.id,
          contractName: step.contract,
          address: null,
          args: (step.args ?? []) as DeploymentView["contracts"][number]["args"],
          links: {
            dependencies: step.dependsOn ?? [],
            libraries: {},
          },
        });
      } else if (event.kind === "done") {
        doneEvent = event.done;
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Stream parse error: ${msg}` };
  }

  if (!doneEvent) {
    return { ok: false, error: "Stream ended without a done event" };
  }

  if (!doneEvent.success) {
    const rawErrors = (doneEvent as { success: false; errors: SimulateError[] }).errors;
    // Normalize into the structured shape shared with the deploy client so
    // App.tsx can highlight the offending field/node (issue #83), while still
    // keeping a joined plain-text message for the banner fallback.
    const structuredErrors: StructuredDeployError[] = rawErrors.map((e) => ({
      code: typeof e.code === "string" ? e.code : undefined,
      path: typeof e.path === "string" ? e.path : undefined,
      message: e.message ?? JSON.stringify(e),
    }));
    const msgs = structuredErrors.map((e) => e.message).join("; ");
    return { ok: false, error: `Simulation failed: ${msgs}`, errors: structuredErrors };
  }

  const view: DeploymentView = {
    contracts,
    configSteps: [],
    warnings: [],
  };

  return { ok: true, view };
}

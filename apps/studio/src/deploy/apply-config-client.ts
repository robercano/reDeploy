/**
 * apply-config-client.ts
 *
 * Browser-safe SSE streaming client for the deploy-server POST /api/apply-config
 * endpoint (issue #151). This is the "run the config against a real chain"
 * sibling of verify-client.ts's runVerifyConfig (which only checks for drift —
 * it never broadcasts anything).
 *
 * ## Protocol
 * POST /api/apply-config[?network=<name>]
 *   Request:  Content-Type: application/json  body = bare ConfigSpec JSON
 *             (no envelope — same convention as /api/verify/config and
 *             /api/deploy).
 *   Response: text/event-stream
 *     - Zero or more `event: step` frames per config step:
 *         { stepId, kind: "setX"|"grantRole"|"wire", status: "executing" }
 *         then either
 *         { stepId, kind, status: "completed" }
 *         or
 *         { stepId, kind, status: "failed", message: "config step failed" }
 *     - Terminal `event: done` frame:
 *         { success: true, executedStepIds, skippedStepIds, completedStepIds,
 *           deployment: DeploymentView | null, warning?: string }
 *         or
 *         { success: false, errors: [{ code?, message }, ...] }
 *   Non-200 responses are NOT SSE — read as text/json error body (same
 *   convention as simulate/deploy/verify).
 *
 * ## Usage
 * ```ts
 * const result = await runApplyConfig(configSpec, fetch, selectedNetwork);
 * if (result.ok) {
 *   // result.view (when non-null) is a DeploymentView with refreshed
 *   // configSteps reflecting completion; result.steps carries the raw
 *   // per-step execution trace (including any steps skipped this run).
 * } else {
 *   // result.error is a banner-ready message; result.steps carries whichever
 *   // per-step frames arrived before the failure (so a failing step's own
 *   // message can be surfaced alongside the generic banner).
 * }
 * ```
 *
 * This module is browser-safe (no node-only imports) — DeploymentView is a
 * type-only import from @redeploy/reader, exactly like deploy-client.ts.
 */

import type { DeploymentView } from "@redeploy/reader";
import { consumeSseFrames } from "./simulate-client.js";

// ---------------------------------------------------------------------------
// SSE frame shapes coming from the /api/apply-config server
// ---------------------------------------------------------------------------

/** The kind of a config step, as sent by the server. */
export type ConfigStepRunKind = "setX" | "grantRole" | "wire";

/** The lifecycle status of a single step's execution attempt. */
export type ConfigStepRunStatus = "executing" | "completed" | "failed";

/** A single `step` SSE frame. */
export interface ApplyConfigStepFrame {
  stepId: string;
  kind: ConfigStepRunKind;
  status: ConfigStepRunStatus;
  /** Only present when status === "failed" (a fixed, non-leaking message). */
  message?: string;
}

/**
 * An error received in the terminal done frame.
 *
 * Mirrors the deploy-server's ConfigExecError mapping: `code` is present for
 * structured errors (e.g. "INVALID_SPEC", "UNKNOWN_REF", "JOURNAL_ERROR"),
 * absent for the generic "config step failed" fallback.
 */
export interface ApplyConfigStreamError {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/** Terminal done frame data. */
export type ApplyConfigDone =
  | {
      success: true;
      executedStepIds: string[];
      skippedStepIds: string[];
      completedStepIds: string[];
      deployment: DeploymentView | null;
      warning?: string;
    }
  | { success: false; errors: ApplyConfigStreamError[] };

/** A parsed SSE event from the apply-config stream. */
export type ApplyConfigEvent =
  | { kind: "step"; step: ApplyConfigStepFrame }
  | { kind: "done"; done: ApplyConfigDone };

// ---------------------------------------------------------------------------
// Per-step accumulator shape (surfaced to callers regardless of ok/!ok)
// ---------------------------------------------------------------------------

/**
 * A per-step execution record accumulated from the stream's `step` frames.
 * When a step reports both "executing" and a terminal status, only the LAST
 * (terminal) status is kept — insertion order (first appearance) is preserved.
 */
export interface ApplyConfigStepResult {
  stepId: string;
  kind: ConfigStepRunKind;
  status: ConfigStepRunStatus;
  message?: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ApplyConfigResult =
  | {
      ok: true;
      view: DeploymentView | null;
      executedStepIds: string[];
      skippedStepIds: string[];
      completedStepIds: string[];
      steps: ApplyConfigStepResult[];
      warning?: string;
    }
  | {
      ok: false;
      error: string;
      errors?: ApplyConfigStreamError[];
      steps: ApplyConfigStepResult[];
    };

// ---------------------------------------------------------------------------
// SSE frame parser (apply-config-specific event union)
// ---------------------------------------------------------------------------

/**
 * Parse a single complete SSE frame into an ApplyConfigEvent. Returns null if
 * the frame is empty or unrecognised.
 *
 * A frame may contain multiple lines; we pick the first `event:` and `data:`
 * lines we find (case-sensitive, as per the SSE spec).
 */
export function parseApplyConfigFrame(frame: string): ApplyConfigEvent | null {
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
      return { kind: "step", step: data as ApplyConfigStepFrame };
    }
    if (eventName === "done") {
      return { kind: "done", done: data as ApplyConfigDone };
    }
  } catch {
    // Malformed JSON — ignore this frame
  }
  return null;
}

// ---------------------------------------------------------------------------
// High-level apply-config runner
// ---------------------------------------------------------------------------

/**
 * POST the config spec to /api/apply-config and stream the SSE response into
 * an ApplyConfigResult.
 *
 * @param config   - The ConfigSpec JSON object to send (as the bare request
 *                   body — no envelope, same convention as runVerifyConfig).
 * @param fetchFn  - The fetch implementation to use (defaults to global fetch;
 *                   accepted as a parameter for testability).
 * @param network  - Optional target network name (issue #139 convention),
 *                   sent as `?network=<name>` (URI-encoded). Omitted/undefined
 *                   ⇒ no query param at all — resolves to the deploy-server's
 *                   default network.
 */
export async function runApplyConfig(
  config: unknown,
  fetchFn: typeof fetch = fetch,
  network?: string,
): Promise<ApplyConfigResult> {
  let response: Response;

  const url =
    network !== undefined && network !== ""
      ? `/api/apply-config?network=${encodeURIComponent(network)}`
      : "/api/apply-config";

  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch (err) {
    // Network error (server unreachable, CORS, etc.)
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}`, steps: [] };
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
    return { ok: false, error: msg, steps: [] };
  }

  if (!response.body) {
    return { ok: false, error: "Response body is empty", steps: [] };
  }

  // Stream the SSE frames, accumulating per-step status and looking for the
  // terminal done frame.
  const stepsById = new Map<string, ApplyConfigStepResult>();
  let doneEvent: ApplyConfigDone | null = null;

  try {
    for await (const frame of consumeSseFrames(response.body)) {
      const event = parseApplyConfigFrame(frame);
      if (event === null) continue;
      if (event.kind === "step") {
        const { stepId, kind, status, message } = event.step;
        stepsById.set(stepId, {
          stepId,
          kind,
          status,
          ...(message !== undefined ? { message } : {}),
        });
      } else if (event.kind === "done") {
        doneEvent = event.done;
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Stream parse error: ${msg}`, steps: [...stepsById.values()] };
  }

  const steps = [...stepsById.values()];

  if (!doneEvent) {
    return { ok: false, error: "Stream ended without a done event", steps };
  }

  if (!doneEvent.success) {
    const rawErrors = (doneEvent as { success: false; errors: ApplyConfigStreamError[] }).errors ?? [];
    const msgs = rawErrors.map((e) => e.message ?? JSON.stringify(e)).join("; ");
    return {
      ok: false,
      error: `Apply config failed: ${msgs}`,
      errors: rawErrors,
      steps,
    };
  }

  return {
    ok: true,
    view: doneEvent.deployment ?? null,
    executedStepIds: doneEvent.executedStepIds ?? [],
    skippedStepIds: doneEvent.skippedStepIds ?? [],
    completedStepIds: doneEvent.completedStepIds ?? [],
    steps,
    ...(doneEvent.warning !== undefined ? { warning: doneEvent.warning } : {}),
  };
}

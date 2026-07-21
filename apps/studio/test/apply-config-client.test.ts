/**
 * apply-config-client.test.ts
 *
 * Unit tests for the SSE apply-config client helper (runApplyConfig), issue
 * #151. Modeled on deploy-client.test.ts: builds a synthetic SSE stream via
 * makeStream() and asserts the parsed per-step statuses + terminal result.
 *
 * Covered paths:
 * - parseApplyConfigFrame: step / done / malformed frames
 * - success: step frames (executing→completed) + done{success:true} →
 *   executedStepIds/skippedStepIds/completedStepIds + view populated
 * - idempotent re-run: all steps reported skipped, none executed, still ok
 * - a step reports "failed" + done{success:false} → error mapping, and the
 *   failed step's message is present in the accumulated `steps` list
 * - non-200 error response / network reject / stream-ends-without-done
 * - the network name is sent as the `?network=` query param
 *
 * All tests are pure / browser-safe (no node-only imports).
 */

import { describe, it, expect, vi } from "vitest";
import { runApplyConfig, parseApplyConfigFrame } from "../src/deploy/apply-config-client.js";
import type { DeploymentView } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> from an array of string chunks. */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function stepFrame(
  stepId: string,
  kind: "setX" | "grantRole" | "wire",
  status: "executing" | "completed" | "failed",
  message?: string,
): string {
  const data =
    message !== undefined ? { stepId, kind, status, message } : { stepId, kind, status };
  return `event: step\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneOkFrame(
  executedStepIds: string[],
  skippedStepIds: string[],
  completedStepIds: string[],
  deployment: DeploymentView | null,
  warning?: string,
): string {
  const data =
    warning !== undefined
      ? { success: true, executedStepIds, skippedStepIds, completedStepIds, deployment, warning }
      : { success: true, executedStepIds, skippedStepIds, completedStepIds, deployment };
  return `event: done\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneErrorFrame(errors: { code?: string; message: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
}

const SAMPLE_VIEW: DeploymentView = {
  contracts: [
    {
      id: "token",
      contractName: "ERC20Token",
      address: "0xTOKEN000000000000000000000000000000000001",
      args: ["MyToken"],
      links: { dependencies: [], libraries: {} },
    },
  ],
  configSteps: [
    { id: "grant-minter", kind: "grantRole", completed: true, completedAt: "2026-07-21T00:00:00.000Z" },
  ],
  warnings: [],
};

// ---------------------------------------------------------------------------
// parseApplyConfigFrame
// ---------------------------------------------------------------------------

describe("parseApplyConfigFrame", () => {
  it("parses a step frame", () => {
    const frame = `event: step\ndata: {"stepId":"grant-minter","kind":"grantRole","status":"executing"}`;
    const result = parseApplyConfigFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("step");
    if (result!.kind === "step") {
      expect(result!.step.stepId).toBe("grant-minter");
      expect(result!.step.kind).toBe("grantRole");
      expect(result!.step.status).toBe("executing");
    }
  });

  it("parses a done{success:true} frame", () => {
    const frame = `event: done\ndata: {"success":true,"executedStepIds":[],"skippedStepIds":[],"completedStepIds":[],"deployment":null}`;
    const result = parseApplyConfigFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("done");
    if (result!.kind === "done") {
      expect(result!.done.success).toBe(true);
    }
  });

  it("returns null for empty / no-event / no-data / unknown / malformed frames", () => {
    expect(parseApplyConfigFrame("")).toBeNull();
    expect(parseApplyConfigFrame(`data: {"success":true}`)).toBeNull();
    expect(parseApplyConfigFrame(`event: done`)).toBeNull();
    expect(parseApplyConfigFrame(`event: mystery\ndata: {"x":1}`)).toBeNull();
    expect(parseApplyConfigFrame(`event: done\ndata: not-json`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runApplyConfig — success path
// ---------------------------------------------------------------------------

describe("runApplyConfig — success path", () => {
  it("POSTs the bare config spec to /api/apply-config", async () => {
    const raw =
      stepFrame("grant-minter", "grantRole", "executing") +
      stepFrame("grant-minter", "grantRole", "completed") +
      doneOkFrame(["grant-minter"], [], ["grant-minter"], SAMPLE_VIEW);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const config = { version: 1, steps: [] };
    await runApplyConfig(config, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/apply-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  });

  it("accumulates step statuses (executing→completed) and returns the terminal id lists + view", async () => {
    const raw =
      stepFrame("grant-minter", "grantRole", "executing") +
      stepFrame("grant-minter", "grantRole", "completed") +
      doneOkFrame(["grant-minter"], [], ["grant-minter"], SAMPLE_VIEW);
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // Only the LAST (terminal) status is kept per step id.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual({ stepId: "grant-minter", kind: "grantRole", status: "completed" });

    expect(result.executedStepIds).toEqual(["grant-minter"]);
    expect(result.skippedStepIds).toEqual([]);
    expect(result.completedStepIds).toEqual(["grant-minter"]);
    expect(result.view).not.toBeNull();
    expect(result.view!.configSteps[0].completed).toBe(true);
  });

  it("the idempotent case: all steps reported skipped, none executed, still ok:true", async () => {
    const raw = doneOkFrame([], ["grant-minter", "set-fee"], ["grant-minter", "set-fee"], SAMPLE_VIEW);
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.executedStepIds).toEqual([]);
    expect(result.skippedStepIds).toEqual(["grant-minter", "set-fee"]);
    // No `step` frames were emitted for skipped steps in this run.
    expect(result.steps).toEqual([]);
  });

  it("returns view:null and carries the warning when deployment is null", async () => {
    const raw = doneOkFrame(["s1"], [], ["s1"], null, "could not read journal");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view).toBeNull();
    expect(result.warning).toBe("could not read journal");
  });

  it("handles a stream split across many small chunks", async () => {
    const raw =
      stepFrame("s1", "setX", "executing") +
      stepFrame("s1", "setX", "completed") +
      doneOkFrame(["s1"], [], ["s1"], SAMPLE_VIEW);
    const bytes = raw.split("");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream(bytes), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.steps).toEqual([{ stepId: "s1", kind: "setX", status: "completed" }]);
  });
});

// ---------------------------------------------------------------------------
// runApplyConfig — failure paths
// ---------------------------------------------------------------------------

describe("runApplyConfig — failure paths", () => {
  it("a step reports failed + done{success:false} maps to ok:false with the step's message preserved", async () => {
    const raw =
      stepFrame("grant-minter", "grantRole", "executing") +
      stepFrame("grant-minter", "grantRole", "failed", "config step failed") +
      doneErrorFrame([{ message: "config step failed" }]);
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("config step failed");
    expect(result.steps).toEqual([
      { stepId: "grant-minter", kind: "grantRole", status: "failed", message: "config step failed" },
    ]);
    expect(result.errors).toEqual([{ message: "config step failed" }]);
  });

  it("maps a structured INVALID_SPEC error with code", async () => {
    const raw = doneErrorFrame([{ code: "INVALID_SPEC", message: "step 0: unknown ref" }]);
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("unknown ref");
    expect(result.errors).toEqual([{ code: "INVALID_SPEC", message: "step 0: unknown ref" }]);
  });

  it("returns ok:false on a non-200 response and includes status + body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("invalid config format", { status: 400 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("400");
    expect(result.error).toContain("invalid config format");
    expect(result.steps).toEqual([]);
  });

  it("returns ok:false on fetch rejection (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("Network error");
    expect(result.error).toContain("Failed to fetch");
  });

  it("returns ok:false when the stream ends without a done event", async () => {
    const raw = stepFrame("s1", "setX", "executing");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("done event");
    // The in-flight step's last-seen status is still surfaced.
    expect(result.steps).toEqual([{ stepId: "s1", kind: "setX", status: "executing" }]);
  });

  it("returns ok:false when the response body is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await runApplyConfig({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("empty");
  });
});

// ---------------------------------------------------------------------------
// runApplyConfig — network param
// ---------------------------------------------------------------------------

describe("runApplyConfig — network param", () => {
  it("omitted network param → POSTs to /api/apply-config with no query string", async () => {
    const raw = doneOkFrame([], [], [], null, "warn");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    await runApplyConfig({}, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/apply-config", expect.anything());
  });

  it("undefined network param → POSTs to /api/apply-config with no query string", async () => {
    const raw = doneOkFrame([], [], [], null, "warn");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    await runApplyConfig({}, mockFetch, undefined);

    expect(mockFetch).toHaveBeenCalledWith("/api/apply-config", expect.anything());
  });

  it("a network name → POSTs to /api/apply-config?network=<name>", async () => {
    const raw = doneOkFrame([], [], [], null, "warn");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    await runApplyConfig({}, mockFetch, "sepolia");

    expect(mockFetch).toHaveBeenCalledWith("/api/apply-config?network=sepolia", expect.anything());
  });

  it("a network name with special characters is URI-encoded", async () => {
    const raw = doneOkFrame([], [], [], null, "warn");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    await runApplyConfig({}, mockFetch, "my network/1");

    expect(mockFetch).toHaveBeenCalledWith(
      `/api/apply-config?network=${encodeURIComponent("my network/1")}`,
      expect.anything(),
    );
  });

  it("an empty-string network param is treated the same as omitted (no query string)", async () => {
    const raw = doneOkFrame([], [], [], null, "warn");
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    await runApplyConfig({}, mockFetch, "");

    expect(mockFetch).toHaveBeenCalledWith("/api/apply-config", expect.anything());
  });
});

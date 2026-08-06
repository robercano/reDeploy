/**
 * App.reapplyNarrowing.test.tsx
 *
 * Pins issue #153 review finding B1 (the most serious finding — flagged by
 * BOTH the correctness and security lenses): the "Re-apply" confirm modal
 * promises that clicking it broadcasts a real transaction for ONE named step
 * and that "no other step will be sent". Before this fix, `handleApplyConfig`
 * POSTed the studio's ENTIRE current `config` (every step on the canvas) with
 * only `forceStepIds` narrowed — but `applyConfig()` server-side executes
 * EVERY step in the POSTed spec that isn't already journaled, regardless of
 * `forceStepIds`. So a single-step re-apply could ALSO broadcast every
 * not-yet-applied step still on the canvas, contradicting the modal.
 *
 * The fix narrows the POSTed spec itself (via `narrowConfigToStep`) to just
 * the target step. This file verifies that end-to-end, two ways:
 *   1. `narrowConfigToStep` (spied via a module mock that still delegates to
 *      the real implementation) is called with `(config, stepId)` exactly
 *      when a single-step re-apply is confirmed — and NOT for a full
 *      (non-forced) apply.
 *   2. The actual request body POSTed to `/api/apply-config` for a re-apply
 *      is deep-equal to `narrowConfigToStep`'s real return value — i.e. the
 *      network request is genuinely built from the narrowed spec.
 *
 * Isolated in its own file (module-mock scope) — mirrors the isolation
 * rationale in App.overview-edges-wiring.test.tsx.
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing App so the mock factory
// runs first. Delegates to the REAL narrowConfigToStep so behaviour is
// unchanged; only records calls/return values for assertions.
// ---------------------------------------------------------------------------

const { narrowConfigToStepSpy } = vi.hoisted(() => ({ narrowConfigToStepSpy: vi.fn() }));

vi.mock("../src/spec/narrow-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/spec/narrow-config.js")>();
  narrowConfigToStepSpy.mockImplementation(actual.narrowConfigToStep);
  return {
    ...actual,
    narrowConfigToStep: narrowConfigToStepSpy,
  };
});

// Import App AFTER vi.mock so the mock factory runs first.
import App from "../src/App.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function doneOkFrame(): string {
  return `event: done\ndata: ${JSON.stringify({
    success: true,
    executedStepIds: [],
    skippedStepIds: [],
    completedStepIds: [],
    deployment: { contracts: [], configSteps: [], warnings: [] },
  })}\n\n`;
}

function mockFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string) => {
    if (url === "/api/verify/config") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            clean: false,
            results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }],
          }),
          { status: 200 },
        ),
      );
    }
    if (url === "/api/verify/source") {
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, skipped: false, results: [] }), { status: 200 }),
      );
    }
    if (url.startsWith("/api/apply-config")) {
      return Promise.resolve(
        new Response(makeStream([enc(doneOkFrame())]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  });
}

function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

function fillArg(index: number, value: string) {
  fireEvent.change(screen.getByLabelText(`arg-${index}`), { target: { value } });
}

/** Mirrors App.applyConfig.test.tsx's helper: adds a real grantRole-shaped call. */
function addGrantRoleStep(nodeIndex = 0) {
  const configSection = document.querySelectorAll(
    "[data-testid^='node-config-section-']",
  )[nodeIndex] as HTMLElement;
  fireEvent.click(within(configSection).getByText("Add config call"));
  fireEvent.click(within(configSection).getByText("grantRole(bytes32,address)"));
}

afterEach(() => {
  vi.restoreAllMocks();
  narrowConfigToStepSpy.mockClear();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App — Re-apply narrows the POSTed spec to a single step", () => {
  it("calls narrowConfigToStep(config, stepId) exactly once, and the POSTed body equals its return value", async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));
    await waitFor(() => {
      expect(screen.getByTestId("config-step-setFee-drift")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(narrowConfigToStepSpy).toHaveBeenCalledTimes(1);
    });
    // Second arg is the target step id.
    expect(narrowConfigToStepSpy.mock.calls[0]![1]).toBe("setFee");

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith("/api/apply-config")),
      ).toBe(true);
    });
    const applyCall = fetchSpy.mock.calls.find((c: unknown[]) =>
      (c[0] as string).startsWith("/api/apply-config"),
    )!;
    const sentBody: unknown = JSON.parse((applyCall[1] as { body: string }).body);
    const narrowedSpec = narrowConfigToStepSpy.mock.results[0]!.value;

    // The exact spec that was POSTed must be exactly what narrowConfigToStep
    // produced — not the full, unnarrowed `config`.
    expect(sentBody).toEqual(narrowedSpec);
  });

  it("a full (non-forced) 'Apply config' does NOT call narrowConfigToStep — the full config is sent unchanged", async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    addNodeByName("Registry");
    fillArg(0, "0x0000000000000000000000000000000000000001");
    addGrantRoleStep(0);

    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith("/api/apply-config")),
      ).toBe(true);
    });

    expect(narrowConfigToStepSpy).not.toHaveBeenCalled();
  });
});

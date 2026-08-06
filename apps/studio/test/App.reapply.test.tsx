/**
 * App.reapply.test.tsx
 *
 * Integration tests for the config-drift one-click "Re-apply" flow (issue
 * #153), wiring together:
 *   - Inspector's drift detail panel (click the drift badge to expand
 *     expected/actual/message, only offering "Re-apply" for a
 *     drifted/errored step).
 *   - App.tsx's onReapplyStep, which reuses the SAME confirm modal / guard
 *     flow as the existing "Apply config" button (no unconfirmed write path).
 *   - A successful forced re-apply automatically re-running
 *     POST /api/verify/config so the drift badge refreshes.
 *
 * Mirrors the patterns in App.verify.test.tsx (drift/verify fetch mocking)
 * and App.applyConfig.test.tsx (SSE apply-config mocking + confirm gating).
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../src/App.js";

// ---------------------------------------------------------------------------
// SSE helpers (mirrors App.applyConfig.test.tsx)
// ---------------------------------------------------------------------------

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function stepFrame(
  stepId: string,
  kind: "setX" | "grantRole" | "wire",
  status: "executing" | "completed" | "failed",
): string {
  return `event: step\ndata: ${JSON.stringify({ stepId, kind, status })}\n\n`;
}

interface ConfiguredStep {
  id: string;
  kind: string;
  completed: boolean;
  completedAt?: string | null;
}

function doneOkFrame(
  executedStepIds: string[],
  skippedStepIds: string[],
  completedStepIds: string[],
  configSteps: ConfiguredStep[],
): string {
  const deployment = {
    contracts: [],
    configSteps: configSteps.map((s) => ({
      id: s.id,
      kind: s.kind,
      completed: s.completed,
      completedAt: s.completedAt ?? null,
    })),
    warnings: [],
  };
  return `event: done\ndata: ${JSON.stringify({
    success: true,
    executedStepIds,
    skippedStepIds,
    completedStepIds,
    deployment,
  })}\n\n`;
}

// ---------------------------------------------------------------------------
// Combined fetch dispatcher: /api/verify/config (queued responses, one per
// call — mirrors the "refresh after re-apply" scenario), /api/verify/source,
// and /api/apply-config?... (SSE, prefix-matched since it carries a query
// string).
// ---------------------------------------------------------------------------

function mockCombinedFetch(opts: {
  verifyConfigResponses: { status: number; body: unknown }[];
  verifySourceResponse: { status: number; body: unknown };
  applyConfigRaw: string;
}): { fetchSpy: ReturnType<typeof vi.fn>; verifyConfigCallUrls: string[] } {
  const verifyConfigCallUrls: string[] = [];
  let verifyConfigCallIndex = 0;

  const fetchSpy = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/verify/config") {
      verifyConfigCallUrls.push(url);
      const idx = Math.min(verifyConfigCallIndex, opts.verifyConfigResponses.length - 1);
      const response = opts.verifyConfigResponses[idx];
      verifyConfigCallIndex += 1;
      return Promise.resolve(new Response(JSON.stringify(response.body), { status: response.status }));
    }
    if (url === "/api/verify/source") {
      return Promise.resolve(
        new Response(JSON.stringify(opts.verifySourceResponse.body), {
          status: opts.verifySourceResponse.status,
        }),
      );
    }
    if (url.startsWith("/api/apply-config")) {
      return Promise.resolve(
        new Response(makeStream([enc(opts.applyConfigRaw)]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  });

  return { fetchSpy, verifyConfigCallUrls };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Runs Verify so the Inspector shows a "drift" badge for the sample view's "setFee" step. */
async function setupWithDrift(fetchSpy: ReturnType<typeof vi.fn>) {
  render(<App />);
  fireEvent.click(screen.getByTestId("deploy-verify-button"));
  await waitFor(() => {
    expect(screen.getByTestId("config-step-setFee-drift")).not.toBeNull();
  });
  expect(fetchSpy).toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Drift detail panel — expand/collapse via the drift badge
// ---------------------------------------------------------------------------

describe("App — drift detail panel", () => {
  it("clicking the drift badge reveals expected/actual/message; a Re-apply button is present for 'drift'", async () => {
    const { fetchSpy } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: {
            clean: false,
            results: [{ id: "setFee", status: "drift", expected: 500, actual: 999, message: "mismatch" }],
          },
        },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw: doneOkFrame([], [], [], []),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);

    expect(screen.queryByTestId("config-step-setFee-drift-detail")).toBeNull();

    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));

    const detail = screen.getByTestId("config-step-setFee-drift-detail");
    expect(detail).not.toBeNull();
    expect(screen.getByTestId("config-step-setFee-drift-expected").textContent).toContain("500");
    expect(screen.getByTestId("config-step-setFee-drift-actual").textContent).toContain("999");
    expect(screen.getByTestId("config-step-setFee-drift-message").textContent).toContain("mismatch");
    expect(screen.getByTestId("config-step-setFee-reapply")).not.toBeNull();

    // Clicking again collapses it.
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.queryByTestId("config-step-setFee-drift-detail")).toBeNull();
  });

  it("does NOT render a Re-apply button for a 'match' step", async () => {
    const { fetchSpy } = mockCombinedFetch({
      verifyConfigResponses: [
        { status: 200, body: { clean: true, results: [{ id: "setFee", status: "match", expected: 500, actual: 500 }] } },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw: doneOkFrame([], [], [], []),
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));
    await waitFor(() => {
      expect(screen.getByTestId("config-step-setFee-drift")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.getByTestId("config-step-setFee-drift-detail")).not.toBeNull();
    expect(screen.queryByTestId("config-step-setFee-reapply")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-apply flow — confirm-gated, forceStepIds, post-success drift refresh
// ---------------------------------------------------------------------------

describe("App — Re-apply flow", () => {
  it("clicking Re-apply opens the SAME confirm modal (no unconfirmed write)", async () => {
    const { fetchSpy } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: { clean: false, results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }] },
        },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw: doneOkFrame([], [], [], []),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));

    // Modal open; no POST to /api/apply-config yet.
    const modal = screen.getByTestId("apply-config-modal");
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain("setFee");
    expect(screen.getByTestId("apply-config-step-count").textContent).toBe("1");
    expect(fetchSpy.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith("/api/apply-config"))).toBe(
      false,
    );
  });

  it("confirming the re-apply modal POSTs /api/apply-config with forceStepIds=<stepId>", async () => {
    const { fetchSpy } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: { clean: false, results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }] },
        },
        { status: 200, body: { clean: true, results: [{ id: "setFee", status: "match", expected: 999, actual: 999 }] } },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw: doneOkFrame(
        ["setFee"],
        [],
        ["setFee"],
        [{ id: "setFee", kind: "setX", completed: true, completedAt: "2026-08-06T00:00:00.000Z" }],
      ),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      const applyCalls = fetchSpy.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).startsWith("/api/apply-config"),
      );
      expect(applyCalls).toHaveLength(1);
    });

    const applyUrl = fetchSpy.mock.calls.find((c: unknown[]) =>
      (c[0] as string).startsWith("/api/apply-config"),
    )![0] as string;
    expect(applyUrl).toBe("/api/apply-config?forceStepIds=setFee");
  });

  it("on success, automatically re-runs /api/verify/config so the drift badge refreshes to 'match'", async () => {
    const { fetchSpy, verifyConfigCallUrls } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: { clean: false, results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }] },
        },
        { status: 200, body: { clean: true, results: [{ id: "setFee", status: "match", expected: 999, actual: 999 }] } },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw:
        stepFrame("setFee", "setX", "executing") +
        stepFrame("setFee", "setX", "completed") +
        doneOkFrame(
          ["setFee"],
          [],
          ["setFee"],
          [{ id: "setFee", kind: "setX", completed: true, completedAt: "2026-08-06T00:00:00.000Z" }],
        ),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(verifyConfigCallUrls.length).toBe(2);
    });

    await waitFor(() => {
      expect(screen.getByTestId("config-step-setFee-drift").textContent).toBe("match");
    });
  });

  it("Cancel on the re-apply confirm modal does NOT POST /api/apply-config", async () => {
    const { fetchSpy } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: { clean: false, results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }] },
        },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw: doneOkFrame([], [], [], []),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));
    fireEvent.click(screen.getByTestId("apply-config-cancel"));

    expect(screen.queryByTestId("apply-config-modal")).toBeNull();
    expect(
      fetchSpy.mock.calls.some((c: unknown[]) => (c[0] as string).startsWith("/api/apply-config")),
    ).toBe(false);
  });

  it("re-apply confirm wording is distinct from the normal full-apply confirm wording", async () => {
    const { fetchSpy } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: { clean: false, results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }] },
        },
      ],
      verifySourceResponse: { status: 200, body: { success: true, skipped: false, results: [] } },
      applyConfigRaw: doneOkFrame([], [], [], []),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));

    const modal = screen.getByTestId("apply-config-modal");
    expect(modal.textContent).toContain("Confirm re-apply step");
    expect(modal.textContent).not.toContain("Confirm apply config");
    expect(screen.getByTestId("apply-config-confirm").textContent).toBe("Re-apply for real");
  });
});

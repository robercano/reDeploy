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

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

  it("when the post-re-apply drift refresh ITSELF fails (500), the apply success banner still shows, no error banner appears, and the drift badge stays at its last-known ('drift') status — issue #153 review finding B4", async () => {
    const { fetchSpy, verifyConfigCallUrls } = mockCombinedFetch({
      verifyConfigResponses: [
        {
          status: 200,
          body: { clean: false, results: [{ id: "setFee", status: "drift", expected: 500, actual: 999 }] },
        },
        // The SECOND /api/verify/config call (the post-re-apply refresh)
        // fails — exercises the `if (driftOutcome.ok)` false branch at
        // App.tsx's handleApplyConfig, which was previously untested and
        // inexpressible with this helper.
        { status: 500, body: { error: "internal error" } },
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

    // Both /api/verify/config calls happened (the second one failed).
    await waitFor(() => {
      expect(verifyConfigCallUrls.length).toBe(2);
    });

    // The apply itself succeeded — its success banner shows, unaffected by
    // the drift-refresh failure (which is best-effort, per handleApplyConfig's
    // doc comment).
    await waitFor(() => {
      expect(screen.queryByTestId("apply-config-success")).not.toBeNull();
    });
    expect(screen.queryByTestId("apply-config-error")).toBeNull();

    // The drift badge keeps its LAST-KNOWN status ("drift") rather than being
    // cleared to a blank/no-data state or crashing the app — see the
    // deliberate on-failure-behaviour comment in App.tsx's handleApplyConfig.
    expect(screen.getByTestId("config-step-setFee-drift").textContent).toBe("drift");
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

  it("the re-apply modal's copy is accurate (issue #153 review finding B1) — no false 'already applied' claim, and truthfully says no other step is sent", async () => {
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
    // Old (fixed) copy asserted the step "was already applied" — false when a
    // drifted step was never journaled. The reworded copy makes no claim
    // about journal history at all.
    expect(modal.textContent).not.toContain("already applied");
    // Now structurally true (the POSTed spec is narrowed to this one step —
    // see App.reapplyNarrowing.test.tsx), not just an unchecked UI label.
    expect(modal.textContent?.toLowerCase()).toContain("no other step");
  });
});

// ---------------------------------------------------------------------------
// `if (applying) return;` guard in onReapplyStep (issue #153 review finding
// B3) — the Inspector and its Re-apply button stay mounted and clickable
// while an apply is in flight, so this guard is the only thing preventing a
// SECOND real on-chain broadcast from a second click.
// ---------------------------------------------------------------------------

describe("App — onReapplyStep guard while an apply is already in flight", () => {
  it("clicking Re-apply again while an apply is in flight is a no-op: no second modal, no second POST", async () => {
    // The /api/apply-config fetch NEVER resolves during this test — keeps
    // `applying` true for its whole duration, so we can assert the guard.
    let resolveApply: ((r: Response) => void) | null = null;
    const neverResolvingApply = new Promise<Response>((resolve) => {
      resolveApply = resolve;
    });

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
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
        return neverResolvingApply;
      }
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    });
    vi.stubGlobal("fetch", fetchSpy);

    await setupWithDrift(fetchSpy);
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    // The confirm modal closes immediately (handleApplyConfig closes it
    // synchronously before awaiting the fetch) — this confirms the apply is
    // genuinely in flight (`applying === true`) with the request never
    // resolving.
    await waitFor(() => {
      expect(screen.queryByTestId("apply-config-modal")).toBeNull();
    });
    const applyCallsBefore = fetchSpy.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).startsWith("/api/apply-config"),
    ).length;
    expect(applyCallsBefore).toBe(1);

    // The drift detail panel + its Re-apply button are still mounted (App
    // never unmounts the Inspector while applying) — clicking Re-apply again
    // must be a no-op: the `if (applying) return;` guard in onReapplyStep.
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));

    expect(screen.queryByTestId("apply-config-modal")).toBeNull();
    const applyCallsAfter = fetchSpy.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).startsWith("/api/apply-config"),
    ).length;
    expect(applyCallsAfter).toBe(1);

    // Cleanup: resolve the hung fetch so the test doesn't leave a dangling
    // unhandled promise / act() warning after the test completes.
    resolveApply!(
      new Response(
        `event: done\ndata: ${JSON.stringify({
          success: true,
          executedStepIds: [],
          skippedStepIds: [],
          completedStepIds: [],
          deployment: null,
        })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Non-blocking cleanup item (issue #153 review): nothing previously asserted
// that a NON-forced full "Apply config" run triggers exactly ONE
// /api/verify/config call (i.e. does NOT also run the re-apply drift
// refresh). Removing the `if (forceStepIds !== undefined)` guard at
// App.tsx's handleApplyConfig survived the suite before this test existed.
// ---------------------------------------------------------------------------

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

function addGrantRoleStep(nodeIndex = 0) {
  const configSection = document.querySelectorAll(
    "[data-testid^='node-config-section-']",
  )[nodeIndex] as HTMLElement;
  fireEvent.click(within(configSection).getByText("Add config call"));
  fireEvent.click(within(configSection).getByText("grantRole(bytes32,address)"));
}

describe("App — a full (non-forced) apply does not trigger a second drift refresh", () => {
  it("a full 'Apply config' run POSTs to /api/verify/config exactly ZERO additional times (no re-apply drift refresh)", async () => {
    let verifyConfigCallCount = 0;
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/verify/config") {
        verifyConfigCallCount += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ clean: true, results: [] }), { status: 200 }),
        );
      }
      if (url.startsWith("/api/apply-config")) {
        return Promise.resolve(
          new Response(
            makeStream([
              enc(
                doneOkFrame(
                  ["grant-minter"],
                  [],
                  ["grant-minter"],
                  [{ id: "grant-minter", kind: "grantRole", completed: true }],
                ),
              ),
            ]),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    });
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
    await waitFor(() => {
      expect(screen.queryByTestId("apply-config-success")).not.toBeNull();
    });

    // No /api/verify/config call at all — the re-apply drift refresh only
    // runs when `forceStepIds` was set (a single-step re-apply), never for a
    // full apply.
    expect(verifyConfigCallCount).toBe(0);
  });
});

/**
 * App.applyConfig.test.tsx
 *
 * Integration tests for the "Apply config" button + confirm modal wired into
 * App.tsx (issue #151). Mocks global fetch to return the /api/apply-config SSE
 * stream and asserts:
 *
 * - CONFIRM GATES THE REQUEST: clicking "Apply config" opens the modal and
 *   does NOT POST; Cancel closes it with STILL no POST; only Confirm POSTs.
 * - SUCCESS: after Confirm, the Inspector renders the returned config steps as
 *   completed and a success banner summarizing executed/skipped appears.
 * - FAILURE: a failed step + done{success:false} shows an error banner that
 *   surfaces the failing step's message, without crashing the rest of the UI.
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../src/App.js";

// ---------------------------------------------------------------------------
// SSE helpers
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
  message?: string,
): string {
  const data =
    message !== undefined ? { stepId, kind, status, message } : { stepId, kind, status };
  return `event: step\ndata: ${JSON.stringify(data)}\n\n`;
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

function doneErrorFrame(errors: { message: string; code?: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
}

/**
 * Add a contract node by name through the Contracts Browser (mirrors the
 * helper in App.deploy.test.tsx / App.simulate.test.tsx). Opens the browser
 * if not already open.
 */
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

/**
 * Add a node-level "grantRole" config step through the node's inline config
 * section so `config.steps` is non-empty (issue #151's Apply-config button is
 * enabled only when there is a config step to apply).
 */
function addGrantRoleStep(nodeIndex = 0) {
  const configSection = document.querySelectorAll(
    "[data-testid^='node-config-section-']",
  )[nodeIndex] as HTMLElement;
  fireEvent.click(within(configSection).getByText("Add config call"));
  fireEvent.click(within(configSection).getByText("grantRole(bytes32,address)"));
}

function mockFetchOk(raw: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(makeStream([enc(raw)]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

function mockFetchError(status: number, body: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(body, { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Build a graph with one Registry node + a grantRole config step. */
function setupWithConfigStep() {
  render(<App />);
  addNodeByName("Registry");
  fillArg(0, "0x0000000000000000000000000000000000000001");
  addGrantRoleStep(0);
}

// ---------------------------------------------------------------------------
// Button presence + enablement
// ---------------------------------------------------------------------------

describe("App — Apply config button", () => {
  it("renders the apply-config button next to Verify", () => {
    render(<App />);
    const btn = screen.getByTestId("deploy-apply-config-button");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Apply config");

    const verifyBtn = screen.getByTestId("deploy-verify-button");
    expect(btn.parentElement).toBe(verifyBtn.parentElement);
  });

  it("is disabled when there is no config step to apply", () => {
    render(<App />);
    const btn = screen.getByTestId("deploy-apply-config-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("becomes enabled once a config step exists on the graph", () => {
    render(<App />);
    addNodeByName("Registry");
    fillArg(0, "0x0000000000000000000000000000000000000001");
    addGrantRoleStep(0);

    const btn = screen.getByTestId("deploy-apply-config-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirm gates the request
// ---------------------------------------------------------------------------

describe("App — Apply config confirm gating", () => {
  it("clicking Apply config opens the modal and does NOT POST", async () => {
    const fetchSpy = mockFetchOk(doneOkFrame([], [], [], []));
    vi.stubGlobal("fetch", fetchSpy);

    setupWithConfigStep();
    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));

    expect(screen.queryByTestId("apply-config-modal")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/apply-config", expect.anything());
  });

  it("clicking Cancel closes the modal and STILL does NOT POST", async () => {
    const fetchSpy = mockFetchOk(doneOkFrame([], [], [], []));
    vi.stubGlobal("fetch", fetchSpy);

    setupWithConfigStep();
    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    expect(screen.queryByTestId("apply-config-modal")).not.toBeNull();

    fireEvent.click(screen.getByTestId("apply-config-cancel"));

    expect(screen.queryByTestId("apply-config-modal")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/apply-config", expect.anything());
  });

  it("only clicking Confirm triggers the POST to /api/apply-config", async () => {
    const fetchSpy = mockFetchOk(
      stepFrame("grant-minter", "grantRole", "executing") +
        stepFrame("grant-minter", "grantRole", "completed") +
        doneOkFrame(
          ["grant-minter"],
          [],
          ["grant-minter"],
          [{ id: "grant-minter", kind: "grantRole", completed: true }],
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    setupWithConfigStep();
    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/apply-config", expect.anything());

    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.filter((c: unknown[]) => c[0] === "/api/apply-config"),
      ).toHaveLength(1);
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/apply-config",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("the confirm modal states it broadcasts real transactions", () => {
    vi.stubGlobal("fetch", mockFetchOk(doneOkFrame([], [], [], [])));

    setupWithConfigStep();
    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));

    const modal = screen.getByTestId("apply-config-modal");
    expect(modal.textContent?.toLowerCase()).toContain("real transaction");
    expect(modal.textContent?.toLowerCase()).toContain("irreversible");
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("App — Apply config success path", () => {
  it("renders the returned config steps as completed in the Inspector", async () => {
    const raw =
      stepFrame("grant-minter", "grantRole", "executing") +
      stepFrame("grant-minter", "grantRole", "completed") +
      doneOkFrame(
        ["grant-minter"],
        [],
        ["grant-minter"],
        [{ id: "grant-minter", kind: "grantRole", completed: true, completedAt: "2026-07-21T00:00:00.000Z" }],
      );
    vi.stubGlobal("fetch", mockFetchOk(raw));

    setupWithConfigStep();
    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("config-step-grant-minter-status")).not.toBeNull();
    });

    expect(screen.getByTestId("config-step-grant-minter-status").textContent).toBe("completed");
  });

  it("shows a success banner summarizing executed vs skipped counts", async () => {
    const raw = doneOkFrame(
      ["grant-minter"],
      ["set-fee"],
      ["grant-minter", "set-fee"],
      [
        { id: "grant-minter", kind: "grantRole", completed: true },
        { id: "set-fee", kind: "setX", completed: true },
      ],
    );
    vi.stubGlobal("fetch", mockFetchOk(raw));

    setupWithConfigStep();
    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      const banner = screen.queryByTestId("apply-config-success");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("1 step(s) executed");
      expect(banner!.textContent).toContain("1 already up to date");
    });
  });
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

describe("App — Apply config failure path", () => {
  it("shows an error banner surfacing the failing step's message and does not crash", async () => {
    const raw =
      stepFrame("grant-minter", "grantRole", "executing") +
      stepFrame("grant-minter", "grantRole", "failed", "config step failed") +
      doneErrorFrame([{ message: "config step failed" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    const { container } = render(<App />);
    addNodeByName("Registry");
    fillArg(0, "0x0000000000000000000000000000000000000001");
    addGrantRoleStep(0);

    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("apply-config-error")).not.toBeNull();
    });

    const banner = screen.getByTestId("apply-config-error");
    expect(banner.textContent).toContain("config step failed");
    expect(banner.textContent).toContain("grant-minter");
    // App still mounted, nothing crashed.
    expect(container.firstChild).not.toBeNull();
  });

  it("shows an error banner on a non-200 response and does not crash", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "invalid config format"));

    const { container } = render(<App />);
    addNodeByName("Registry");
    fillArg(0, "0x0000000000000000000000000000000000000001");
    addGrantRoleStep(0);

    fireEvent.click(screen.getByTestId("deploy-apply-config-button"));
    fireEvent.click(screen.getByTestId("apply-config-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("apply-config-error")).not.toBeNull();
    });

    expect(screen.getByTestId("apply-config-error").textContent).toContain("400");
    expect(container.firstChild).not.toBeNull();
  });
});

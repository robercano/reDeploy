/**
 * App.simulate.test.tsx
 *
 * Integration tests for the "Deploy (simulate)" button wired into App.tsx.
 * Mocks global fetch to return SSE streams and asserts:
 * - Button is present with correct testid
 * - Clicking POST /api/simulate with the spec JSON
 * - Successful SSE → mode switches to inspector, contracts visible, address "planned"
 * - Error paths → error banner shown (deploy-simulate-error), no crash
 * - In-flight state: button shows "Simulating…" and is disabled while request in flight
 */

import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
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
  id: string,
  contract: string,
  dependsOn: string[] = [],
  args?: unknown[],
): string {
  const data = { id, contract, dependsOn, address: null, ...(args ? { args } : {}) };
  return `event: step\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneOkFrame(): string {
  return `event: done\ndata: {"success":true}\n\n`;
}

function doneErrorFrame(errors: { message: string; path?: string; code?: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
}

/**
 * Add a contract node by name through the Contracts Browser (mirrors the
 * helper in App.authoring.test.tsx). Opens the browser if not already open.
 */
function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

/**
 * Build a mock fetch that returns a text/event-stream response with the given
 * raw SSE string body.
 */
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

function mockFetchNetworkError(): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(new Error("Failed to fetch"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Button presence
// ---------------------------------------------------------------------------

describe("App — Deploy (simulate) button", () => {
  it("renders the deploy-simulate-button", () => {
    render(<App />);
    const btn = screen.getByTestId("deploy-simulate-button");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Deploy (simulate)");
  });

  it("button is enabled by default", () => {
    render(<App />);
    const btn = screen.getByTestId("deploy-simulate-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Success path: simulate → inspector with live view
// ---------------------------------------------------------------------------

describe("App — simulate success path", () => {
  it("switches to inspector mode on successful simulation", async () => {
    const raw =
      stepFrame("token", "ERC20Token", []) +
      stepFrame("vault", "Vault", ["token"]) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);

    const btn = screen.getByTestId("deploy-simulate-button");
    fireEvent.click(btn);

    // Wait for the async simulate to complete and mode to switch
    await waitFor(() => {
      // In inspector mode the inspector-config-panel should be present
      expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
    });
  });

  it("POSTs to /api/simulate", async () => {
    const mockFetchFn = mockFetchOk(doneOkFrame());
    vi.stubGlobal("fetch", mockFetchFn);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(mockFetchFn).toHaveBeenCalledWith(
        "/api/simulate",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
  });

  it("renders planned contracts (address null) in inspector after success", async () => {
    const raw =
      stepFrame("token", "ERC20Token", []) +
      stepFrame("vault", "Vault", ["token"]) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      // Inspector nodes for token and vault should appear
      expect(screen.queryByTestId("inspector-node-token")).not.toBeNull();
      expect(screen.queryByTestId("inspector-node-vault")).not.toBeNull();
    });
  });

  it("renders address:null contracts as '(not deployed)' in inspector", async () => {
    const raw =
      stepFrame("token", "ERC20Token", []) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const addressEl = screen.queryByTestId("inspector-node-token-address");
      expect(addressEl).not.toBeNull();
      // address: null → Inspector renders as "(not deployed)" (planned state)
      expect(addressEl!.textContent).toContain("not deployed");
    });
  });

  it("does not show the error banner on success", async () => {
    const raw = doneOkFrame();
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
    });

    expect(screen.queryByTestId("deploy-simulate-error")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error path: done{success:false}
// ---------------------------------------------------------------------------

describe("App — simulate error: done{success:false}", () => {
  it("shows error banner and does NOT switch to inspector", async () => {
    const raw =
      stepFrame("a", "A", []) +
      doneErrorFrame([{ message: "contract A reverted" }]);

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    // Should still be in authoring mode (inspector-config-panel absent)
    expect(screen.queryByTestId("inspector-config-panel")).toBeNull();
  });

  it("error banner contains the error message", async () => {
    const raw = doneErrorFrame([{ message: "out of gas" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-simulate-error");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("out of gas");
    });
  });

  it("does not crash — App still renders after done{success:false}", async () => {
    const raw = doneErrorFrame([{ message: "some error" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    const { container } = render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    // App container still mounted
    expect(container.firstChild).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error path: non-200 response (400/413)
// ---------------------------------------------------------------------------

describe("App — simulate error: non-200 response", () => {
  it("shows error banner on 400 response", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "invalid spec"));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    const banner = screen.getByTestId("deploy-simulate-error");
    expect(banner.textContent).toContain("400");
  });

  it("shows error banner on 413 response", async () => {
    vi.stubGlobal("fetch", mockFetchError(413, "body too large"));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-simulate-error");
      expect(banner).not.toBeNull();
    });
  });

  it("does NOT switch to inspector on 400", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "bad input"));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    expect(screen.queryByTestId("inspector-config-panel")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error path: network error (fetch rejection)
// ---------------------------------------------------------------------------

describe("App — simulate error: network error", () => {
  it("shows error banner on fetch rejection", async () => {
    vi.stubGlobal("fetch", mockFetchNetworkError());

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    const banner = screen.getByTestId("deploy-simulate-error");
    expect(banner.textContent).toContain("Failed to fetch");
  });

  it("does not crash on network error", async () => {
    vi.stubGlobal("fetch", mockFetchNetworkError());

    const { container } = render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    expect(container.firstChild).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// In-flight state
// ---------------------------------------------------------------------------

describe("App — in-flight simulating state", () => {
  it("disables the button and shows 'Simulating…' while in flight", async () => {
    // Use a never-resolving promise to keep the simulate in-flight
    let resolveSimulate!: (v: Response) => void;
    const pendingPromise = new Promise<Response>((resolve) => {
      resolveSimulate = resolve;
    });

    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingPromise));

    render(<App />);
    const btn = screen.getByTestId("deploy-simulate-button") as HTMLButtonElement;

    fireEvent.click(btn);

    // Button should be disabled and show "Simulating…"
    await waitFor(() => {
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Simulating…");
    });

    // Resolve to clean up
    act(() => {
      resolveSimulate(new Response("err", { status: 500 }));
    });
  });

  it("re-enables the button after simulation completes", async () => {
    vi.stubGlobal("fetch", mockFetchOk(doneOkFrame()));

    render(<App />);
    const btn = screen.getByTestId("deploy-simulate-button") as HTMLButtonElement;
    fireEvent.click(btn);

    // Wait for completion
    await waitFor(() => {
      // Mode switches to inspector on success
      expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
    });

    // Button should be re-enabled (present in DOM)
    expect(btn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Success banner (deploy-simulate-success)
// ---------------------------------------------------------------------------

describe("App — simulate success banner", () => {
  it("shows the success banner after a successful simulation", async () => {
    const raw =
      stepFrame("token", "ERC20Token", []) +
      stepFrame("vault", "Vault", ["token"]) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-success")).not.toBeNull();
    });
  });

  it("success banner contains the correct planned step count (2 contracts)", async () => {
    // The fixture sends 2 step frames → view.contracts.length === 2
    const raw =
      stepFrame("token", "ERC20Token", []) +
      stepFrame("vault", "Vault", ["token"]) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-simulate-success");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("2 planned step(s)");
    });
  });

  it("success banner contains the dry-run message", async () => {
    const raw = stepFrame("token", "ERC20Token", []) + doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-simulate-success");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("No contracts deployed (dry run)");
    });
  });

  it("success banner shows 1 planned step(s) for a single-contract simulation", async () => {
    const raw = stepFrame("token", "ERC20Token", []) + doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-simulate-success");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("1 planned step(s)");
    });
  });

  it("success banner shows 0 planned step(s) when done arrives with no step frames", async () => {
    // Only a done frame, no step frames → contracts.length === 0
    const raw = doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-simulate-success");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("0 planned step(s)");
    });
  });

  it("error path shows deploy-simulate-error and NOT deploy-simulate-success", async () => {
    const raw = doneErrorFrame([{ message: "contract A reverted" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    expect(screen.queryByTestId("deploy-simulate-success")).toBeNull();
  });

  it("starting a new run clears a prior success banner", async () => {
    // First run succeeds
    const raw1 = stepFrame("token", "ERC20Token", []) + doneOkFrame();
    vi.stubGlobal("fetch", mockFetchOk(raw1));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-success")).not.toBeNull();
    });

    // Second run: network error — success banner must disappear immediately on click
    vi.stubGlobal("fetch", mockFetchNetworkError());
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    // After the error resolves the success banner should be gone and error shown
    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    expect(screen.queryByTestId("deploy-simulate-success")).toBeNull();
  });

  it("auto-dismisses the success banner after 5 seconds", async () => {
    // Use fake timers so we can advance past the 5s auto-dismiss synchronously.
    // We only fake setTimeout/setInterval (not Date or microtask queue) so the
    // Promise-based fetch chain still resolves via normal microtask processing.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const raw = stepFrame("token", "ERC20Token", []) + doneOkFrame();
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    // Flush all microtasks/promises so the async handleSimulate completes and
    // sets the success state (this works because Promise resolution goes through
    // the microtask queue, not through fake timers).
    await act(async () => {
      // Repeatedly yield until the success banner appears or we time out.
      // We use a loop of Promise.resolve() flushes to drain the async chain.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
    });

    // The success banner should be visible now.
    expect(screen.queryByTestId("deploy-simulate-success")).not.toBeNull();

    // Advance fake timers past the 5-second auto-dismiss.
    act(() => {
      vi.advanceTimersByTime(5001);
    });

    expect(screen.queryByTestId("deploy-simulate-success")).toBeNull();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Inspector dry-run context badge (inspector-context-badge)
// ---------------------------------------------------------------------------

describe("App — inspector dry-run context badge", () => {
  it("shows the inspector-context-badge after a successful simulate", async () => {
    const raw =
      stepFrame("token", "ERC20Token", []) +
      stepFrame("vault", "Vault", ["token"]) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-context-badge")).not.toBeNull();
    });
  });

  it("inspector-context-badge contains 'dry run' text", async () => {
    const raw =
      stepFrame("token", "ERC20Token", []) +
      doneOkFrame();

    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const badge = screen.queryByTestId("inspector-context-badge");
      expect(badge).not.toBeNull();
      expect(badge!.textContent?.toLowerCase()).toContain("dry run");
    });
  });

  it("inspector-context-badge is absent when viewing sample (no live simulate)", () => {
    render(<App />);

    // Switch to inspector mode manually (no simulate run) — shows SAMPLE view
    fireEvent.click(screen.getByTestId("mode-inspector"));

    // Badge should NOT be present (sample view has no contextLabel)
    expect(screen.queryByTestId("inspector-context-badge")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Field/node-level error highlighting (issue #83)
//
// Fallback chain: (1) field-level (deploy-id or a constructor arg input) is
// preferred; (2) node-level (red node border) when the error only maps to
// the contract entry as a whole; (3) message-only banner when the error's
// path is absent/unmappable. Applies to the simulate flow here (see
// App.deploy.test.tsx for the equivalent real-deploy coverage).
// ---------------------------------------------------------------------------

describe("App — simulate error field/node highlighting (issue #83)", () => {
  it("a contracts[0].id error marks the deploy-id input invalid (field-level)", async () => {
    render(<App />);
    addNodeByName("Token");

    const raw = doneErrorFrame([
      { path: "contracts[0].id", message: "contract entry id must be a non-empty string" },
    ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
      expect(deployIdInput.getAttribute("aria-invalid")).toBe("true");
    });

    const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
    const fieldMsg = within(nodeEl).getByText("contract entry id must be a non-empty string");
    expect(fieldMsg).not.toBeNull();

    // The banner fallback is still shown alongside the highlight.
    expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
  });

  it("an arg error marks the correct arg input (field-level), not the other arg", async () => {
    render(<App />);
    addNodeByName("Token"); // Token has 2 constructor args: name_ (0), symbol_ (1)

    const raw = doneErrorFrame([
      { path: "contracts[0].args[1]", message: "symbol_ must not be empty" },
    ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const arg1 = screen.getByLabelText("arg-1") as HTMLInputElement;
      expect(arg1.getAttribute("aria-invalid")).toBe("true");
    });

    const arg0 = screen.getByLabelText("arg-0") as HTMLInputElement;
    expect(arg0.getAttribute("aria-invalid")).toBeNull();

    // deploy-id must NOT be highlighted — the error only maps to arg[1].
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("a node-only-mappable error (bare contracts[i]) red-borders the node (node-level fallback)", async () => {
    render(<App />);
    addNodeByName("Registry");

    const raw = doneErrorFrame([
      { path: "contracts[0]", message: "duplicate deploy id across contracts" },
    ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
      expect(nodeEl.getAttribute("data-node-invalid")).toBe("true");
    });

    const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
    // jsdom normalizes the inline hex color (#d93025) to rgb(217, 48, 37).
    expect(nodeEl.style.border).toContain("rgb(217, 48, 37)");

    // No specific field is highlighted — only the node-level fallback applies.
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("an after[] error (no more specific field) also falls back to node-level highlighting", async () => {
    render(<App />);
    addNodeByName("Registry");

    const raw = doneErrorFrame([
      { path: "contracts[0].after[0]", message: "after references an unknown contract id" },
    ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
      expect(nodeEl.getAttribute("data-node-invalid")).toBe("true");
    });
  });

  it("an unmappable error (no path) shows only the banner — no field/node highlight", async () => {
    render(<App />);
    addNodeByName("Token");

    const raw = doneErrorFrame([{ message: "unexpected server error" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
    expect(nodeEl.getAttribute("data-node-invalid")).toBeNull();
    expect(nodeEl.style.border).not.toContain("rgb(217, 48, 37)");

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("starting a new simulate run clears a prior field highlight immediately", async () => {
    render(<App />);
    addNodeByName("Token");

    const rawErr = doneErrorFrame([{ path: "contracts[0].id", message: "id required" }]);
    vi.stubGlobal("fetch", mockFetchOk(rawErr));
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("deploy-id") as HTMLInputElement).getAttribute("aria-invalid"),
      ).toBe("true");
    });

    // Second run: use a never-resolving fetch so we can inspect the state
    // synchronously right after the click, before any response arrives.
    let resolveSecond!: (v: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();

    // Clean up the pending promise so the test doesn't leak an unresolved request.
    act(() => {
      resolveSecond(new Response("err", { status: 500 }));
    });
  });

  it("a successful simulate run leaves no stale field highlight for a subsequent failed run", async () => {
    render(<App />);
    addNodeByName("Token");

    // First run succeeds.
    vi.stubGlobal("fetch", mockFetchOk(doneOkFrame()));
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
    });

    // Go back to authoring to re-inspect the node.
    fireEvent.click(screen.getByTestId("mode-authoring"));
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });
});

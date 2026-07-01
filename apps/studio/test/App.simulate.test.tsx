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

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

function doneErrorFrame(errors: { message: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
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

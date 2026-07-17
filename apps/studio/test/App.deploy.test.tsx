/**
 * App.deploy.test.tsx
 *
 * Integration tests for the "Deploy (real)" button + confirm modal wired into
 * App.tsx. Mocks global fetch to return the /api/deploy SSE stream and asserts:
 *
 * - CONFIRM GATES THE REQUEST: clicking "Deploy (real)" opens the modal and
 *   does NOT POST; Cancel closes it with STILL no POST; only Confirm POSTs.
 * - SUCCESS: after Confirm, Inspector renders deployed contracts WITH real
 *   addresses and the real-deployment context badge (distinct from simulate).
 * - ERROR: non-200 / network reject after Confirm → error banner, no crash.
 */

import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
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

function progressFrame(): string {
  return `event: progress\ndata: {"phase":"deploying"}\n\n`;
}

interface DeployedContract {
  id: string;
  contractName: string;
  address: string | null;
  args?: unknown[];
  dependsOn?: string[];
}

function doneDeployedFrame(contracts: DeployedContract[]): string {
  const deployment = {
    contracts: contracts.map((c) => ({
      id: c.id,
      contractName: c.contractName,
      address: c.address,
      args: c.args ?? [],
      links: { dependencies: c.dependsOn ?? [], libraries: {} },
    })),
    configSteps: [],
    warnings: [],
  };
  return `event: done\ndata: ${JSON.stringify({ success: true, deployment })}\n\n`;
}

function doneErrorFrame(errors: { message: string; path?: string; code?: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
}

/**
 * Add a contract node by name through the Contracts Browser (mirrors the
 * helper in App.authoring.test.tsx / App.simulate.test.tsx). Opens the
 * browser if not already open.
 */
function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

/**
 * Fill a constructor arg input (aria-label "arg-<index>") with a value.
 * Used to satisfy the studio-side empty-constructor-arg pre-validation
 * (issue #83) in tests that exercise SERVER-reported errors unrelated to
 * arg emptiness — those must not be short-circuited by local validation.
 */
function fillArg(index: number, value: string) {
  fireEvent.change(screen.getByLabelText(`arg-${index}`), { target: { value } });
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

function mockFetchNetworkError(): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(new Error("Failed to fetch"));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Button presence
// ---------------------------------------------------------------------------

describe("App — Deploy (real) button", () => {
  it("renders the deploy-real-button distinct from the simulate button", () => {
    render(<App />);
    const btn = screen.getByTestId("deploy-real-button");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Deploy (real)");

    const simulateBtn = screen.getByTestId("deploy-simulate-button");
    // Both live in the SAME (top:12) toolbar row.
    expect(btn.parentElement).toBe(simulateBtn.parentElement);
    expect((btn.parentElement as HTMLElement).style.top).toBe("12px");
  });
});

// ---------------------------------------------------------------------------
// Confirm gates the request
// ---------------------------------------------------------------------------

describe("App — Deploy (real) confirm gating", () => {
  it("clicking Deploy (real) opens the modal and does NOT POST", async () => {
    const fetchSpy = mockFetchOk(progressFrame() + doneDeployedFrame([]));
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));

    // Modal appears
    expect(screen.queryByTestId("deploy-real-modal")).not.toBeNull();
    // No POST yet. (fetchSpy may still have recorded the studio's own
    // mount-time GET /api/networks call for the toolbar's network selector —
    // issue #139 — so we assert /api/deploy specifically was never called.)
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/deploy", expect.anything());
  });

  it("clicking Cancel closes the modal and STILL does NOT POST", async () => {
    const fetchSpy = mockFetchOk(progressFrame() + doneDeployedFrame([]));
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    expect(screen.queryByTestId("deploy-real-modal")).not.toBeNull();

    fireEvent.click(screen.getByTestId("deploy-real-cancel"));

    // Modal gone, no fetch to /api/deploy specifically (see comment above).
    expect(screen.queryByTestId("deploy-real-modal")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/deploy", expect.anything());
  });

  it("only clicking Confirm triggers the POST to /api/deploy", async () => {
    const fetchSpy = mockFetchOk(
      progressFrame() +
        doneDeployedFrame([
          { id: "token", contractName: "ERC20Token", address: "0xTOKENADDR" },
        ]),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/deploy", expect.anything());

    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      // Exactly one call to /api/deploy specifically — fetchSpy's total call
      // count may also include the studio's own mount-time GET /api/networks
      // call (issue #139, network selector).
      expect(fetchSpy.mock.calls.filter((c: unknown[]) => c[0] === "/api/deploy")).toHaveLength(1);
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/deploy",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("the confirm modal states it broadcasts real transactions and shows a target", () => {
    vi.stubGlobal("fetch", mockFetchOk(progressFrame() + doneDeployedFrame([])));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));

    const modal = screen.getByTestId("deploy-real-modal");
    expect(modal.textContent?.toLowerCase()).toContain("real transaction");
    expect(modal.textContent?.toLowerCase()).toContain("irreversible");
    // A truthful target descriptor is present
    expect(screen.getByTestId("deploy-real-target")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("App — Deploy (real) success path", () => {
  it("renders deployed contracts WITH real addresses in the Inspector after Confirm", async () => {
    const raw =
      progressFrame() +
      doneDeployedFrame([
        { id: "token", contractName: "ERC20Token", address: "0xTOKENADDR0001" },
        { id: "vault", contractName: "Vault", address: "0xVAULTADDR0002", dependsOn: ["token"] },
      ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-node-token-address")).not.toBeNull();
    });

    const addressEl = screen.getByTestId("inspector-node-token-address");
    // Real address rendered — NOT the planned "(not deployed)" placeholder
    expect(addressEl.textContent).toContain("0xTOKENADDR0001");
    expect(addressEl.textContent).not.toContain("not deployed");
  });

  it("shows the real-deployment context badge (distinct from the simulate label)", async () => {
    const raw =
      progressFrame() +
      doneDeployedFrame([
        { id: "token", contractName: "ERC20Token", address: "0xTOKENADDR0001" },
      ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-context-badge")).not.toBeNull();
    });

    const badge = screen.getByTestId("inspector-context-badge");
    const text = badge.textContent?.toLowerCase() ?? "";
    // Real-deployment label, and explicitly NOT the dry-run label
    expect(text).toContain("real deployment");
    expect(text).not.toContain("dry run");
  });

  it("shows the deploy-real-success banner after a successful deploy", async () => {
    const raw =
      progressFrame() +
      doneDeployedFrame([
        { id: "token", contractName: "ERC20Token", address: "0xTOKENADDR0001" },
      ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-real-success");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("1 contract(s) deployed");
    });
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("App — Deploy (real) error paths", () => {
  it("shows the deploy-real-error banner on a non-200 response and does not crash", async () => {
    vi.stubGlobal("fetch", mockFetchError(400, "invalid spec"));

    const { container } = render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-real-error")).not.toBeNull();
    });

    const banner = screen.getByTestId("deploy-real-error");
    expect(banner.textContent).toContain("400");
    // App still mounted
    expect(container.firstChild).not.toBeNull();
  });

  it("shows the deploy-real-error banner on a network reject and does not crash", async () => {
    vi.stubGlobal("fetch", mockFetchNetworkError());

    const { container } = render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-real-error")).not.toBeNull();
    });

    expect(screen.getByTestId("deploy-real-error").textContent).toContain("Failed to fetch");
    expect(container.firstChild).not.toBeNull();
  });

  it("shows the deploy-real-error banner on done{success:false}", async () => {
    const raw = progressFrame() + doneErrorFrame([{ message: "Deployment failed on-chain" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const banner = screen.queryByTestId("deploy-real-error");
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain("Deployment failed on-chain");
    });
  });
});

// ---------------------------------------------------------------------------
// Field/node-level error highlighting (issue #83) — real-deploy flow
//
// Same fallback chain as the simulate flow (see App.simulate.test.tsx):
// (1) field-level (deploy-id / arg input), (2) node-level (red node border),
// (3) message-only banner. Verified here specifically for Deploy (real) since
// it goes through a separate confirm-modal-gated handler (handleDeploy).
// ---------------------------------------------------------------------------

describe("App — Deploy (real) error field/node highlighting (issue #83)", () => {
  it("a contracts[0].id error marks the deploy-id input invalid (field-level)", async () => {
    render(<App />);
    addNodeByName("Token");
    fillArg(0, "MyToken");
    fillArg(1, "MTK");

    const raw =
      progressFrame() +
      doneErrorFrame([
        { path: "contracts[0].id", message: "contract entry id must be a non-empty string" },
      ]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
      expect(deployIdInput.getAttribute("aria-invalid")).toBe("true");
    });

    expect(screen.queryByTestId("deploy-real-error")).not.toBeNull();
  });

  it("an arg error marks the correct arg input (field-level), not the other arg", async () => {
    render(<App />);
    addNodeByName("Token"); // Token has 2 constructor args: name_ (0), symbol_ (1)
    // Both args filled — the error asserted below is a SERVER-reported one,
    // independent of the local empty-arg pre-validation (issue #83 follow-up).
    fillArg(0, "MyToken");
    fillArg(1, "MTK");

    const raw =
      progressFrame() +
      doneErrorFrame([{ path: "contracts[0].args[0]", message: "name_ must not be empty" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const arg0 = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(arg0.getAttribute("aria-invalid")).toBe("true");
    });

    const arg1 = screen.getByLabelText("arg-1") as HTMLInputElement;
    expect(arg1.getAttribute("aria-invalid")).toBeNull();
  });

  it("a node-only-mappable error (bare contracts[i]) red-borders the node (node-level fallback)", async () => {
    render(<App />);
    addNodeByName("Registry");
    fillArg(0, "0x0000000000000000000000000000000000000001");

    const raw =
      progressFrame() +
      doneErrorFrame([{ path: "contracts[0]", message: "duplicate deploy id across contracts" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
      expect(nodeEl.getAttribute("data-node-invalid")).toBe("true");
    });

    const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
    // Error border is the shared "danger" design token (issue #94).
    expect(nodeEl.style.border).toContain("var(--color-danger)");

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("an unmappable error (no path) shows only the banner — no field/node highlight", async () => {
    render(<App />);
    addNodeByName("Token");
    fillArg(0, "MyToken");
    fillArg(1, "MTK");

    const raw = progressFrame() + doneErrorFrame([{ message: "Deployment failed on-chain" }]);
    vi.stubGlobal("fetch", mockFetchOk(raw));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-real-error")).not.toBeNull();
    });

    const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
    expect(nodeEl.getAttribute("data-node-invalid")).toBeNull();

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("starting a new real-deploy run clears a prior field highlight immediately", async () => {
    render(<App />);
    addNodeByName("Token");
    fillArg(0, "MyToken");
    fillArg(1, "MTK");

    const rawErr =
      progressFrame() + doneErrorFrame([{ path: "contracts[0].id", message: "id required" }]);
    vi.stubGlobal("fetch", mockFetchOk(rawErr));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("deploy-id") as HTMLInputElement).getAttribute("aria-invalid"),
      ).toBe("true");
    });

    // Second run: use a never-resolving fetch so we can inspect the state
    // synchronously right after Confirm, before any response arrives.
    let resolveSecond!: (v: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    expect(deployIdInput.getAttribute("aria-invalid")).toBeNull();

    // Clean up the pending promise so the test doesn't leak an unresolved request.
    act(() => {
      resolveSecond(new Response("err", { status: 500 }));
    });
  });
});

// ---------------------------------------------------------------------------
// Studio-side empty-constructor-arg pre-validation (issue #83 follow-up) —
// real-deploy flow. Same requirement as the simulate flow (see
// App.simulate.test.tsx): an empty/blank literal constructor arg must block
// Deploy (real) locally, with no /api/deploy round-trip, and highlight the
// offending input(s).
// ---------------------------------------------------------------------------

describe("App — Deploy (real) local pre-validation: empty constructor args (issue #83)", () => {
  it("an empty constructor arg blocks Deploy (real) locally (no fetch call) and highlights that arg", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    addNodeByName("Token"); // args default to "" — neither filled here.

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const arg0 = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(arg0.getAttribute("aria-invalid")).toBe("true");
    });

    // Short-circuited locally: the server was never contacted for the
    // deploy request. (fetchSpy may still have recorded the studio's own
    // mount-time GET /api/networks call for the toolbar's network selector —
    // issue #139 — so we assert /api/deploy specifically was never called.)
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/deploy", expect.anything());

    const banner = screen.getByTestId("deploy-real-error");
    expect(banner.textContent).toContain("constructor argument must have a value");
  });

  it("a whitespace-only constructor arg is also treated as empty and blocks Deploy (real)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    addNodeByName("Token");
    fillArg(0, "   ");
    fillArg(1, "MTK");

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const arg0 = screen.getByLabelText("arg-0") as HTMLInputElement;
      expect(arg0.getAttribute("aria-invalid")).toBe("true");
    });

    const arg1 = screen.getByLabelText("arg-1") as HTMLInputElement;
    expect(arg1.getAttribute("aria-invalid")).toBeNull();
    // See the matching comment above — only /api/deploy specifically must
    // never be called.
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/deploy", expect.anything());
  });

  it("filled constructor args do not block Deploy (real) — request proceeds to the server", async () => {
    const raw = progressFrame() + doneDeployedFrame([{ id: "token", contractName: "ERC20Token", address: "0xTOKEN" }]);
    const fetchSpy = mockFetchOk(raw);
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    addNodeByName("Token");
    fillArg(0, "MyToken");
    fillArg(1, "MTK");

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      // Exactly one call to /api/deploy specifically — fetchSpy's total call
      // count may also include the studio's own mount-time GET /api/networks
      // call (issue #139, network selector).
      expect(fetchSpy.mock.calls.filter((c: unknown[]) => c[0] === "/api/deploy")).toHaveLength(1);
    });

    // Success switches to inspector mode — go back to authoring to
    // re-inspect the (unhighlighted) arg inputs.
    await waitFor(() => {
      expect(screen.queryByTestId("inspector-node-token-address")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("mode-authoring"));

    const arg0 = screen.getByLabelText("arg-0") as HTMLInputElement;
    const arg1 = screen.getByLabelText("arg-1") as HTMLInputElement;
    expect(arg0.getAttribute("aria-invalid")).toBeNull();
    expect(arg1.getAttribute("aria-invalid")).toBeNull();
  });

  it("multiple empty args across multiple nodes are each highlighted red", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    addNodeByName("Token"); // 2 args, both left blank
    addNodeByName("Registry"); // 1 arg, left blank

    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      const nodeEls = document.querySelectorAll('[data-testid^="contract-node-"]');
      const tokenArg0 = within(nodeEls[0] as HTMLElement).getByLabelText(
        "arg-0",
      ) as HTMLInputElement;
      expect(tokenArg0.getAttribute("aria-invalid")).toBe("true");
    });

    const nodeEls = document.querySelectorAll('[data-testid^="contract-node-"]');
    const tokenArg1 = within(nodeEls[0] as HTMLElement).getByLabelText(
      "arg-1",
    ) as HTMLInputElement;
    const registryArg0 = within(nodeEls[1] as HTMLElement).getByLabelText(
      "arg-0",
    ) as HTMLInputElement;
    expect(tokenArg1.getAttribute("aria-invalid")).toBe("true");
    expect(registryArg0.getAttribute("aria-invalid")).toBe("true");

    // See the matching comment above — only /api/deploy specifically must
    // never be called.
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/deploy", expect.anything());
  });
});

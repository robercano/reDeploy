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

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

function doneErrorFrame(errors: { message: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
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
    // No POST yet
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clicking Cancel closes the modal and STILL does NOT POST", async () => {
    const fetchSpy = mockFetchOk(progressFrame() + doneDeployedFrame([]));
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    expect(screen.queryByTestId("deploy-real-modal")).not.toBeNull();

    fireEvent.click(screen.getByTestId("deploy-real-cancel"));

    // Modal gone, no fetch
    expect(screen.queryByTestId("deploy-real-modal")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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

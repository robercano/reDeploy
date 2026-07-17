/**
 * App.network-selector.test.tsx
 *
 * Integration tests for the toolbar network selector wired into App.tsx
 * (issue #139).
 *
 * Covers:
 * - The selector fetches GET /api/networks on mount and lists the returned
 *   networks as <option>s.
 * - Graceful fallback to a single "default" option when the fetch fails, is
 *   unreachable (404 — pre-#139 deploy-server), or returns something
 *   malformed — the studio must never crash.
 * - Selecting a network threads `?network=<name>` into both
 *   POST /api/simulate and POST /api/deploy.
 * - Omitting a selection (staying on "Default") sends NO `?network=` query
 *   param at all — exact pre-#139 request shape.
 * - The real-deploy confirmation modal displays the currently-selected
 *   network so the user can see what they're about to broadcast to.
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

function doneOkSimulateFrame(): string {
  return `event: done\ndata: {"success":true}\n\n`;
}

function doneOkDeployFrame(): string {
  return `event: done\ndata: ${JSON.stringify({ success: true, deployment: { contracts: [], configSteps: [], warnings: [] } })}\n\n`;
}

function progressFrame(): string {
  return `event: progress\ndata: {"phase":"deploying"}\n\n`;
}

// ---------------------------------------------------------------------------
// Fetch dispatch helper — routes by URL (including the query string), so
// GET /api/networks can be distinguished from POST /api/simulate and
// POST /api/deploy in a single mock.
// ---------------------------------------------------------------------------

interface NetworksRoute {
  status: number;
  body?: unknown;
  contentType?: string;
}

function mockDispatchFetch(networksRoute: NetworksRoute | "reject"): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/networks")) {
      if (networksRoute === "reject") {
        return Promise.reject(new Error("Failed to fetch"));
      }
      const headers: Record<string, string> =
        networksRoute.contentType !== undefined ? { "Content-Type": networksRoute.contentType } : {};
      return Promise.resolve(
        new Response(networksRoute.body !== undefined ? JSON.stringify(networksRoute.body) : "", {
          status: networksRoute.status,
          headers,
        }),
      );
    }
    if (url.startsWith("/api/simulate")) {
      return Promise.resolve(
        new Response(makeStream([enc(doneOkSimulateFrame())]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    if (url.startsWith("/api/deploy")) {
      return Promise.resolve(
        new Response(makeStream([enc(progressFrame() + doneOkDeployFrame())]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch to ${url} (init: ${JSON.stringify(init)})`));
  });
}

const OK_NETWORKS_ROUTE: NetworksRoute = {
  status: 200,
  contentType: "application/json",
  body: {
    networks: [{ name: "default" }, { name: "sepolia", chainId: 11155111 }, { name: "mainnet" }],
    defaultNetwork: "default",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Selector renders + lists fetched networks
// ---------------------------------------------------------------------------

describe("App — network selector renders fetched networks", () => {
  it("renders the deploy-network-select control", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch(OK_NETWORKS_ROUTE));

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-network-select")).not.toBeNull();
    });
  });

  it("lists every network returned by GET /api/networks as an <option>", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch(OK_NETWORKS_ROUTE));

    render(<App />);

    const select = (await screen.findByTestId("deploy-network-select")) as HTMLSelectElement;

    await waitFor(() => {
      const optionValues = Array.from(select.options).map((o) => o.value);
      expect(optionValues).toContain("sepolia");
      expect(optionValues).toContain("mainnet");
    });
  });

  it("shows the chainId alongside a network's name when provided", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch(OK_NETWORKS_ROUTE));

    render(<App />);

    const select = (await screen.findByTestId("deploy-network-select")) as HTMLSelectElement;

    await waitFor(() => {
      const sepoliaOption = within(select).getByText(/sepolia/);
      expect(sepoliaOption.textContent).toContain("11155111");
    });
  });

  it("the default option reflects the server's declared defaultNetwork", async () => {
    vi.stubGlobal(
      "fetch",
      mockDispatchFetch({
        status: 200,
        contentType: "application/json",
        body: { networks: [{ name: "custom-default" }], defaultNetwork: "custom-default" },
      }),
    );

    render(<App />);

    const select = (await screen.findByTestId("deploy-network-select")) as HTMLSelectElement;

    await waitFor(() => {
      expect(select.options[0].textContent).toContain("custom-default");
    });
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback
// ---------------------------------------------------------------------------

describe("App — network selector graceful fallback", () => {
  it("falls back to a single default option when the networks fetch rejects (network error)", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch("reject"));

    const { container } = render(<App />);

    const select = (await screen.findByTestId("deploy-network-select")) as HTMLSelectElement;

    // Studio does not crash — the toolbar and the rest of the app render.
    expect(container.firstChild).not.toBeNull();
    expect(screen.queryByTestId("deploy-simulate-button")).not.toBeNull();

    // At least the "Default" placeholder option is present, and selecting it
    // is a no-op (no crash) even though no server-fetched networks exist.
    expect(select.options.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back gracefully when GET /api/networks 404s (pre-#139 deploy-server)", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch({ status: 404 }));

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-network-select")).not.toBeNull();
    });
    expect(container.firstChild).not.toBeNull();
  });

  it("falls back gracefully when GET /api/networks returns malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      mockDispatchFetch({ status: 200, contentType: "application/json", body: { unexpected: "shape" } }),
    );

    const { container } = render(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-network-select")).not.toBeNull();
    });
    expect(container.firstChild).not.toBeNull();
  });

  it("Deploy (simulate) still works after a networks-fetch failure (no ?network= sent)", async () => {
    const fetchSpy = mockDispatchFetch("reject");
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    await screen.findByTestId("deploy-network-select");

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/simulate", expect.anything());
    });
  });
});

// ---------------------------------------------------------------------------
// Selecting a network threads ?network= into simulate/deploy
// ---------------------------------------------------------------------------

describe("App — selecting a network threads ?network= into requests", () => {
  it("no selection (default) → Deploy (simulate) POSTs to /api/simulate with NO query string", async () => {
    const fetchSpy = mockDispatchFetch(OK_NETWORKS_ROUTE);
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    await screen.findByTestId("deploy-network-select");

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/simulate", expect.anything());
    });
  });

  it("selecting 'sepolia' → Deploy (simulate) POSTs to /api/simulate?network=sepolia", async () => {
    const fetchSpy = mockDispatchFetch(OK_NETWORKS_ROUTE);
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    const select = await screen.findByTestId("deploy-network-select");
    await waitFor(() => {
      expect((select as HTMLSelectElement).options.length).toBeGreaterThan(1);
    });

    fireEvent.change(select, { target: { value: "sepolia" } });
    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/simulate?network=sepolia", expect.anything());
    });
  });

  it("selecting 'mainnet' → Deploy (real) confirm POSTs to /api/deploy?network=mainnet", async () => {
    const fetchSpy = mockDispatchFetch(OK_NETWORKS_ROUTE);
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    const select = await screen.findByTestId("deploy-network-select");
    await waitFor(() => {
      expect((select as HTMLSelectElement).options.length).toBeGreaterThan(1);
    });

    fireEvent.change(select, { target: { value: "mainnet" } });
    fireEvent.click(screen.getByTestId("deploy-real-button"));
    fireEvent.click(screen.getByTestId("deploy-real-confirm"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/deploy?network=mainnet", expect.anything());
    });
  });

  it("switching back to 'Default' after selecting a network removes the ?network= param again", async () => {
    const fetchSpy = mockDispatchFetch(OK_NETWORKS_ROUTE);
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    const select = (await screen.findByTestId("deploy-network-select")) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(1);
    });

    fireEvent.change(select, { target: { value: "sepolia" } });
    fireEvent.change(select, { target: { value: "" } });

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/simulate", expect.anything());
    });
    expect(fetchSpy).not.toHaveBeenCalledWith("/api/simulate?network=sepolia", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Confirm modal shows the selected network
// ---------------------------------------------------------------------------

describe("App — Deploy (real) confirm modal shows the selected network", () => {
  it("shows 'Default (default)' when no network is selected", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch(OK_NETWORKS_ROUTE));

    render(<App />);
    await screen.findByTestId("deploy-network-select");

    fireEvent.click(screen.getByTestId("deploy-real-button"));

    const networkEl = await screen.findByTestId("deploy-real-network");
    expect(networkEl.textContent).toContain("Default");
    expect(networkEl.textContent).toContain("default");
  });

  it("shows the selected network name once one is chosen", async () => {
    vi.stubGlobal("fetch", mockDispatchFetch(OK_NETWORKS_ROUTE));

    render(<App />);
    const select = (await screen.findByTestId("deploy-network-select")) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThan(1);
    });

    fireEvent.change(select, { target: { value: "sepolia" } });
    fireEvent.click(screen.getByTestId("deploy-real-button"));

    const networkEl = await screen.findByTestId("deploy-real-network");
    expect(networkEl.textContent).toBe("sepolia");
  });
});

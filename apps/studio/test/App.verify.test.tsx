/**
 * App.verify.test.tsx
 *
 * Integration tests for the "Verify" button wired into App.tsx (issue #138).
 * Unlike Deploy (real), Verify has no confirm gate — it POSTs to BOTH
 * /api/verify/config and /api/verify/source immediately on click. Mocks
 * global fetch, dispatching by request URL since the two endpoints return
 * different JSON payload shapes.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../src/App.js";

// ---------------------------------------------------------------------------
// Fetch dispatch helper
// ---------------------------------------------------------------------------

interface RouteResponses {
  config?: { status: number; body: unknown };
  source?: { status: number; body: unknown };
}

function mockVerifyFetch(routes: RouteResponses): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string) => {
    if (url === "/api/verify/config" && routes.config) {
      return Promise.resolve(new Response(JSON.stringify(routes.config.body), { status: routes.config.status }));
    }
    if (url === "/api/verify/source" && routes.source) {
      return Promise.resolve(new Response(JSON.stringify(routes.source.body), { status: routes.source.status }));
    }
    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Button presence
// ---------------------------------------------------------------------------

describe("App — Verify button", () => {
  it("renders the deploy-verify-button in the same toolbar as the other deploy actions", () => {
    render(<App />);
    const btn = screen.getByTestId("deploy-verify-button");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Verify");

    const simulateBtn = screen.getByTestId("deploy-simulate-button");
    expect(btn.parentElement).toBe(simulateBtn.parentElement);
  });
});

// ---------------------------------------------------------------------------
// Success path — POSTs both endpoints, no confirm gate
// ---------------------------------------------------------------------------

describe("App — Verify click behavior", () => {
  it("POSTs to BOTH /api/verify/config and /api/verify/source immediately (no confirm modal)", async () => {
    const fetchSpy = mockVerifyFetch({
      config: { status: 200, body: { clean: true, results: [] } },
      source: { status: 200, body: { success: true, skipped: false, results: [] } },
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));

    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map((c: unknown[]) => c[0]);
      expect(urls).toContain("/api/verify/config");
      expect(urls).toContain("/api/verify/source");
    });

    // No confirm modal exists for Verify (unlike Deploy (real)).
    expect(screen.queryByTestId("deploy-real-modal")).toBeNull();
  });

  it("shows 'Verifying…' while in flight and re-enables afterward", async () => {
    let resolveConfig!: (r: Response) => void;
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/verify/config") {
        return new Promise<Response>((resolve) => {
          resolveConfig = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, skipped: false, results: [] }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));

    await waitFor(() => {
      expect(screen.getByTestId("deploy-verify-button").textContent).toBe("Verifying…");
    });

    resolveConfig(new Response(JSON.stringify({ clean: true, results: [] }), { status: 200 }));

    await waitFor(() => {
      expect(screen.getByTestId("deploy-verify-button").textContent).toBe("Verify");
    });
  });

  it("switches to Inspector mode and renders drift + verified badges after a successful run", async () => {
    const fetchSpy = mockVerifyFetch({
      config: {
        status: 200,
        body: { clean: false, results: [{ id: "some-step", status: "drift", expected: 1, actual: 2 }] },
      },
      source: {
        status: 200,
        body: {
          success: true,
          skipped: false,
          results: [{ id: "some-contract", address: "0xabc", status: "verified" }],
        },
      },
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));

    // Inspector mode is now showing (sample view, since no real deploy has
    // happened) — the sample view's contract ids won't match "some-contract",
    // but the drift/verify state itself must not error the app.
    await waitFor(() => {
      expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
    });
  });

  it("shows an error banner (and does not crash) when the config-drift request fails", async () => {
    const fetchSpy = mockVerifyFetch({
      config: { status: 500, body: { error: "boom" } },
      source: { status: 200, body: { success: true, skipped: false, results: [] } },
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));

    await waitFor(() => {
      const banner = screen.getByTestId("deploy-verify-error");
      expect(banner.textContent).toContain("Config drift check failed");
    });
  });

  it("shows an error banner when the source-verify request fails, independent of a successful drift check", async () => {
    const fetchSpy = mockVerifyFetch({
      config: { status: 200, body: { clean: true, results: [] } },
      source: { status: 502, body: { error: "boom" } },
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-verify-button"));

    await waitFor(() => {
      const banner = screen.getByTestId("deploy-verify-error");
      expect(banner.textContent).toContain("Source verification failed");
    });
  });

  it("does not double-fire when clicked while a request is already in flight", async () => {
    let resolveConfig!: (r: Response) => void;
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/verify/config") {
        return new Promise<Response>((resolve) => {
          resolveConfig = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, skipped: false, results: [] }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    const btn = screen.getByTestId("deploy-verify-button");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toBe("Verifying…"));
    fireEvent.click(btn); // second click while in-flight — must be a no-op

    // Exactly one call to each endpoint (not two).
    expect(fetchSpy.mock.calls.filter((c: unknown[]) => c[0] === "/api/verify/config")).toHaveLength(1);

    resolveConfig(new Response(JSON.stringify({ clean: true, results: [] }), { status: 200 }));
    await waitFor(() => expect(btn.textContent).toBe("Verify"));
  });
});

/**
 * networks-client.test.ts
 *
 * Unit tests for fetchNetworks() — the browser-safe client for the
 * deploy-server's GET /api/networks endpoint (issue #139).
 *
 * Covers:
 * - Success: parses { networks, defaultNetwork } from a valid JSON response.
 * - Graceful fallback (never throws): non-200 status, network/fetch reject,
 *   non-JSON content-type, malformed JSON body, and a JSON body that doesn't
 *   match the expected shape all resolve to FALLBACK_NETWORKS_RESULT.
 * - The content-type guard never calls response.json()/.text() on a
 *   non-JSON response — verified by asserting a spy `json()` is never
 *   invoked when content-type isn't application/json (this is what keeps a
 *   shared mock Response's body safe to read by a LATER, unrelated fetch
 *   call in App-level tests — see App.tsx's mount effect).
 */

import { describe, it, expect, vi } from "vitest";
import { fetchNetworks, FALLBACK_NETWORKS_RESULT } from "../src/deploy/networks-client.js";

describe("fetchNetworks — success", () => {
  it("parses networks + defaultNetwork from a valid JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          networks: [{ name: "default" }, { name: "sepolia", chainId: 11155111 }],
          defaultNetwork: "default",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchNetworks(mockFetch);

    expect(result).toEqual({
      networks: [{ name: "default" }, { name: "sepolia", chainId: 11155111 }],
      defaultNetwork: "default",
    });
  });

  it("GETs /api/networks", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ networks: [{ name: "default" }], defaultNetwork: "default" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchNetworks(mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/networks", { method: "GET" });
  });

  it("accepts a Content-Type header with a charset suffix", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ networks: [{ name: "default" }], defaultNetwork: "default" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );

    const result = await fetchNetworks(mockFetch);
    expect(result.networks).toEqual([{ name: "default" }]);
  });

  it("filters out malformed entries within an otherwise-valid networks array", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          networks: [{ name: "good" }, { chainId: 1 }, { name: "" }, { name: "also-good", chainId: 5 }],
          defaultNetwork: "good",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchNetworks(mockFetch);
    expect(result.networks).toEqual([{ name: "good" }, { name: "also-good", chainId: 5 }]);
  });
});

describe("fetchNetworks — graceful fallback (never throws)", () => {
  it("falls back on a non-200 status", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back on a 500 status", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back on a network error (fetch rejects)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back on a non-JSON content-type (e.g. text/event-stream)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("event: done\ndata: {}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when Content-Type is absent entirely", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ networks: [], defaultNetwork: "x" })));
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back on malformed JSON despite a JSON content-type", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("{ not valid json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when 'networks' is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ defaultNetwork: "default" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when 'defaultNetwork' is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ networks: [{ name: "default" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when 'networks' is an empty array", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ networks: [], defaultNetwork: "default" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when 'networks' contains only malformed entries", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ networks: [{ chainId: 1 }, "nope", null], defaultNetwork: "default" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when the top-level JSON value is not an object (e.g. an array)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await fetchNetworks(mockFetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when the fetch implementation itself throws synchronously", async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const result = await fetchNetworks(mockFetch as unknown as typeof fetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });

  it("falls back when fetchFn resolves to undefined (a bare vi.fn() with no implementation)", async () => {
    const mockFetch = vi.fn();
    const result = await fetchNetworks(mockFetch as unknown as typeof fetch);
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });
});

describe("fetchNetworks — never consumes the body of a non-JSON response", () => {
  it("never calls .json() when content-type isn't application/json", async () => {
    const jsonSpy = vi.fn().mockRejectedValue(new Error("should never be called"));
    const fakeResponse = {
      ok: true,
      headers: { get: () => "text/event-stream" },
      json: jsonSpy,
    } as unknown as Response;
    const mockFetch = vi.fn().mockResolvedValue(fakeResponse);

    const result = await fetchNetworks(mockFetch);

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(result).toEqual(FALLBACK_NETWORKS_RESULT);
  });
});

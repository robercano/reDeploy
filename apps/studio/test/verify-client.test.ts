/**
 * verify-client.test.ts
 *
 * Unit tests for the plain-JSON verify clients (runVerifyConfig, runVerifySource).
 * UNLIKE deploy-client.test.ts / simulate-client.test.ts, these endpoints are
 * NOT SSE — a single Response(JSON) is enough to exercise the full path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runVerifyConfig, runVerifySource } from "../src/deploy/verify-client.js";
import type { ConfigDriftResponse, SourceVerifyResponse } from "../src/deploy/verify-client.js";

describe("runVerifyConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the config spec as JSON to /api/verify/config", async () => {
    const payload: ConfigDriftResponse = { clean: true, results: [] };
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const spec = { version: 1, steps: [] };
    await runVerifyConfig(spec, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/verify/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
  });

  it("returns ok:true with the parsed ConfigDriftResponse", async () => {
    const payload: ConfigDriftResponse = {
      clean: false,
      results: [{ id: "set-fee", status: "drift", expected: 500, actual: 999, message: "mismatch" }],
    };
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const result = await runVerifyConfig({}, mockFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.result).toEqual(payload);
  });

  it("returns ok:false on a non-200 response, including status + body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("bad config spec", { status: 400 }));

    const result = await runVerifyConfig({}, mockFetch);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("400");
    expect(result.error).toContain("bad config spec");
  });

  it("returns ok:false on fetch rejection (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runVerifyConfig({}, mockFetch);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("Network error");
    expect(result.error).toContain("Failed to fetch");
  });

  it("returns ok:false when the response body is empty / not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await runVerifyConfig({}, mockFetch);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("empty");
  });
});

describe("runVerifySource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs an empty JSON object to /api/verify/source", async () => {
    const payload: SourceVerifyResponse = { success: true, skipped: false, results: [] };
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    await runVerifySource(mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/verify/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it("returns ok:true with the parsed SourceVerifyResponse, including a skipped:true payload", async () => {
    const payload: SourceVerifyResponse = {
      success: false,
      skipped: true,
      reason: "ETHERSCAN_API_KEY is not configured on the server",
      results: [],
    };
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const result = await runVerifySource(mockFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.result).toEqual(payload);
  });

  it("returns ok:false on a non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("server error", { status: 502 }));

    const result = await runVerifySource(mockFetch);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("502");
    expect(result.error).toContain("server error");
  });

  it("returns ok:false on fetch rejection (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runVerifySource(mockFetch);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("Network error");
  });

  it("defaults to global fetch when no fetchFn is provided", async () => {
    const payload: SourceVerifyResponse = { success: true, skipped: false, results: [] };
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runVerifySource();

    expect(fetchSpy).toHaveBeenCalledWith("/api/verify/source", expect.any(Object));
    expect(result.ok).toBe(true);

    vi.unstubAllGlobals();
  });
});

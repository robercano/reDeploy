/**
 * deploy-client.test.ts
 *
 * Unit tests for the SSE real-deploy client helper (runDeploy).
 *
 * The KEY difference from simulate: the terminal `done` frame carries a full
 * DeploymentView whose contracts have REAL addresses, so we assert addresses
 * are populated on the returned view.
 *
 * Covered paths:
 * - success: progress + done{success:true, deployment} → view.contracts have addresses
 * - success with deployment:null + warning → empty view carrying the warning
 * - non-200 error response
 * - network reject
 * - stream ends without a done event
 * - done{success:false, errors} → error message
 *
 * All tests are pure / browser-safe (no node-only imports).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDeploy, parseDeployFrame } from "../src/deploy/deploy-client.js";
import type { DeploymentView } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> from an array of string chunks. */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function progressFrame(): string {
  return `event: progress\ndata: ${JSON.stringify({ phase: "deploying" })}\n\n`;
}

function doneOkFrame(deployment: DeploymentView | null, warning?: string): string {
  const data =
    warning !== undefined
      ? { success: true, deployment, warning }
      : { success: true, deployment };
  return `event: done\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneErrorFrame(errors: { message: string }[]): string {
  return `event: done\ndata: ${JSON.stringify({ success: false, errors })}\n\n`;
}

const SAMPLE_VIEW: DeploymentView = {
  contracts: [
    {
      id: "token",
      contractName: "ERC20Token",
      address: "0xTOKEN000000000000000000000000000000000001",
      args: ["MyToken"],
      links: { dependencies: [], libraries: {} },
    },
    {
      id: "vault",
      contractName: "Vault",
      address: "0xVAULT000000000000000000000000000000000002",
      args: [],
      links: { dependencies: ["token"], libraries: {} },
    },
  ],
  configSteps: [],
  warnings: [],
};

// ---------------------------------------------------------------------------
// parseDeployFrame
// ---------------------------------------------------------------------------

describe("parseDeployFrame", () => {
  it("parses a progress frame", () => {
    const frame = `event: progress\ndata: {"phase":"deploying"}`;
    const result = parseDeployFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("progress");
    if (result!.kind === "progress") {
      expect(result!.phase).toBe("deploying");
    }
  });

  it("parses a done{success:true} frame", () => {
    const frame = `event: done\ndata: {"success":true,"deployment":null}`;
    const result = parseDeployFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("done");
    if (result!.kind === "done") {
      expect(result!.done.success).toBe(true);
    }
  });

  it("returns null for empty / no-event / no-data / unknown / malformed frames", () => {
    expect(parseDeployFrame("")).toBeNull();
    expect(parseDeployFrame(`data: {"success":true}`)).toBeNull();
    expect(parseDeployFrame(`event: done`)).toBeNull();
    expect(parseDeployFrame(`event: mystery\ndata: {"x":1}`)).toBeNull();
    expect(parseDeployFrame(`event: done\ndata: not-json`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runDeploy — success path (addresses populated)
// ---------------------------------------------------------------------------

describe("runDeploy — success path", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the spec to /api/deploy", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([progressFrame() + doneOkFrame(SAMPLE_VIEW)]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const spec = { version: 1, contracts: [] };
    await runDeploy(spec, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
  });

  it("returns ok:true with a DeploymentView whose contracts carry REAL addresses", async () => {
    const raw = progressFrame() + doneOkFrame(SAMPLE_VIEW);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runDeploy({}, mockFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.view.contracts).toHaveLength(2);

    const token = result.view.contracts[0];
    expect(token.id).toBe("token");
    expect(token.contractName).toBe("ERC20Token");
    // KEY assertion: address is a real string, NOT null
    expect(token.address).toBe("0xTOKEN000000000000000000000000000000000001");
    expect(token.address).not.toBeNull();
    expect(token.args).toEqual(["MyToken"]);

    const vault = result.view.contracts[1];
    expect(vault.address).toBe("0xVAULT000000000000000000000000000000000002");
    expect(vault.links.dependencies).toEqual(["token"]);
  });

  it("handles a stream split across many small chunks and still populates addresses", async () => {
    const raw = progressFrame() + doneOkFrame(SAMPLE_VIEW);
    const bytes = raw.split("");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream(bytes), { status: 200 }),
    );

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.contracts[0].address).toBe(
      "0xTOKEN000000000000000000000000000000000001",
    );
  });

  it("returns an empty view carrying the warning when deployment is null", async () => {
    const raw = progressFrame() + doneOkFrame(null, "could not read journal");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.contracts).toHaveLength(0);
    expect(result.view.warnings).toContain("could not read journal");
  });

  it("resolves ok:true with an empty view when the done frame omits the deployment field entirely", async () => {
    // done{success:true} with NO `deployment` key at all → the field is
    // `undefined`, not an explicit `null`. This must be treated the same as the
    // null case (empty view + warning) and must NOT throw.
    const raw = progressFrame() + `event: done\ndata: {"success":true}\n\n`;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    let result: Awaited<ReturnType<typeof runDeploy>>;
    // The call must resolve, never throw.
    await expect(
      (async () => {
        result = await runDeploy({}, mockFetch);
      })(),
    ).resolves.toBeUndefined();

    expect(result!.ok).toBe(true);
    if (!result!.ok) throw new Error("expected ok");
    expect(result!.view.contracts).toHaveLength(0);
    // Same default journal warning the deployment:null case surfaces.
    expect(result!.view.warnings.some((w) => /journal/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDeploy — error paths
// ---------------------------------------------------------------------------

describe("runDeploy — error paths", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:false with a message on done{success:false}", async () => {
    const raw = progressFrame() + doneErrorFrame([{ message: "reverted on-chain" }]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("reverted on-chain");
  });

  it("returns ok:false on a non-200 response and includes status + body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("invalid spec format", { status: 400 }),
    );

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("400");
    expect(result.error).toContain("invalid spec format");
  });

  it("returns ok:false on fetch rejection (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("Network error");
    expect(result.error).toContain("Failed to fetch");
  });

  it("returns ok:false when the stream ends without a done event", async () => {
    // Only a progress frame, no done
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([progressFrame()]), { status: 200 }),
    );

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("done event");
  });

  it("returns ok:false when the response body is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("empty");
  });
});

// ---------------------------------------------------------------------------
// runDeploy — structured errors (issue #83)
// ---------------------------------------------------------------------------

describe("runDeploy — structured errors (issue #83)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves code/path/message on done{success:false} errors", async () => {
    const raw =
      progressFrame() +
      `event: done\ndata: ${JSON.stringify({
        success: false,
        errors: [
          { code: "INVALID_ARG", path: "contracts[1].args[0]", message: "arg 0 is invalid" },
        ],
      })}\n\n`;
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");

    expect(result.errors).toEqual([
      { code: "INVALID_ARG", path: "contracts[1].args[0]", message: "arg 0 is invalid" },
    ]);
    expect(result.error).toContain("arg 0 is invalid");
  });

  it("falls back to JSON.stringify for a structured error with no message", async () => {
    const raw =
      progressFrame() +
      `event: done\ndata: ${JSON.stringify({
        success: false,
        errors: [{ path: "contracts[0]" }],
      })}\n\n`;
    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");

    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].path).toBe("contracts[0]");
    expect(result.errors![0].message).toContain("contracts[0]");
  });

  it("does not include an errors field for non-200 responses (message-only fallback)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toBeUndefined();
  });

  it("does not include an errors field for network errors (message-only fallback)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runDeploy({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toBeUndefined();
  });
});

/**
 * simulate-client.test.ts
 *
 * Unit tests for the SSE simulate client helper.
 * Tests cover:
 * - parseSseFrame: parses individual SSE frames
 * - consumeSseStream: streams SSE frames from a ReadableStream
 * - runSimulate: end-to-end simulate call with fetch mock
 *
 * All tests are pure / browser-safe (no node-only imports).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseSseFrame,
  consumeSseStream,
  runSimulate,
} from "../src/deploy/simulate-client.js";
import type { SimulateStep, SimulateEvent } from "../src/deploy/simulate-client.js";

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

/** Build a step SSE frame string. */
function stepFrame(step: Partial<SimulateStep> & { id: string; contract: string }): string {
  const data: SimulateStep = {
    address: null,
    dependsOn: [],
    ...step,
  };
  return `event: step\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Build a done SSE frame string. */
function doneFrame(success: boolean, errors?: { message: string }[]): string {
  const data = success ? { success: true } : { success: false, errors: errors ?? [] };
  return `event: done\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// parseSseFrame
// ---------------------------------------------------------------------------

describe("parseSseFrame", () => {
  it("parses a step frame", () => {
    const frame = `event: step\ndata: {"id":"a","contract":"Foo","dependsOn":[],"address":null}`;
    const result = parseSseFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("step");
    if (result!.kind === "step") {
      expect(result!.step.id).toBe("a");
      expect(result!.step.contract).toBe("Foo");
    }
  });

  it("parses a done{success:true} frame", () => {
    const frame = `event: done\ndata: {"success":true}`;
    const result = parseSseFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("done");
    if (result!.kind === "done") {
      expect(result!.done.success).toBe(true);
    }
  });

  it("parses a done{success:false} frame", () => {
    const frame = `event: done\ndata: {"success":false,"errors":[{"message":"oops"}]}`;
    const result = parseSseFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("done");
    if (result!.kind === "done") {
      expect(result!.done.success).toBe(false);
    }
  });

  it("returns null for empty frame", () => {
    expect(parseSseFrame("")).toBeNull();
    expect(parseSseFrame("  ")).toBeNull();
  });

  it("returns null for frame with no event line", () => {
    const frame = `data: {"success":true}`;
    expect(parseSseFrame(frame)).toBeNull();
  });

  it("returns null for frame with no data line", () => {
    const frame = `event: done`;
    expect(parseSseFrame(frame)).toBeNull();
  });

  it("returns null for unknown event name", () => {
    const frame = `event: unknown\ndata: {"foo":"bar"}`;
    expect(parseSseFrame(frame)).toBeNull();
  });

  it("returns null for malformed JSON in data line", () => {
    const frame = `event: step\ndata: not-json`;
    expect(parseSseFrame(frame)).toBeNull();
  });

  it("handles extra whitespace in event and data lines", () => {
    const frame = `event:  step \ndata:  {"id":"b","contract":"Bar","dependsOn":[],"address":null} `;
    const result = parseSseFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("step");
  });
});

// ---------------------------------------------------------------------------
// consumeSseStream
// ---------------------------------------------------------------------------

describe("consumeSseStream", () => {
  it("yields step and done events from a single complete chunk", async () => {
    const raw =
      stepFrame({ id: "a", contract: "Foo" }) +
      stepFrame({ id: "b", contract: "Bar", dependsOn: ["a"] }) +
      doneFrame(true);

    const stream = makeStream([raw]);
    const events: SimulateEvent[] = [];
    for await (const ev of consumeSseStream(stream)) {
      events.push(ev);
    }

    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe("step");
    expect(events[1].kind).toBe("step");
    expect(events[2].kind).toBe("done");
  });

  it("handles frames split across multiple stream chunks", async () => {
    // Split the frame right in the middle of the data line
    const fullFrame = stepFrame({ id: "a", contract: "Foo" });
    const mid = Math.floor(fullFrame.length / 2);
    const chunk1 = fullFrame.slice(0, mid);
    const chunk2 = fullFrame.slice(mid) + doneFrame(true);

    const stream = makeStream([chunk1, chunk2]);
    const events: SimulateEvent[] = [];
    for await (const ev of consumeSseStream(stream)) {
      events.push(ev);
    }

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("step");
    if (events[0].kind === "step") {
      expect(events[0].step.id).toBe("a");
    }
    expect(events[1].kind).toBe("done");
  });

  it("yields events from many small single-byte chunks", async () => {
    const raw = stepFrame({ id: "x", contract: "X" }) + doneFrame(true);
    // Split into individual bytes
    const bytes = raw.split("").map((c) => c);
    const stream = makeStream(bytes);

    const events: SimulateEvent[] = [];
    for await (const ev of consumeSseStream(stream)) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("step");
    expect(events[1].kind).toBe("done");
  });

  it("handles an empty stream", async () => {
    const stream = makeStream([]);
    const events: SimulateEvent[] = [];
    for await (const ev of consumeSseStream(stream)) {
      events.push(ev);
    }
    expect(events).toHaveLength(0);
  });

  it("maps dependsOn to links.dependencies in step data", async () => {
    const raw = stepFrame({ id: "vault", contract: "Vault", dependsOn: ["token", "registry"] }) + doneFrame(true);
    const stream = makeStream([raw]);
    const events: SimulateEvent[] = [];
    for await (const ev of consumeSseStream(stream)) {
      events.push(ev);
    }
    expect(events[0].kind).toBe("step");
    if (events[0].kind === "step") {
      expect(events[0].step.dependsOn).toEqual(["token", "registry"]);
    }
  });

  it("flushes a trailing frame that has no terminal \\n\\n (trailing-buffer flush path)", async () => {
    // Build a stream whose FINAL frame ends WITHOUT a trailing \n\n.
    // stepFrame() emits "event: step\ndata: {...}\n\n" (with \n\n).
    // We construct the done frame manually WITHOUT the trailing \n\n.
    const doneData = JSON.stringify({ success: true });
    const stepRaw = stepFrame({ id: "a", contract: "Foo", dependsOn: [] });
    // No trailing \n\n on the done frame — exercises the post-loop flush path
    const doneRaw = `event: done\ndata: ${doneData}`;
    const stream = makeStream([stepRaw + doneRaw]);

    const events: SimulateEvent[] = [];
    for await (const ev of consumeSseStream(stream)) {
      events.push(ev);
    }

    // Both the step AND the trailing done frame must be emitted
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("step");
    if (events[0].kind === "step") {
      expect(events[0].step.id).toBe("a");
    }
    expect(events[1].kind).toBe("done");
    if (events[1].kind === "done") {
      expect(events[1].done.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runSimulate — success path
// ---------------------------------------------------------------------------

describe("runSimulate — success path", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the spec to /api/simulate", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        makeStream([doneFrame(true)]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const spec = { version: "1", contracts: [] };
    await runSimulate(spec, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
  });

  it("returns ok:true with a DeploymentView on success", async () => {
    const raw =
      stepFrame({ id: "token", contract: "ERC20Token", args: ["MyToken"], dependsOn: [] }) +
      stepFrame({ id: "vault", contract: "Vault", dependsOn: ["token"] }) +
      doneFrame(true);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.view.contracts).toHaveLength(2);

    const token = result.view.contracts[0];
    expect(token.id).toBe("token");
    expect(token.contractName).toBe("ERC20Token");
    expect(token.address).toBeNull();
    expect(token.args).toEqual(["MyToken"]);
    expect(token.links.dependencies).toEqual([]);
    expect(token.links.libraries).toEqual({});

    const vault = result.view.contracts[1];
    expect(vault.id).toBe("vault");
    expect(vault.contractName).toBe("Vault");
    expect(vault.address).toBeNull();
    expect(vault.links.dependencies).toEqual(["token"]);
  });

  it("preserves topological order of steps", async () => {
    const raw =
      stepFrame({ id: "a", contract: "A", dependsOn: [] }) +
      stepFrame({ id: "b", contract: "B", dependsOn: ["a"] }) +
      stepFrame({ id: "c", contract: "C", dependsOn: ["a", "b"] }) +
      doneFrame(true);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.contracts.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("returns empty contracts array when no step events precede done", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([doneFrame(true)]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.contracts).toHaveLength(0);
    expect(result.view.configSteps).toHaveLength(0);
    expect(result.view.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runSimulate — error paths
// ---------------------------------------------------------------------------

describe("runSimulate — error: done{success:false}", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:false with error message on done{success:false}", async () => {
    const raw =
      stepFrame({ id: "a", contract: "A", dependsOn: [] }) +
      doneFrame(false, [{ message: "contract A failed to deploy" }]);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("contract A failed to deploy");
  });

  it("includes all error messages in the error string", async () => {
    const raw = doneFrame(false, [
      { message: "error one" },
      { message: "error two" },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("error one");
    expect(result.error).toContain("error two");
  });
});

// ---------------------------------------------------------------------------
// runSimulate — structured errors (issue #83)
// ---------------------------------------------------------------------------

describe("runSimulate — structured errors (issue #83)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves code/path/message on done{success:false} errors", async () => {
    const raw = `event: done\ndata: ${JSON.stringify({
      success: false,
      errors: [
        { code: "INVALID_ID", path: "contracts[0].id", message: "id must be a non-empty string" },
      ],
    })}\n\n`;

    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");

    expect(result.errors).toEqual([
      { code: "INVALID_ID", path: "contracts[0].id", message: "id must be a non-empty string" },
    ]);
    // Banner fallback string is still populated.
    expect(result.error).toContain("id must be a non-empty string");
  });

  it("falls back to JSON.stringify for a structured error with no message", async () => {
    const raw = `event: done\ndata: ${JSON.stringify({
      success: false,
      errors: [{ path: "contracts[1]" }],
    })}\n\n`;

    const mockFetch = vi.fn().mockResolvedValue(new Response(makeStream([raw]), { status: 200 }));

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");

    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].path).toBe("contracts[1]");
    expect(result.errors![0].message).toContain("contracts[1]");
  });

  it("does not include an errors field for non-200 responses (message-only fallback)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toBeUndefined();
  });

  it("does not include an errors field for network errors (message-only fallback)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errors).toBeUndefined();
  });
});

describe("runSimulate — error: non-200 response", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:false on 400 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("bad request body", { status: 400 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("400");
  });

  it("returns ok:false on 413 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("body too large", { status: 413 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("413");
  });

  it("includes the response body text in the error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("invalid spec format", { status: 400 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("invalid spec format");
  });
});

describe("runSimulate — error: network error", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:false on fetch rejection (network error)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("Failed to fetch");
  });

  it("returns ok:false when stream ends without done event", async () => {
    // Stream ends with only step events, no done
    const raw = stepFrame({ id: "a", contract: "A", dependsOn: [] });
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([raw]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("done event");
  });
});

// ---------------------------------------------------------------------------
// Chunk-splitting robustness
// ---------------------------------------------------------------------------

describe("runSimulate — chunk splitting robustness", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("correctly parses a frame split across exactly two chunks at the data line", async () => {
    const frame = stepFrame({ id: "split", contract: "SplitContract", dependsOn: [] });
    const done = doneFrame(true);
    const full = frame + done;

    // Split at position 20 (inside the data: line)
    const chunk1 = full.slice(0, 20);
    const chunk2 = full.slice(20);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([chunk1, chunk2]), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.contracts).toHaveLength(1);
    expect(result.view.contracts[0].id).toBe("split");
    expect(result.view.contracts[0].contractName).toBe("SplitContract");
  });

  it("correctly parses multiple frames each in their own chunk", async () => {
    const steps = [
      stepFrame({ id: "a", contract: "A", dependsOn: [] }),
      stepFrame({ id: "b", contract: "B", dependsOn: ["a"] }),
      doneFrame(true),
    ];

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream(steps), { status: 200 }),
    );

    const result = await runSimulate({}, mockFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.contracts).toHaveLength(2);
    expect(result.view.contracts[1].links.dependencies).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// runSimulate — network param (issue #139)
// ---------------------------------------------------------------------------

describe("runSimulate — network param (issue #139)", () => {
  it("omitted network param → POSTs to /api/simulate with no query string (back-compat)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([doneFrame(true)]), { status: 200 }),
    );

    await runSimulate({}, mockFetch);

    expect(mockFetch).toHaveBeenCalledWith("/api/simulate", expect.anything());
  });

  it("undefined network param → POSTs to /api/simulate with no query string", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([doneFrame(true)]), { status: 200 }),
    );

    await runSimulate({}, mockFetch, undefined);

    expect(mockFetch).toHaveBeenCalledWith("/api/simulate", expect.anything());
  });

  it("a network name → POSTs to /api/simulate?network=<name>", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([doneFrame(true)]), { status: 200 }),
    );

    await runSimulate({}, mockFetch, "sepolia");

    expect(mockFetch).toHaveBeenCalledWith("/api/simulate?network=sepolia", expect.anything());
  });

  it("a network name with special characters is URI-encoded", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([doneFrame(true)]), { status: 200 }),
    );

    await runSimulate({}, mockFetch, "my network/1");

    expect(mockFetch).toHaveBeenCalledWith(
      `/api/simulate?network=${encodeURIComponent("my network/1")}`,
      expect.anything(),
    );
  });

  it("an empty-string network param is treated the same as omitted (no query string)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeStream([doneFrame(true)]), { status: 200 }),
    );

    await runSimulate({}, mockFetch, "");

    expect(mockFetch).toHaveBeenCalledWith("/api/simulate", expect.anything());
  });
});

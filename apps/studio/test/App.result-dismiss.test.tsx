/**
 * App.result-dismiss.test.tsx
 *
 * Issue #111 — the Simulate/Deploy RESULT view (the read-only Inspector shown
 * after a run) previously had no reachable way back to the authoring canvas
 * on mobile portrait: the mode-toggle row lives at the top-left and can
 * scroll out of reach on narrow viewports.
 *
 * Covers:
 * - The "result-dismiss" (✕) control is present once a live simulate result
 *   is shown, and absent beforehand / for the plain sample inspector view.
 * - Clicking it returns to authoring mode (result gone, authoring visible).
 * - Pressing Escape performs the same dismiss.
 * - Dismissing does NOT clear the live result — re-opening "Inspector" via
 *   the toolbar toggle still shows the last result (matches the existing
 *   "Authoring" toggle-button behavior, unchanged by this fix).
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../src/App.js";

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

function stepFrame(id: string, contract: string, dependsOn: string[] = []): string {
  const data = { id, contract, dependsOn, address: null };
  return `event: step\ndata: ${JSON.stringify(data)}\n\n`;
}

function doneOkFrame(): string {
  return `event: done\ndata: {"success":true}\n\n`;
}

function mockFetchOk(raw: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(makeStream([enc(raw)]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function runSuccessfulSimulate(): Promise<void> {
  const raw = stepFrame("token", "ERC20Token", []) + doneOkFrame();
  vi.stubGlobal("fetch", mockFetchOk(raw));

  render(<App />);
  fireEvent.click(screen.getByTestId("deploy-simulate-button"));

  await waitFor(() => {
    expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
  });
}

describe("App — result-dismiss control (issue #111)", () => {
  it("is absent before any run (authoring mode)", () => {
    render(<App />);
    expect(screen.queryByTestId("result-dismiss")).toBeNull();
  });

  it("is absent for the plain mode-toggle Inspector view (no live result)", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("mode-inspector"));
    expect(screen.queryByTestId("result-dismiss")).toBeNull();
  });

  it("appears once a live simulate result is shown", async () => {
    await runSuccessfulSimulate();
    expect(screen.queryByTestId("result-dismiss")).not.toBeNull();
  });

  it("has a reachable accessible name", async () => {
    await runSuccessfulSimulate();
    const btn = screen.getByTestId("result-dismiss");
    expect(btn.getAttribute("aria-label")).toBe("Close result view");
  });

  it("clicking it returns to authoring mode and hides the result", async () => {
    await runSuccessfulSimulate();

    fireEvent.click(screen.getByTestId("result-dismiss"));

    expect(screen.queryByTestId("inspector-config-panel")).toBeNull();
    expect(screen.queryByTestId("result-dismiss")).toBeNull();

    // The "Authoring" toggle button should now be the active one.
    const authoringBtn = screen.getByTestId("mode-authoring") as HTMLButtonElement;
    expect(authoringBtn.style.background).toBe("var(--color-primary)");
  });

  it("pressing Escape dismisses the result view the same way", async () => {
    await runSuccessfulSimulate();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("inspector-config-panel")).toBeNull();
    });
    expect(screen.queryByTestId("result-dismiss")).toBeNull();
  });

  it("Escape does nothing while in authoring mode (no result view to dismiss)", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    // Still in authoring: no inspector panel, no dismiss control.
    expect(screen.queryByTestId("inspector-config-panel")).toBeNull();
    expect(screen.queryByTestId("result-dismiss")).toBeNull();
  });

  it("dismissing does not clear the live result — reopening Inspector via the toolbar still shows it", async () => {
    await runSuccessfulSimulate();

    fireEvent.click(screen.getByTestId("result-dismiss"));
    expect(screen.queryByTestId("inspector-config-panel")).toBeNull();

    // Re-open Inspector via the toolbar toggle — the last live result (not
    // the SAMPLE_DEPLOYMENT_VIEW) should still be shown, unchanged from
    // pre-existing mode-toggle behavior.
    fireEvent.click(screen.getByTestId("mode-inspector"));
    expect(screen.queryByTestId("inspector-config-panel")).not.toBeNull();
    expect(screen.queryByTestId("inspector-context-badge")).not.toBeNull();
    expect(screen.queryByTestId("result-dismiss")).not.toBeNull();
  });
});

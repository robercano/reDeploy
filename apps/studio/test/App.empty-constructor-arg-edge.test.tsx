/**
 * App.empty-constructor-arg-edge.test.tsx
 *
 * End-to-end check for the studio-side empty-constructor-arg pre-validation
 * (issue #83 follow-up): an arg slot bound by an incoming constructorRef edge
 * must NEVER be flagged as empty, even though its (ignored) literal input is
 * blank. This is the complementary case to the "genuinely blank literal arg
 * blocks simulate" tests in App.simulate.test.tsx.
 *
 * Isolated in its own file — same reason as App.overview-edges-wiring.test.tsx:
 * it mocks `@xyflow/react`'s `ReactFlow` component so the test can call the
 * real `onConnect` callback directly (jsdom drag-and-drop for React Flow
 * handles is impractical), and that mock must not bleed into other suites
 * that rely on the real ReactFlow rendering (node inputs, aria-labels, etc.).
 *
 * Strategy:
 * - Replace ReactFlow with a fake that captures `nodes` (including `data`,
 *   which carries the SAME `onUpdateArgSlot` callback the real ContractNode
 *   input's onChange handler would call) and `onConnect`. Everything else
 *   (Handle, Position, ReactFlowProvider, useReactFlow, applyNodeChanges/
 *   applyEdgeChanges/addEdge) stays real. The fake never renders ContractNode
 *   itself (same as App.overview-edges-wiring.test.tsx), so filling literal
 *   arg values is done by invoking the captured `onUpdateArgSlot` directly —
 *   equivalent to what a real arg input's onChange does.
 * - Add a Token node (source, 2 literal args — filled via onUpdateArgSlot)
 *   and a Vault node (target, 1 constructor arg "token_", left blank).
 * - Call the captured onConnect to wire Token's output → Vault's arg-0 handle
 *   (a real constructorRef edge, same shape App's real onConnect produces).
 * - Click Deploy (simulate): the request must proceed to the server (fetch
 *   IS called) because Vault's arg-0 is edge-bound, not a blank literal, and
 *   Token's own args are filled.
 */

import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import type { Connection } from "@xyflow/react";

interface CapturedNode {
  id: string;
  data: { onUpdateArgSlot: (nodeId: string, slotIndex: number, value: string) => void };
}

let capturedNodes: CapturedNode[] = [];
let capturedOnConnect: ((conn: Connection) => void) | null = null;

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");

  const FakeReactFlow = (props: Record<string, unknown>) => {
    capturedNodes = (props.nodes as CapturedNode[]) ?? [];
    capturedOnConnect = props.onConnect as ((conn: Connection) => void) | null;
    return React.createElement("div", { "data-testid": "rf-mock" });
  };

  return {
    ...actual,
    ReactFlow: FakeReactFlow,
  };
});

// Import App AFTER vi.mock so the mock factory runs first.
import App from "../src/App.js";

function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

function doneOkFrame(): string {
  return `event: done\ndata: {"success":true}\n\n`;
}

function mockFetchOk(raw: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(raw, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("App — edge-bound constructor arg is exempt from empty-arg pre-validation (issue #83)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    capturedNodes = [];
    capturedOnConnect = null;
  });

  it("simulate proceeds to the server when the only blank arg is edge-bound", async () => {
    const fetchSpy = mockFetchOk(doneOkFrame());
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    // Source (Token, 2 literal args) and target (Vault, 1 constructor arg).
    addNodeByName("Token");
    addNodeByName("Vault");

    expect(capturedNodes).toHaveLength(2);
    const tokenId = capturedNodes[0].id;
    const vaultId = capturedNodes[1].id;

    expect(capturedOnConnect).not.toBeNull();

    // Fill Token's own 2 literal args (equivalent to typing into its inputs)
    // via the same onUpdateArgSlot callback a real ContractNode input calls.
    act(() => {
      capturedNodes[0].data.onUpdateArgSlot(tokenId, 0, "MyToken");
    });
    act(() => {
      capturedNodes[0].data.onUpdateArgSlot(tokenId, 1, "MTK");
    });

    // Wire Token's output to Vault's constructor arg-0 ("token_") — the same
    // constructorRef connection shape App's real onConnect handles. Vault's
    // arg-0 literal input value is left at its default "" — it must NOT be
    // flagged because it is now edge-bound.
    act(() => {
      capturedOnConnect!({
        source: tokenId,
        target: vaultId,
        sourceHandle: `${tokenId}-output`,
        targetHandle: `${vaultId}-arg-0`,
      });
    });

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    // No local block: the request reaches the server because Vault's arg-0
    // is ref-bound (not a blank literal) and Token's args are filled. A local
    // pre-validation failure would never call fetch at all.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
  });
});

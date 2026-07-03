/**
 * App.manifest-drift-arg.test.tsx
 *
 * End-to-end reproduction of the owner-reported bug (issue #83, 2nd round):
 * "Deploy Simulate still does not catch empty constructor parameters."
 *
 * Root cause: `validateConstructorArgs` (src/deploy/field-errors.ts) only ever
 * inspected arg slots that ALREADY EXIST on a node. `buildContractArgs`
 * (src/spec/graph-to-spec.ts) maps a node's arg slots 1:1 into
 * `ContractEntry.args`, so a node with FEWER slots than the contract's true
 * constructor arity (e.g. a graph persisted to localStorage BEFORE
 * contracts.generated.json was regenerated with an extra Foundry constructor
 * param — manifest drift) simply omits the missing parameter(s) from
 * `entry.args` entirely. The old blank-literal-only check never saw the
 * omitted slot, so Deploy (simulate)/(real) proceeded straight to the server
 * with a missing constructor argument.
 *
 * This test seeds localStorage directly (bypassing the authoring UI, which
 * can't produce this state today) with a persisted "Token" node (real
 * manifest contract, constructor arity 2: name_, symbol_) that has only ONE
 * arg slot — simulating a graph saved back when Token had a single-arg
 * constructor. On mount, App restores this drifted node as-is (persistence
 * validation is structural only, per authoring-persistence.ts's module doc —
 * it does not cross-check slot count against the current manifest).
 *
 * Clicking Deploy (simulate) must:
 *   - NOT call fetch (short-circuited locally, before any server round-trip).
 *   - Show the deploy-simulate-error banner.
 *   - Red-border the node (data-node-invalid="true") — the missing param has
 *     no input to highlight at the field level, so the whole node is flagged.
 *
 * Pre-fix, this reproduces the exact bug: fetch WAS called (verified below).
 */

import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import App from "../src/App.js";
import {
  AUTHORING_STORAGE_KEY,
  AUTHORING_STATE_VERSION,
  type PersistedState,
} from "../src/hooks/authoring-persistence.js";

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

/**
 * A persisted "Token" node with manifest drift: Token's real constructor
 * arity is 2 (name_, symbol_), but this node was saved with only 1 slot
 * (index 0, filled) — as if persisted before the manifest gained symbol_.
 */
function driftedTokenState(): PersistedState {
  return {
    version: AUTHORING_STATE_VERSION,
    nodes: [
      {
        id: "contract-drift-1",
        position: { x: 0, y: 0 },
        data: {
          deployId: "myToken",
          contractName: "Token",
          args: [{ index: 0, kind: "literal", value: "MyToken", name: "name_", type: "string" }],
          after: [],
          configSteps: [],
        },
      },
    ],
    edges: [],
    orderedSteps: [],
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("App — manifest-drift missing constructor arg is caught by Deploy (simulate) (issue #83, 2nd follow-up)", () => {
  it("short-circuits locally, shows the error banner, and red-borders the node — never reaching the server", async () => {
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(driftedTokenState()));

    const fetchSpy = mockFetchOk(doneOkFrame());
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);

    // Sanity: the drifted node was restored with only 1 arg slot.
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(1);
    expect(screen.queryByLabelText("arg-1")).toBeNull();

    fireEvent.click(screen.getByTestId("deploy-simulate-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("deploy-simulate-error")).not.toBeNull();
    });

    // The request must never reach the server — validated + rejected locally.
    expect(fetchSpy).not.toHaveBeenCalled();

    const nodeEl = document.querySelector('[data-testid^="contract-node-"]') as HTMLElement;
    expect(nodeEl.getAttribute("data-node-invalid")).toBe("true");
  });
});

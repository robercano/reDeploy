/**
 * App.overview-edges-wiring.test.tsx
 *
 * Wiring test: verifies that App.tsx ACTUALLY passes
 *   `viewMode === "overview" ? overviewEdges(edges) : edges`
 * to ReactFlow's `edges` prop.
 *
 * Isolated in its own file so vi.mock doesn't bleed into other suites.
 *
 * Strategy:
 * - Replace ReactFlow with a fake component that captures `edges`, `nodes`,
 *   and `onConnect` props into module-scope variables on every render.
 *   Everything else (ReactFlowProvider, useReactFlow, Handle, Position,
 *   applyNodeChanges, applyEdgeChanges, addEdge) is kept real so App's
 *   graph state and node callbacks work normally.
 * - Add two nodes via the Contracts Browser. Read their ids from capturedNodes.
 * - Call the captured onConnect twice for the same source→target pair
 *   (two different arg handles) to seed 2 constructorRef edges.
 * - DETAILED (default): assert capturedEdges.length === 2 (full raw list).
 * - Toggle to overview via toggle-view-mode; assert capturedEdges.length === 1
 *   (collapsed to 1 per pair) and that the single overview edge has
 *   sourceHandle ending "-output" and targetHandle ending "-input".
 *
 * MUTATION TEST: revert App.tsx line 262 to `edges={edges}` and the overview
 * assertion `capturedEdges.length === 1` fails (it would be 2). That's the
 * whole point of this test.
 */

import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import type { Edge, Connection } from "@xyflow/react";

// ---------------------------------------------------------------------------
// Module-scope captures — updated by the fake ReactFlow on every render.
// ---------------------------------------------------------------------------

let capturedEdges: Edge[] = [];
let capturedNodes: Array<{ id: string }> = [];
let capturedOnConnect: ((conn: Connection) => void) | null = null;

// ---------------------------------------------------------------------------
// Mock — must appear before any import that transitively loads App.
// ---------------------------------------------------------------------------

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");

  /**
   * Fake ReactFlow: records edges, nodes, and onConnect on every render call.
   * Returns a minimal stable div so React doesn't crash.
   */
  const FakeReactFlow = (props: Record<string, unknown>) => {
    capturedEdges = (props.edges as Edge[]) ?? [];
    capturedNodes = (props.nodes as Array<{ id: string }>) ?? [];
    capturedOnConnect = props.onConnect as ((conn: Connection) => void) | null;
    return React.createElement("div", { "data-testid": "rf-mock" });
  };

  return {
    ...actual,         // keeps real Handle, Position, ReactFlowProvider, useReactFlow,
                       // applyNodeChanges, applyEdgeChanges, addEdge, etc.
    ReactFlow: FakeReactFlow,
  };
});

// Import App AFTER vi.mock so the mock factory runs first.
import App from "../src/App.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App — overviewEdges wiring (mutation-catching)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    capturedEdges = [];
    capturedNodes = [];
    capturedOnConnect = null;
  });

  it("fake ReactFlow is active (rf-mock sentinel present)", () => {
    render(<App />);
    expect(document.querySelector("[data-testid='rf-mock']")).not.toBeNull();
    // Real React Flow would render .react-flow; with the mock that class is absent
    expect(document.querySelector(".react-flow")).toBeNull();
  });

  it("DETAILED mode passes full raw edges; OVERVIEW mode collapses same-pair edges to 1", () => {
    /**
     * This is the core mutation-catching test.
     *
     * Steps:
     * 1. Add Registry (0 args) and Token (2 args) nodes.
     * 2. Seed 2 constructorRef edges: Registry→Token arg-0 AND Registry→Token arg-1.
     * 3. In DETAILED mode: capturedEdges.length === 2.
     * 4. Toggle to overview: capturedEdges.length === 1 (collapsed), and the
     *    single edge anchors to node-level handles.
     *
     * Mutation: revert App.tsx:262 to `edges={edges}` → step 4 gets length 2 → FAIL.
     */
    render(<App />);

    // Add source (no args) and target (2 args) nodes.
    addNodeByName("Registry");
    addNodeByName("Token");

    // After adding 2 nodes, capturedNodes is populated by the fake ReactFlow.
    // The nodes are in order: Registry first, Token second.
    expect(capturedNodes).toHaveLength(2);
    const srcId = capturedNodes[0].id;
    const tgtId = capturedNodes[1].id;

    // onConnect is available from the latest render.
    expect(capturedOnConnect).not.toBeNull();

    // Seed 2 constructorRef edges between the SAME node pair (different arg slots).
    // act() ensures React processes the state updates synchronously.
    act(() => {
      capturedOnConnect!({
        source: srcId,
        target: tgtId,
        sourceHandle: `${srcId}-output`,
        targetHandle: `${tgtId}-arg-0`,
      });
    });
    act(() => {
      capturedOnConnect!({
        source: srcId,
        target: tgtId,
        sourceHandle: `${srcId}-output`,
        targetHandle: `${tgtId}-arg-1`,
      });
    });

    // ── DETAILED mode (default) ──
    // Both raw edges must be passed to ReactFlow.
    expect(capturedEdges).toHaveLength(2);
    // Raw edges point to per-arg handles, not the node-level input.
    const rawTargetHandles = capturedEdges.map((e) => e.targetHandle);
    expect(rawTargetHandles).toContain(`${tgtId}-arg-0`);
    expect(rawTargetHandles).toContain(`${tgtId}-arg-1`);

    // ── Toggle to OVERVIEW ──
    const toggleBtn = screen.getByTestId("toggle-view-mode");
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toBe("Overview");

    // In overview, overviewEdges() must have collapsed 2 same-pair edges → 1.
    // If App.tsx:262 is reverted to `edges={edges}`, this assertion fails (length = 2).
    expect(capturedEdges).toHaveLength(1);

    // The single overview edge must anchor to node-level handles (not arg handles).
    const [ovEdge] = capturedEdges;
    expect(ovEdge.sourceHandle).toBe(`${srcId}-output`);
    expect(ovEdge.targetHandle).toBe(`${tgtId}-input`);
    // The edge id must follow the stable overview convention.
    expect(ovEdge.id).toBe(`overview-${srcId}-${tgtId}`);
    // No per-arg or per-wire data.
    expect(ovEdge.data).toEqual({});

    // ── Toggle back to DETAILED ──
    fireEvent.click(toggleBtn);
    expect(toggleBtn.textContent).toBe("Detailed");

    // Full raw edges are restored.
    expect(capturedEdges).toHaveLength(2);
  });

  it("two distinct pairs: OVERVIEW shows 2 edges (one per pair), not 3", () => {
    /**
     * nodeA→nodeB (1 constructorRef) + nodeA→nodeC (2 constructorRef)
     * → overview: 2 edges, one per pair.
     *
     * Mutation: revert App.tsx:262 → overview shows 3 edges → FAIL.
     */
    render(<App />);

    addNodeByName("Registry"); // nodeA — 0 args (source only)
    addNodeByName("Token");    // nodeB — 2 args
    addNodeByName("Vault");    // nodeC — 1 arg (asset_)

    expect(capturedNodes).toHaveLength(3);
    const [nodeA, nodeB, nodeC] = capturedNodes;

    expect(capturedOnConnect).not.toBeNull();

    // A→B: 1 edge
    act(() => {
      capturedOnConnect!({
        source: nodeA.id,
        target: nodeB.id,
        sourceHandle: `${nodeA.id}-output`,
        targetHandle: `${nodeB.id}-arg-0`,
      });
    });
    // A→C: 2 edges (both arg slots)
    act(() => {
      capturedOnConnect!({
        source: nodeA.id,
        target: nodeC.id,
        sourceHandle: `${nodeA.id}-output`,
        targetHandle: `${nodeC.id}-arg-0`,
      });
    });
    act(() => {
      capturedOnConnect!({
        source: nodeA.id,
        target: nodeC.id,
        sourceHandle: `${nodeA.id}-output`,
        targetHandle: `${nodeC.id}-arg-1`,
      });
    });

    // Detailed: 3 raw edges.
    expect(capturedEdges).toHaveLength(3);

    // Overview: 2 edges (A→B and A→C are distinct pairs).
    fireEvent.click(screen.getByTestId("toggle-view-mode"));
    expect(capturedEdges).toHaveLength(2);

    // Each overview edge anchors to node-level handles.
    const ab = capturedEdges.find((e) => e.target === nodeB.id);
    const ac = capturedEdges.find((e) => e.target === nodeC.id);
    expect(ab).not.toBeUndefined();
    expect(ab!.sourceHandle).toBe(`${nodeA.id}-output`);
    expect(ab!.targetHandle).toBe(`${nodeB.id}-input`);
    expect(ac).not.toBeUndefined();
    expect(ac!.sourceHandle).toBe(`${nodeA.id}-output`);
    expect(ac!.targetHandle).toBe(`${nodeC.id}-input`);
  });

  it("serialization (graphToSpec) still uses the raw edge count regardless of viewMode", () => {
    /**
     * Confirm that the overviewEdges substitution is display-only:
     * the SpecExporter shows a spec derived from raw edges, not collapsed ones.
     *
     * Note: SpecExporter is rendered outside the mocked ReactFlow and still
     * uses the real App state — it reads nodes/edges from the same useMemo
     * that passes raw edges to graphToSpec.
     */
    render(<App />);
    addNodeByName("Registry");
    addNodeByName("Token");

    expect(capturedNodes).toHaveLength(2);
    const [srcNode, tgtNode] = capturedNodes;

    act(() => {
      capturedOnConnect!({
        source: srcNode.id,
        target: tgtNode.id,
        sourceHandle: `${srcNode.id}-output`,
        targetHandle: `${tgtNode.id}-arg-0`,
      });
    });

    // Toggle to overview — display edges collapse.
    fireEvent.click(screen.getByTestId("toggle-view-mode"));
    expect(capturedEdges).toHaveLength(1);
    expect(capturedEdges[0].targetHandle).toBe(`${tgtNode.id}-input`);

    // Open the spec exporter — it should still reflect the real constructorRef
    // edge (arg-0 = ref to Registry), not the collapsed display edge.
    fireEvent.click(screen.getByTestId("export-spec-btn"));
    const textarea = screen.getByTestId("spec-textarea") as HTMLTextAreaElement;

    // The spec should contain a "ref" contract arg — proof the raw edge was used.
    expect(textarea.value).toContain('"kind": "ref"');
    // The display-only overview edge (which has no edgeKind) must NOT bleed
    // into the serialized spec.
    expect(textarea.value).not.toContain("viewMode");
    expect(textarea.value).not.toContain("overview-");
  });
});

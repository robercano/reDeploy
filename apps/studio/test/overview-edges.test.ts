/**
 * overview-edges.test.ts
 *
 * Unit tests for the overviewEdges() pure helper (src/spec/overview-edges.ts).
 *
 * jsdom does not render SVG edge elements so the only reliable test surface for
 * edge aggregation logic is the helper itself — these tests are the load-bearing
 * mutation-catching gate for the feature.
 *
 * Coverage:
 *   1. Empty input → empty output.
 *   2. Single edge → 1 overview edge, correct sourceHandle / targetHandle.
 *   3. 3 constructorRef edges from nodeA→nodeB → exactly 1 overview edge.
 *   4. A constructorRef + a wire edge both A→B → exactly 1 overview edge.
 *   5. Two distinct pairs (A→B, A→C) → 2 overview edges, one per pair.
 *   6. Stable id format: `overview-${source}-${target}`.
 *   7. Overview edge has no per-arg / per-wire data (empty data object).
 *   8. Original edges array is not mutated.
 */

import { describe, it, expect } from "vitest";
import { overviewEdges } from "../src/spec/overview-edges.js";
import type { StudioFlowEdge } from "../src/hooks/useGraph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(
  id: string,
  source: string,
  target: string,
  sourceHandle: string,
  targetHandle: string,
  extraData?: Record<string, unknown>,
): StudioFlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    data: extraData ?? {},
  };
}

function makeConstructorRef(
  id: string,
  source: string,
  target: string,
  argIndex: number,
): StudioFlowEdge {
  return makeEdge(
    id,
    source,
    target,
    `${source}-output`,
    `${target}-arg-${argIndex}`,
    { edgeKind: "constructorRef", argIndex },
  );
}

function makeWire(
  id: string,
  source: string,
  target: string,
): StudioFlowEdge {
  return makeEdge(
    id,
    source,
    target,
    `${source}-output`,
    `${target}-input`,
    { edgeKind: "wire", wireStepId: `ws-${id}`, wireFunction: "setFoo" },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("overviewEdges — empty input", () => {
  it("returns empty array for empty input", () => {
    expect(overviewEdges([])).toHaveLength(0);
  });
});

describe("overviewEdges — single edge", () => {
  it("returns exactly 1 overview edge for a single constructorRef edge", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 0);
    const result = overviewEdges([edge]);
    expect(result).toHaveLength(1);
  });

  it("overview edge has sourceHandle = '<source>-output'", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 0);
    const [ov] = overviewEdges([edge]);
    expect(ov.sourceHandle).toBe("nodeA-output");
  });

  it("overview edge has targetHandle = '<target>-input'", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 0);
    const [ov] = overviewEdges([edge]);
    expect(ov.targetHandle).toBe("nodeB-input");
  });

  it("overview edge preserves source and target node ids", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 2);
    const [ov] = overviewEdges([edge]);
    expect(ov.source).toBe("nodeA");
    expect(ov.target).toBe("nodeB");
  });

  it("overview edge has stable id 'overview-<source>-<target>'", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 0);
    const [ov] = overviewEdges([edge]);
    expect(ov.id).toBe("overview-nodeA-nodeB");
  });

  it("overview edge data is empty (no per-arg/per-wire fields)", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 0);
    const [ov] = overviewEdges([edge]);
    expect(ov.data).toEqual({});
    expect(ov.data).not.toHaveProperty("edgeKind");
    expect(ov.data).not.toHaveProperty("argIndex");
  });
});

describe("overviewEdges — multiple edges same pair → collapse to 1", () => {
  it("3 constructorRef edges A→B collapse to 1 overview edge", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeConstructorRef("e2", "nodeA", "nodeB", 1),
      makeConstructorRef("e3", "nodeA", "nodeB", 2),
    ];
    const result = overviewEdges(edges);
    expect(result).toHaveLength(1);
  });

  it("1 constructorRef + 1 wire edge both A→B collapse to 1 overview edge", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeWire("e2", "nodeA", "nodeB"),
    ];
    const result = overviewEdges(edges);
    expect(result).toHaveLength(1);
  });

  it("collapsed single edge has correct sourceHandle/targetHandle", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeConstructorRef("e2", "nodeA", "nodeB", 1),
    ];
    const [ov] = overviewEdges(edges);
    expect(ov.sourceHandle).toBe("nodeA-output");
    expect(ov.targetHandle).toBe("nodeB-input");
    expect(ov.id).toBe("overview-nodeA-nodeB");
  });
});

describe("overviewEdges — two distinct pairs", () => {
  it("A→B and A→C produce 2 overview edges", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeConstructorRef("e2", "nodeA", "nodeC", 0),
    ];
    const result = overviewEdges(edges);
    expect(result).toHaveLength(2);
  });

  it("A→B overview edge and A→C overview edge have correct handle ids", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeConstructorRef("e2", "nodeA", "nodeC", 0),
    ];
    const result = overviewEdges(edges);

    const ab = result.find((e) => e.target === "nodeB");
    const ac = result.find((e) => e.target === "nodeC");

    expect(ab).not.toBeUndefined();
    expect(ab!.sourceHandle).toBe("nodeA-output");
    expect(ab!.targetHandle).toBe("nodeB-input");

    expect(ac).not.toBeUndefined();
    expect(ac!.sourceHandle).toBe("nodeA-output");
    expect(ac!.targetHandle).toBe("nodeC-input");
  });

  it("B→A and A→B are different pairs (direction matters)", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeConstructorRef("e2", "nodeB", "nodeA", 0),
    ];
    const result = overviewEdges(edges);
    expect(result).toHaveLength(2);
  });
});

describe("overviewEdges — non-mutation", () => {
  it("does not mutate the input array", () => {
    const edges = [
      makeConstructorRef("e1", "nodeA", "nodeB", 0),
      makeConstructorRef("e2", "nodeA", "nodeB", 1),
    ];
    const originalLength = edges.length;
    const originalFirst = { ...edges[0] };

    overviewEdges(edges);

    expect(edges).toHaveLength(originalLength);
    expect(edges[0].id).toBe(originalFirst.id);
    expect(edges[0].sourceHandle).toBe(originalFirst.sourceHandle);
  });

  it("does not mutate the individual edge objects", () => {
    const edge = makeConstructorRef("e1", "nodeA", "nodeB", 2);
    const originalTargetHandle = edge.targetHandle;

    overviewEdges([edge]);

    expect(edge.targetHandle).toBe(originalTargetHandle); // still "nodeA-arg-2"
  });
});

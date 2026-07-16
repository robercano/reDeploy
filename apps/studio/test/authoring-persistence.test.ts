/**
 * authoring-persistence.test.ts
 *
 * Unit tests for the pure localStorage persistence module backing issue #80
 * (authoring canvas autosave/restore): load/save/clear + version and shape
 * validation. No React — see useGraph.test.ts for the hook-level wiring
 * (lazy-restore on mount, debounced autosave, resetGraph).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AUTHORING_STORAGE_KEY,
  AUTHORING_STATE_VERSION,
  loadPersistedState,
  savePersistedState,
  clearPersistedState,
} from "../src/hooks/authoring-persistence";
import type { PersistedState } from "../src/hooks/authoring-persistence";
import type { Node, Edge } from "@xyflow/react";
import type { StudioOrderedConfigStep, StudioParameter } from "../src/spec/types";

beforeEach(() => {
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<Record<string, unknown>> = {}): Node<Record<string, unknown>> {
  return {
    id,
    type: "contractNode",
    position: { x: 10, y: 20 },
    data: {
      deployId: "token",
      contractName: "Token",
      args: [{ index: 0, kind: "literal", value: "18" }],
      after: [],
      configSteps: [],
      ...overrides,
    },
  };
}

function makeEdge(id: string, source: string, target: string): Edge<Record<string, unknown>> {
  return {
    id,
    source,
    target,
    sourceHandle: `${source}-output`,
    targetHandle: `${target}-arg-0`,
    data: { edgeKind: "constructorRef", argIndex: 0 },
  };
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("authoring-persistence — round trip", () => {
  it("returns null when nothing is saved", () => {
    expect(loadPersistedState()).toBeNull();
  });

  it("saves and loads back an equivalent state", () => {
    const nodes = [makeNode("contract-1")];
    const edges = [makeEdge("e1", "contract-1", "contract-2")];
    const orderedSteps: StudioOrderedConfigStep[] = [
      { kind: "setX", id: "ordered-1", target: "token", functionName: "setFee", args: ["100"] },
    ];

    savePersistedState(nodes, edges, orderedSteps);
    const loaded = loadPersistedState();

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(AUTHORING_STATE_VERSION);
    expect(loaded!.nodes).toHaveLength(1);
    expect(loaded!.nodes[0].id).toBe("contract-1");
    expect(loaded!.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(loaded!.nodes[0].data.deployId).toBe("token");
    expect(loaded!.nodes[0].data.contractName).toBe("Token");
    expect(loaded!.nodes[0].data.args).toEqual([{ index: 0, kind: "literal", value: "18" }]);
    expect(loaded!.edges).toHaveLength(1);
    expect(loaded!.edges[0]).toMatchObject({ id: "e1", source: "contract-1", target: "contract-2" });
    expect(loaded!.orderedSteps).toEqual(orderedSteps);
  });

  it("stores under the documented storage key as JSON", () => {
    savePersistedState([makeNode("contract-1")], [], []);
    const raw = window.localStorage.getItem(AUTHORING_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as PersistedState;
    expect(parsed.version).toBe(AUTHORING_STATE_VERSION);
  });

  it("normalizes undefined sourceHandle/targetHandle to null", () => {
    const edge: Edge<Record<string, unknown>> = { id: "e1", source: "a", target: "b" };
    savePersistedState([], [edge], []);
    const loaded = loadPersistedState();
    expect(loaded!.edges[0].sourceHandle).toBeNull();
    expect(loaded!.edges[0].targetHandle).toBeNull();
  });

  it("omits the data field on edges with no data", () => {
    const edge: Edge<Record<string, unknown>> = { id: "e1", source: "a", target: "b" };
    savePersistedState([], [edge], []);
    const loaded = loadPersistedState();
    expect(loaded!.edges[0].data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clearPersistedState
// ---------------------------------------------------------------------------

describe("authoring-persistence — clearPersistedState", () => {
  it("removes the saved state so loadPersistedState returns null again", () => {
    savePersistedState([makeNode("contract-1")], [], []);
    expect(loadPersistedState()).not.toBeNull();

    clearPersistedState();
    expect(loadPersistedState()).toBeNull();
  });

  it("is a no-op when nothing was saved", () => {
    expect(() => clearPersistedState()).not.toThrow();
    expect(loadPersistedState()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Corrupt / stale state discarded gracefully
// ---------------------------------------------------------------------------

describe("authoring-persistence — corrupt/stale state is discarded gracefully", () => {
  it("returns null for malformed JSON (never throws)", () => {
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, "NOT VALID JSON {{{");
    expect(() => loadPersistedState()).not.toThrow();
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null for a version mismatch (stale schema)", () => {
    const stale = {
      version: AUTHORING_STATE_VERSION + 1,
      nodes: [],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(stale));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null for an old version tag (e.g. version 0)", () => {
    const stale = { version: 0, nodes: [], edges: [], orderedSteps: [] };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(stale));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when nodes is not an array", () => {
    const bad = { version: AUTHORING_STATE_VERSION, nodes: "oops", edges: [], orderedSteps: [] };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when a node is missing required fields", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [{ id: "contract-1" /* missing position/data */ }],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when a node's args entries are malformed", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        {
          id: "contract-1",
          position: { x: 0, y: 0 },
          data: {
            deployId: "t",
            contractName: "Token",
            args: [{ index: "not-a-number", kind: "literal", value: "" }],
            after: [],
            configSteps: [],
          },
        },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when an edge is missing required fields", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [{ id: "e1", source: "a" /* missing target */ }],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when orderedSteps contains a malformed step", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [{ kind: "bogus", id: "x" }],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when the top-level value is an array, not an object", () => {
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadPersistedState()).toBeNull();
  });

  it("returns null when the top-level value is null", () => {
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(null));
    expect(loadPersistedState()).toBeNull();
  });

  it("accepts a valid setX config step and a valid grantRole config step", () => {
    const good = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        {
          id: "contract-1",
          position: { x: 0, y: 0 },
          data: {
            deployId: "token",
            contractName: "Token",
            args: [],
            after: [],
            configSteps: [
              { kind: "setX", id: "s1", functionName: "setFee", args: [] },
              { kind: "grantRole", id: "s2", role: "ADMIN", accountKind: "literal", accountValue: "0x1" },
            ],
          },
        },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(good));
    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes[0].data.configSteps).toHaveLength(2);
  });

  it("rejects a config step with an unrecognized kind", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        {
          id: "contract-1",
          position: { x: 0, y: 0 },
          data: {
            deployId: "token",
            contractName: "Token",
            args: [],
            after: [],
            configSteps: [{ kind: "mystery", id: "s1" }],
          },
        },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scripting arg kinds + parameters (issue #137)
// ---------------------------------------------------------------------------

describe("authoring-persistence — scripting arg kinds + parameters round trip (issue #137)", () => {
  it("round-trips param/expr/resolver arg slots", () => {
    const nodes = [
      makeNode("contract-1", {
        args: [
          { index: 0, kind: "param", value: "", paramName: "owner" },
          { index: 1, kind: "expr", value: "", expression: "1n + 2n" },
          { index: 2, kind: "resolver", value: "", resolverName: "computeSalt", resolverArgs: ["v1", "42"] },
        ],
      }),
    ];
    savePersistedState(nodes, [], []);
    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.nodes[0].data.args).toEqual([
      { index: 0, kind: "param", value: "", paramName: "owner" },
      { index: 1, kind: "expr", value: "", expression: "1n + 2n" },
      { index: 2, kind: "resolver", value: "", resolverName: "computeSalt", resolverArgs: ["v1", "42"] },
    ]);
  });

  it("round-trips declared parameters, networks, and the selected network", () => {
    const parameters: StudioParameter[] = [
      { id: "param-1", name: "owner", defaultValue: "0xdef", networkOverrides: { mainnet: "0xmain" } },
    ];
    savePersistedState([], [], [], parameters, ["mainnet", "sepolia"], "mainnet");
    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.parameters).toEqual(parameters);
    expect(loaded!.networks).toEqual(["mainnet", "sepolia"]);
    expect(loaded!.selectedNetwork).toBe("mainnet");
  });

  it("defaults parameters/networks/selectedNetwork to []/[]/null when called with the pre-existing 3-arg signature", () => {
    savePersistedState([], [], []);
    const loaded = loadPersistedState();
    expect(loaded!.parameters).toEqual([]);
    expect(loaded!.networks).toEqual([]);
    expect(loaded!.selectedNetwork).toBeNull();
  });

  it("accepts saved state that predates the parameters/networks/selectedNetwork fields (backward compat)", () => {
    const legacy = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      // no parameters / networks / selectedNetwork keys at all
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(legacy));
    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.parameters).toBeUndefined();
    expect(loaded!.networks).toBeUndefined();
    expect(loaded!.selectedNetwork).toBeUndefined();
  });

  it("rejects an arg slot with an unrecognized kind", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [
        {
          id: "contract-1",
          position: { x: 0, y: 0 },
          data: {
            deployId: "token",
            contractName: "Token",
            args: [{ index: 0, kind: "bogus", value: "" }],
            after: [],
            configSteps: [],
          },
        },
      ],
      edges: [],
      orderedSteps: [],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("rejects a declared parameter missing required fields", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      parameters: [{ id: "p1", name: "owner" /* missing defaultValue/networkOverrides */ }],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("rejects networks that is not an array of strings", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      networks: [1, 2, 3],
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("rejects a selectedNetwork that is neither a string nor null", () => {
    const bad = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      selectedNetwork: 42,
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(bad));
    expect(loadPersistedState()).toBeNull();
  });

  it("accepts a null selectedNetwork", () => {
    const good = {
      version: AUTHORING_STATE_VERSION,
      nodes: [],
      edges: [],
      orderedSteps: [],
      selectedNetwork: null,
    };
    window.localStorage.setItem(AUTHORING_STORAGE_KEY, JSON.stringify(good));
    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    expect(loaded!.selectedNetwork).toBeNull();
  });
});

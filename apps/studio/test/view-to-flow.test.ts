/**
 * view-to-flow.test.ts
 *
 * Unit tests for the pure deploymentViewToFlow adapter.
 * No rendering — tests the adapter directly with hand-built DeploymentView objects.
 */

import { describe, it, expect } from "vitest";
import type { DeploymentView, ContractView, ConfigStepStatus } from "@redeploy/reader";
import { deploymentViewToFlow } from "../src/inspector/view-to-flow.js";
import type { InspectorNodeData } from "../src/inspector/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContract(overrides: Partial<ContractView> & { id: string }): ContractView {
  return {
    contractName: overrides.contractName ?? `Contract_${overrides.id}`,
    address: overrides.address !== undefined ? overrides.address : `0xADDR_${overrides.id}`,
    args: overrides.args ?? [],
    links: overrides.links ?? { dependencies: [], libraries: {} },
    ...overrides,
  };
}

function makeConfigStep(overrides: Partial<ConfigStepStatus> & { id: string }): ConfigStepStatus {
  return {
    kind: overrides.kind ?? "functionCall",
    completed: overrides.completed ?? true,
    completedAt: overrides.completedAt !== undefined ? overrides.completedAt : "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeView(
  contracts: ContractView[],
  configSteps: ConfigStepStatus[] = [],
): DeploymentView {
  return { contracts, configSteps, warnings: [] };
}

// ---------------------------------------------------------------------------
// (a) contracts → nodes including address & args mapping
// ---------------------------------------------------------------------------

describe("deploymentViewToFlow — nodes", () => {
  it("creates one node per contract", () => {
    const view = makeView([
      makeContract({ id: "registry" }),
      makeContract({ id: "token" }),
    ]);
    const { nodes } = deploymentViewToFlow(view);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe("registry");
    expect(nodes[1].id).toBe("token");
  });

  it("node data carries id, contractName, address, args, dependencies, libraries", () => {
    const view = makeView([
      makeContract({
        id: "token",
        contractName: "ERC20Token",
        address: "0xABC",
        args: ["hello", 42, { $bigint: "1000" }],
        links: {
          dependencies: ["registry"],
          libraries: { SafeMath: "0xLIB" },
        },
      }),
    ]);
    const { nodes } = deploymentViewToFlow(view);
    const data = nodes[0].data as unknown as InspectorNodeData;
    expect(data.id).toBe("token");
    expect(data.contractName).toBe("ERC20Token");
    expect(data.address).toBe("0xABC");
    expect(data.args).toEqual(["hello", 42, { $bigint: "1000" }]);
    expect(data.dependencies).toEqual(["registry"]);
    expect(data.libraries).toEqual({ SafeMath: "0xLIB" });
  });

  it("node type is 'inspectorNode'", () => {
    const view = makeView([makeContract({ id: "reg" })]);
    const { nodes } = deploymentViewToFlow(view);
    expect(nodes[0].type).toBe("inspectorNode");
  });

  it("nodes have deterministic grid positions", () => {
    // 4 contracts → 2 rows of 3 (first 3 row 0, last 1 row 1)
    const contracts = ["a", "b", "c", "d"].map((id) => makeContract({ id }));
    const { nodes } = deploymentViewToFlow(makeView(contracts));
    // First row
    expect(nodes[0].position.x).toBe(0);
    expect(nodes[0].position.y).toBe(0);
    expect(nodes[1].position.x).toBe(280);
    expect(nodes[1].position.y).toBe(0);
    expect(nodes[2].position.x).toBe(560);
    expect(nodes[2].position.y).toBe(0);
    // Second row
    expect(nodes[3].position.x).toBe(0);
    expect(nodes[3].position.y).toBe(180);
  });

  it("handles a contract with null address", () => {
    const view = makeView([makeContract({ id: "partial", address: null })]);
    const { nodes } = deploymentViewToFlow(view);
    const data = nodes[0].data as unknown as InspectorNodeData;
    expect(data.address).toBeNull();
  });

  it("handles a contract with no args", () => {
    const view = makeView([makeContract({ id: "noargs", args: [] })]);
    const { nodes } = deploymentViewToFlow(view);
    const data = nodes[0].data as unknown as InspectorNodeData;
    expect(data.args).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) links → edges with correct source/target; dangling dep skipped
// ---------------------------------------------------------------------------

describe("deploymentViewToFlow — dependency edges", () => {
  it("emits one dependency edge per known dependency", () => {
    const view = makeView([
      makeContract({ id: "registry" }),
      makeContract({
        id: "vault",
        links: { dependencies: ["registry"], libraries: {} },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    const depEdge = edges.find((e) => e.id === "dep:registry->vault");
    expect(depEdge).toBeDefined();
    expect(depEdge!.source).toBe("registry");
    expect(depEdge!.target).toBe("vault");
    expect(depEdge!.data?.edgeKind).toBe("dependency");
  });

  it("skips dangling dependencies (dep id not in contracts)", () => {
    const view = makeView([
      makeContract({
        id: "vault",
        links: { dependencies: ["UNKNOWN_DEP"], libraries: {} },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    expect(edges).toHaveLength(0);
  });

  it("handles multiple dependencies on one contract", () => {
    const view = makeView([
      makeContract({ id: "a" }),
      makeContract({ id: "b" }),
      makeContract({
        id: "c",
        links: { dependencies: ["a", "b"], libraries: {} },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    expect(edges).toHaveLength(2);
    const ids = edges.map((e) => e.id).sort();
    expect(ids).toEqual(["dep:a->c", "dep:b->c"]);
  });
});

describe("deploymentViewToFlow — library edges", () => {
  it("emits a library edge when library ref matches a known contract id", () => {
    const view = makeView([
      makeContract({ id: "mathLib" }),
      makeContract({
        id: "token",
        links: {
          dependencies: [],
          libraries: { SafeMath: "mathLib" },
        },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    const libEdge = edges.find((e) => e.id === "lib:mathLib->token");
    expect(libEdge).toBeDefined();
    expect(libEdge!.source).toBe("mathLib");
    expect(libEdge!.target).toBe("token");
    expect(libEdge!.data?.edgeKind).toBe("library");
  });

  it("skips library edge when library ref is a raw address (not a contract id)", () => {
    const view = makeView([
      makeContract({
        id: "token",
        links: {
          dependencies: [],
          libraries: { SafeMath: "0xRawAddress" },
        },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    expect(edges).toHaveLength(0);
  });

  it("does not duplicate library edge if same lib referenced twice", () => {
    const view = makeView([
      makeContract({ id: "lib" }),
      makeContract({
        id: "token",
        links: {
          dependencies: [],
          libraries: { SafeMath: "lib", SafeMath2: "lib" },
        },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    const libEdges = edges.filter((e) => e.data?.edgeKind === "library");
    // Only one edge lib->token should be emitted (dedup by id)
    expect(libEdges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (c) empty deployment → empty nodes/edges
// ---------------------------------------------------------------------------

describe("deploymentViewToFlow — empty deployment", () => {
  it("returns empty nodes and edges for an empty deployment", () => {
    const { nodes, edges } = deploymentViewToFlow(makeView([]));
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d) partially configured deployment — configSteps mapping
// ---------------------------------------------------------------------------

describe("deploymentViewToFlow — config steps", () => {
  it("preserves configSteps on the DeploymentView (adapter does not touch them)", () => {
    // The adapter doesn't process configSteps (those are displayed by Inspector
    // directly from view.configSteps). We verify the adapter doesn't crash
    // when view has partial steps.
    const view = makeView(
      [makeContract({ id: "reg" })],
      [
        makeConfigStep({ id: "step1", completed: true }),
        makeConfigStep({ id: "step2", completed: false, completedAt: null }),
      ],
    );
    const { nodes, edges } = deploymentViewToFlow(view);
    // Adapter just builds nodes/edges; configSteps are untouched by adapter.
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
    // The original view configSteps are still there (not the adapter's concern).
    expect(view.configSteps[0].completed).toBe(true);
    expect(view.configSteps[1].completed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) contract with null address
// ---------------------------------------------------------------------------

describe("deploymentViewToFlow — null address", () => {
  it("handles null address in node data without error", () => {
    const view = makeView([makeContract({ id: "partial", address: null })]);
    const { nodes } = deploymentViewToFlow(view);
    expect(nodes).toHaveLength(1);
    const data = nodes[0].data as unknown as InspectorNodeData;
    expect(data.address).toBeNull();
  });

  it("still emits edges for a null-address contract that has dependencies", () => {
    const view = makeView([
      makeContract({ id: "dep" }),
      makeContract({
        id: "partial",
        address: null,
        links: { dependencies: ["dep"], libraries: {} },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("dep");
    expect(edges[0].target).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// Edge id format
// ---------------------------------------------------------------------------

describe("deploymentViewToFlow — edge id determinism", () => {
  it("dependency edge id has format dep:<source>-><target>", () => {
    const view = makeView([
      makeContract({ id: "a" }),
      makeContract({
        id: "b",
        links: { dependencies: ["a"], libraries: {} },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    expect(edges[0].id).toBe("dep:a->b");
  });

  it("library edge id has format lib:<source>-><target>", () => {
    const view = makeView([
      makeContract({ id: "lib" }),
      makeContract({
        id: "user",
        links: { dependencies: [], libraries: { SafeMath: "lib" } },
      }),
    ]);
    const { edges } = deploymentViewToFlow(view);
    expect(edges[0].id).toBe("lib:lib->user");
  });
});

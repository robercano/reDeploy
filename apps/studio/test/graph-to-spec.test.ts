/**
 * graph-to-spec.test.ts
 *
 * Round-trip acceptance tests: construct representative graphs in code,
 * run graphToSpec, and validate the output with the real validateSpec /
 * validateConfig functions.
 *
 * ## Invalid-graph behavior (documented)
 * The serializer is permissive: it emits whatever the graph describes, even
 * if invalid (duplicate ids, missing refs, etc.). Validation errors are
 * surfaced by validateSpec / validateConfig, not prevented by the serializer.
 * Tests below assert that behavior explicitly.
 */

import { describe, it, expect } from "vitest";
import { validateSpec } from "@redeploy/core/spec";
import { validateConfig } from "@redeploy/config/steps";
import { graphToSpec } from "../src/spec/graph-to-spec";
import type { GraphNode, GraphEdge, ContractNodePayload } from "../src/spec/graph-to-spec";
import type { ConstructorRefEdgeData, WireEdgeData } from "../src/spec/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  deployId: string,
  contractName: string,
  overrides: Partial<ContractNodePayload> = {},
): GraphNode {
  return {
    id,
    data: {
      deployId,
      contractName,
      args: [],
      after: [],
      configSteps: [],
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// (a) Deployment-only graph (no edges, no config steps)
// ---------------------------------------------------------------------------

describe("graphToSpec — deployment-only graph", () => {
  it("produces a valid DeploymentSpec with no edges", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "ERC20Token"),
      makeNode("n2", "registry", "Registry"),
    ];
    const { deployment, config } = graphToSpec(nodes, []);

    expect(deployment.version).toBe(1);
    expect(deployment.contracts).toHaveLength(2);
    expect(deployment.contracts[0].id).toBe("token");
    expect(deployment.contracts[1].id).toBe("registry");

    const dResult = validateSpec(deployment);
    expect(dResult.ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
  });

  it("emits no args when node has empty arg slots", () => {
    const nodes: GraphNode[] = [makeNode("n1", "token", "Token")];
    const { deployment } = graphToSpec(nodes, []);
    expect(deployment.contracts[0].args).toBeUndefined();
  });

  it("emits literal args for a node with literal slots", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        args: [
          { index: 0, kind: "literal", value: "100" },
          { index: 1, kind: "literal", value: "true" },
          { index: 2, kind: "literal", value: "hello" },
          { index: 3, kind: "literal", value: "null" },
          { index: 4, kind: "literal", value: "" },
        ],
      }),
    ];
    const { deployment } = graphToSpec(nodes, []);
    const args = deployment.contracts[0].args!;
    expect(args[0]).toEqual({ kind: "literal", value: 100 });
    expect(args[1]).toEqual({ kind: "literal", value: true });
    expect(args[2]).toEqual({ kind: "literal", value: "hello" });
    expect(args[3]).toEqual({ kind: "literal", value: null });
    expect(args[4]).toEqual({ kind: "literal", value: null });
  });
});

// ---------------------------------------------------------------------------
// (b) Inter-contract constructorRef edges
// ---------------------------------------------------------------------------

describe("graphToSpec — constructorRef edges", () => {
  it("maps a constructorRef edge to a RefArg in the target contract", () => {
    // token → registry arg[0]
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token"),
      makeNode("n2", "registry", "Registry", {
        args: [{ index: 0, kind: "literal", value: "" }],
      }),
    ];
    const edgeData: ConstructorRefEdgeData = { edgeKind: "constructorRef", argIndex: 0 };
    const edges: GraphEdge[] = [
      { id: "e1", source: "n1", target: "n2", data: edgeData },
    ];

    const { deployment } = graphToSpec(nodes, edges);

    // registry should have a RefArg pointing at token
    const registryEntry = deployment.contracts.find((c) => c.id === "registry")!;
    expect(registryEntry.args).toBeDefined();
    expect(registryEntry.args![0]).toEqual({ kind: "ref", contract: "token" });

    // token should be unchanged
    const tokenEntry = deployment.contracts.find((c) => c.id === "token")!;
    expect(tokenEntry.args).toBeUndefined();

    // Full round-trip validation
    const dResult = validateSpec(deployment);
    if (!dResult.ok) {
      console.error("Validation errors:", dResult.errors);
    }
    expect(dResult.ok).toBe(true);
  });

  it("places ref at correct index when multiple arg slots exist", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "tokenA", "TokenA"),
      makeNode("n2", "vault", "Vault", {
        args: [
          { index: 0, kind: "literal", value: "42" },
          { index: 1, kind: "literal", value: "" },
        ],
      }),
    ];
    const edgeData: ConstructorRefEdgeData = { edgeKind: "constructorRef", argIndex: 1 };
    const edges: GraphEdge[] = [
      { id: "e1", source: "n1", target: "n2", data: edgeData },
    ];

    const { deployment } = graphToSpec(nodes, edges);
    const vaultEntry = deployment.contracts.find((c) => c.id === "vault")!;

    expect(vaultEntry.args![0]).toEqual({ kind: "literal", value: 42 });
    expect(vaultEntry.args![1]).toEqual({ kind: "ref", contract: "tokenA" });

    expect(validateSpec(deployment).ok).toBe(true);
  });

  it("round-trip validates with multiple inter-contract refs", () => {
    // oracle → price, oracle → feed; vault → oracle
    const nodes: GraphNode[] = [
      makeNode("n1", "price", "PriceFeed"),
      makeNode("n2", "feed", "DataFeed"),
      makeNode("n3", "oracle", "Oracle", {
        args: [
          { index: 0, kind: "literal", value: "" },
          { index: 1, kind: "literal", value: "" },
        ],
      }),
      makeNode("n4", "vault", "Vault", {
        args: [{ index: 0, kind: "literal", value: "" }],
      }),
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "n1", target: "n3", data: { edgeKind: "constructorRef", argIndex: 0 } },
      { id: "e2", source: "n2", target: "n3", data: { edgeKind: "constructorRef", argIndex: 1 } },
      { id: "e3", source: "n3", target: "n4", data: { edgeKind: "constructorRef", argIndex: 0 } },
    ];

    const { deployment, config } = graphToSpec(nodes, edges);
    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) Config steps: setX, grantRole, wire
// ---------------------------------------------------------------------------

describe("graphToSpec — config steps", () => {
  it("maps a setX step to a SetXStep in the config", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        configSteps: [
          {
            kind: "setX",
            id: "step-setfee",
            functionName: "setFee",
            args: ["100", "true"],
          },
        ],
      }),
    ];

    const { deployment, config } = graphToSpec(nodes, []);

    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    expect(step.id).toBe("step-setfee");
    expect(step.target).toBe("token");
    expect(step.function).toBe("setFee");
    expect(step.args).toEqual([
      { kind: "literal", value: 100 },
      { kind: "literal", value: true },
    ]);
  });

  it("respects an explicit step.target override (cross-node setX)", () => {
    // The step is attached to node "token1" but its step.target explicitly points
    // to "token2" (a cross-node setX). graphToSpec must serialize the override,
    // not the attached node's own deployId.
    const nodes: GraphNode[] = [
      makeNode("n1", "token1", "Token"),
      makeNode("n2", "token2", "Token", {
        configSteps: [
          {
            kind: "setX",
            id: "step-override",
            functionName: "setFee",
            args: ["50"],
            target: "token1", // explicit override: target is token1, not token2
          },
        ],
      }),
    ];

    const { deployment, config } = graphToSpec(nodes, []);

    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    expect(step.id).toBe("step-override");
    // Must use the explicit override ("token1"), not the attached node's id ("token2").
    expect(step.target).toBe("token1");
    expect(step.function).toBe("setFee");
  });

  it("maps a grantRole step with literal account", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        configSteps: [
          {
            kind: "grantRole",
            id: "step-grant",
            role: "MINTER_ROLE",
            accountKind: "literal",
            accountValue: "0xdeadbeef",
          },
        ],
      }),
    ];

    const { deployment, config } = graphToSpec(nodes, []);
    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("grantRole");
    if (step.kind !== "grantRole") return;
    expect(step.role).toBe("MINTER_ROLE");
    expect(step.account).toEqual({ kind: "literal", value: "0xdeadbeef" });
  });

  it("maps a grantRole step with ref account", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "admin", "AdminContract"),
      makeNode("n2", "token", "Token", {
        configSteps: [
          {
            kind: "grantRole",
            id: "step-grant-ref",
            role: "ADMIN_ROLE",
            accountKind: "ref",
            accountValue: "admin",
          },
        ],
      }),
    ];

    const { deployment, config } = graphToSpec(nodes, []);
    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    if (step.kind !== "grantRole") return;
    expect(step.account).toEqual({ kind: "ref", contract: "admin" });
  });

  it("maps a wire edge to a WireStep in the config", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "oracle", "Oracle"),
      makeNode("n2", "vault", "Vault"),
    ];
    const wireData: WireEdgeData = {
      edgeKind: "wire",
      wireStepId: "wire-1",
      wireFunction: "setOracle",
    };
    const edges: GraphEdge[] = [
      { id: "e1", source: "n1", target: "n2", data: wireData },
    ];

    const { deployment, config } = graphToSpec(nodes, edges);
    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("wire");
    if (step.kind !== "wire") return;
    expect(step.id).toBe("wire-1");
    expect(step.source).toBe("oracle");
    expect(step.into).toBe("vault");
    expect(step.function).toBe("setOracle");
  });

  it("exercises all three config step kinds simultaneously", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "oracle", "Oracle"),
      makeNode("n2", "registry", "Registry"),
      makeNode("n3", "vault", "Vault", {
        configSteps: [
          {
            kind: "setX",
            id: "step-fee",
            functionName: "setFee",
            args: ["50"],
          },
          {
            kind: "grantRole",
            id: "step-admin",
            role: "MANAGER_ROLE",
            accountKind: "literal",
            accountValue: "0xabc",
          },
        ],
      }),
    ];
    const wireData: WireEdgeData = {
      edgeKind: "wire",
      wireStepId: "wire-oracle",
      wireFunction: "setOracle",
    };
    const edges: GraphEdge[] = [
      { id: "e1", source: "n1", target: "n3", data: wireData },
    ];

    const { deployment, config } = graphToSpec(nodes, edges);

    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const kinds = cResult.spec.steps.map((s) => s.kind);
    expect(kinds).toContain("setX");
    expect(kinds).toContain("grantRole");
    expect(kinds).toContain("wire");
  });
});

// ---------------------------------------------------------------------------
// (d) Invalid-graph behavior — documented: serializer is permissive
// ---------------------------------------------------------------------------

describe("graphToSpec — invalid graphs (permissive emit + validator surfaces errors)", () => {
  it("emits and validator rejects: duplicate deployIds", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token"),
      makeNode("n2", "token", "AnotherToken"), // duplicate id
    ];
    const { deployment } = graphToSpec(nodes, []);

    // Serializer still emits the spec (permissive)
    expect(deployment.contracts).toHaveLength(2);

    // But validateSpec catches the duplicate
    const result = validateSpec(deployment);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "DUPLICATE_ID")).toBe(true);
  });

  it("emits and validator rejects: ref to non-existent contract id", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "vault", "Vault", {
        args: [{ index: 0, kind: "literal", value: "" }],
      }),
    ];
    // Edge from a node that doesn't exist in nodes list
    const edgeData: ConstructorRefEdgeData = { edgeKind: "constructorRef", argIndex: 0 };
    const edges: GraphEdge[] = [
      { id: "e1", source: "ghost-node", target: "n1", data: edgeData },
    ];

    const { deployment } = graphToSpec(nodes, edges);
    // vault's arg[0] should be ref to "ghost-node" (the raw node id, since node not found)
    const vaultEntry = deployment.contracts.find((c) => c.id === "vault")!;
    expect(vaultEntry.args![0]).toEqual({ kind: "ref", contract: "ghost-node" });

    // validateSpec should catch the missing ref
    const result = validateSpec(deployment);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "MISSING_REF")).toBe(true);
  });

  it("emits and validator rejects: self-reference in constructor arg", () => {
    // vault has a ref pointing to itself
    const nodes: GraphNode[] = [
      makeNode("n1", "vault", "Vault", {
        args: [{ index: 0, kind: "literal", value: "" }],
      }),
    ];
    const edgeData: ConstructorRefEdgeData = { edgeKind: "constructorRef", argIndex: 0 };
    // Edge from n1 to n1 (self loop)
    const edges: GraphEdge[] = [
      { id: "e1", source: "n1", target: "n1", data: edgeData },
    ];

    const { deployment } = graphToSpec(nodes, edges);

    const result = validateSpec(deployment);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Either SELF_REFERENCE or CYCLE is expected
    const codes = result.errors.map((e) => e.code);
    expect(codes.some((c) => c === "SELF_REFERENCE" || c === "CYCLE")).toBe(true);
  });

  it("emits and validator rejects: config step referencing missing contract", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "vault", "Vault", {
        configSteps: [
          {
            kind: "setX",
            id: "step-wire",
            functionName: "setFoo",
            args: [],
          },
        ],
      }),
    ];

    // wire edge references a node not in graph
    const wireData: WireEdgeData = {
      edgeKind: "wire",
      wireStepId: "wire-ghost",
      wireFunction: "setOracle",
    };
    const edges: GraphEdge[] = [
      { id: "e1", source: "ghost-node", target: "n1", data: wireData },
    ];

    const { deployment, config } = graphToSpec(nodes, edges);

    // Deployment is valid (vault exists)
    expect(validateSpec(deployment).ok).toBe(true);

    // Config should fail because source "ghost-node" is not in deployment
    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(false);
    if (cResult.ok) return;
    expect(cResult.errors.some((e) => e.code === "MISSING_REF")).toBe(true);
  });

  it("emits empty strings as null literals (permissive)", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        args: [{ index: 0, kind: "literal", value: "" }],
      }),
    ];
    const { deployment } = graphToSpec(nodes, []);
    expect(deployment.contracts[0].args![0]).toEqual({ kind: "literal", value: null });
  });
});

// ---------------------------------------------------------------------------
// (e) Edge case: empty graph
// ---------------------------------------------------------------------------

describe("graphToSpec — empty graph", () => {
  it("produces valid empty specs", () => {
    const { deployment, config } = graphToSpec([], []);
    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);
    expect(deployment.contracts).toHaveLength(0);
    expect(config.steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (h) Display-only name/type fields on ArgSlot — must NOT leak into spec
// ---------------------------------------------------------------------------

describe("graphToSpec — named/typed ArgSlots do not leak into spec", () => {
  it("serializes a node with named+typed slots to {kind, value} args only", () => {
    // Simulate a node produced by addContractFromManifest
    const nodes: GraphNode[] = [
      {
        id: "n1",
        data: {
          deployId: "vault",
          contractName: "VaultERC4626",
          args: [
            { index: 0, kind: "literal", value: "0xasset", name: "asset_", type: "contract IERC20" },
            { index: 1, kind: "literal", value: "0xoracle", name: "oracle_", type: "contract IOracle" },
            { index: 2, kind: "literal", value: "MyVault", name: "name_", type: "string" },
            { index: 3, kind: "literal", value: "MVT", name: "symbol_", type: "string" },
          ],
          after: [],
          configSteps: [],
        },
      },
    ];

    const { deployment } = graphToSpec(nodes, []);

    // Validate deployment spec is structurally valid
    const dResult = validateSpec(deployment);
    expect(dResult.ok).toBe(true);

    const contractArgs = deployment.contracts[0].args!;
    expect(contractArgs).toHaveLength(4);

    // Each arg must only have kind + value — no name or type
    for (const arg of contractArgs) {
      expect(arg.kind).toBe("literal");
      expect("name" in arg).toBe(false);
      expect("type" in arg).toBe(false);
    }

    // Values are correctly serialized
    expect(contractArgs[0]).toEqual({ kind: "literal", value: "0xasset" });
    expect(contractArgs[1]).toEqual({ kind: "literal", value: "0xoracle" });
    expect(contractArgs[2]).toEqual({ kind: "literal", value: "MyVault" });
    expect(contractArgs[3]).toEqual({ kind: "literal", value: "MVT" });
  });

  it("config spec is also valid and steps have no leaked name/type", () => {
    const nodes: GraphNode[] = [
      {
        id: "n1",
        data: {
          deployId: "vault",
          contractName: "VaultERC4626",
          args: [
            { index: 0, kind: "literal", value: "0xasset", name: "asset_", type: "contract IERC20" },
          ],
          after: [],
          configSteps: [],
        },
      },
    ];

    const { deployment, config } = graphToSpec(nodes, []);
    expect(validateSpec(deployment).ok).toBe(true);
    expect(validateConfig(config, deployment).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (i) Overloaded function support — serialization of function field
// ---------------------------------------------------------------------------

describe("graphToSpec — overloaded function serialization", () => {
  it("serializes FULL CANONICAL SIGNATURE when function name is overloaded and functionSignature is set", () => {
    // Overloaded contract has two setLimit overloads in the manifest.
    // The step carries functionSignature = "setLimit(uint256,address)" to disambiguate.
    const nodes: GraphNode[] = [
      makeNode("n1", "overloaded", "Overloaded", {
        configSteps: [
          {
            kind: "setX",
            id: "step-setlimit2",
            functionName: "setLimit",
            functionSignature: "setLimit(uint256,address)",
            args: ["100", "0xabc"],
          },
        ],
      }),
    ];

    const { deployment, config } = graphToSpec(nodes, []);
    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    // Must emit the full canonical signature because setLimit is overloaded on Overloaded.
    expect(step.function).toBe("setLimit(uint256,address)");
  });

  it("serializes FULL CANONICAL SIGNATURE for the one-arg overload too", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "overloaded", "Overloaded", {
        configSteps: [
          {
            kind: "setX",
            id: "step-setlimit1",
            functionName: "setLimit",
            functionSignature: "setLimit(uint256)",
            args: ["42"],
          },
        ],
      }),
    ];

    const { config } = graphToSpec(nodes, []);
    const cResult = validateConfig(config, { version: 1, contracts: [{ id: "overloaded", contract: "Overloaded" }] });
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    expect(step.function).toBe("setLimit(uint256)");
  });

  it("serializes BARE NAME for a unique function even when functionSignature is set", () => {
    // Token.mint is unique (only one overload). Should emit bare name "mint".
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        configSteps: [
          {
            kind: "setX",
            id: "step-mint",
            functionName: "mint",
            functionSignature: "mint(address,uint256)",
            args: ["0xabc", "1000"],
          },
        ],
      }),
    ];

    const { config } = graphToSpec(nodes, []);
    const cResult = validateConfig(config, { version: 1, contracts: [{ id: "token", contract: "Token" }] });
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    // Bare name because mint is unique on Token.
    expect(step.function).toBe("mint");
  });

  it("serializes BARE NAME for free-text step (no functionSignature)", () => {
    // Legacy / fallback path: no functionSignature present. Always bare name.
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        configSteps: [
          {
            kind: "setX",
            id: "step-setfee",
            functionName: "setFee",
            // functionSignature: absent (free-text input path)
            args: [],
          },
        ],
      }),
    ];

    const { config } = graphToSpec(nodes, []);
    const cResult = validateConfig(config, { version: 1, contracts: [{ id: "token", contract: "Token" }] });
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    // Free-text: bare name regardless of overloads.
    expect(step.function).toBe("setFee");
  });

  it("emitted ConfigSpec with overload signature passes validateConfig", () => {
    // End-to-end: graph → spec → validateConfig. The overloaded signature
    // "setLimit(uint256,address)" must be accepted as a valid function name.
    const deployment = { version: 1 as const, contracts: [{ id: "overloaded", contract: "Overloaded" }] };
    const nodes: GraphNode[] = [
      makeNode("n1", "overloaded", "Overloaded", {
        configSteps: [
          {
            kind: "setX",
            id: "step-ol",
            functionName: "setLimit",
            functionSignature: "setLimit(uint256,address)",
            args: ["99", "0xdeadbeef"],
          },
        ],
      }),
    ];
    const { config } = graphToSpec(nodes, []);
    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// (j) Cross-node overload resolution — TARGET contract drives the decision
// ---------------------------------------------------------------------------

describe("graphToSpec — cross-node setX overload resolution", () => {
  it("emits FULL CANONICAL SIGNATURE when step is attached to Registry but targets Overloaded (which has the overload)", () => {
    // Reproduction case 1 from reviewer:
    // Attached node: Registry (no setLimit), target node: Overloaded (setLimit is overloaded).
    // The serializer must look up Overloaded's manifest (the TARGET), not Registry's,
    // to decide whether to emit the full canonical signature.
    // This would FAIL against the old buggy serializer (it would emit bare "setLimit").
    const nodes: GraphNode[] = [
      makeNode("n1", "registry", "Registry", {
        configSteps: [
          {
            kind: "setX",
            id: "step-cross-overload",
            functionName: "setLimit",
            functionSignature: "setLimit(uint256,address)",
            args: ["100", "0xabc"],
            target: "overloaded", // targets Overloaded deploy-id
          },
        ],
      }),
      makeNode("n2", "overloaded", "Overloaded"),
    ];

    const { deployment, config } = graphToSpec(nodes, []);
    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    expect(step.target).toBe("overloaded");
    // Must emit full canonical signature because setLimit is overloaded on the TARGET (Overloaded).
    expect(step.function).toBe("setLimit(uint256,address)");
  });

  it("emits BARE NAME when step is attached to Overloaded but targets Registry (which has no setLimit overload)", () => {
    // Reproduction case 2 from reviewer:
    // Attached node: Overloaded (setLimit is overloaded), target node: Registry (no setLimit).
    // The serializer must look up Registry's manifest (the TARGET), not Overloaded's.
    // Registry has no setLimit at all (sameNameCount = 0, not > 1), so emit bare name.
    // This would FAIL against the old buggy serializer (it would emit "setLimit(uint256)" signature).
    const nodes: GraphNode[] = [
      makeNode("n1", "overloaded", "Overloaded", {
        configSteps: [
          {
            kind: "setX",
            id: "step-cross-unique",
            functionName: "setLimit",
            functionSignature: "setLimit(uint256)",
            args: ["42"],
            target: "registry", // targets Registry deploy-id
          },
        ],
      }),
      makeNode("n2", "registry", "Registry"),
    ];

    const { deployment, config } = graphToSpec(nodes, []);
    expect(validateSpec(deployment).ok).toBe(true);

    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    expect(step.target).toBe("registry");
    // Must emit bare name because Registry has no setLimit overload (target has sameNameCount=0).
    expect(step.function).toBe("setLimit");
  });

  it("self-targeting step still resolves correctly against the attached node contract", () => {
    // When step.target is absent (defaults to attached node's deployId),
    // the attached contract name is used — same behavior as before the fix.
    // Ensures backward-compat is preserved for same-node setX steps.
    const nodes: GraphNode[] = [
      makeNode("n1", "overloaded", "Overloaded", {
        configSteps: [
          {
            kind: "setX",
            id: "step-self",
            functionName: "setLimit",
            functionSignature: "setLimit(uint256,address)",
            args: ["99", "0xdeadbeef"],
            // No target override — defaults to attached node
          },
        ],
      }),
    ];

    const { config } = graphToSpec(nodes, []);
    const cResult = validateConfig(config, { version: 1, contracts: [{ id: "overloaded", contract: "Overloaded" }] });
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;

    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    // Self-targeting: Overloaded has setLimit overloaded, so full canonical signature emitted.
    expect(step.function).toBe("setLimit(uint256,address)");
  });
});

// ---------------------------------------------------------------------------
// (f) after[] ordering constraints
// ---------------------------------------------------------------------------

describe("graphToSpec — after ordering", () => {
  it("carries after[] from node data into the ContractEntry", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "dep", "Dep"),
      makeNode("n2", "main", "Main", { after: ["dep"] }),
    ];

    const { deployment } = graphToSpec(nodes, []);
    const mainEntry = deployment.contracts.find((c) => c.id === "main")!;
    expect(mainEntry.after).toEqual(["dep"]);

    expect(validateSpec(deployment).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (g) Large-integer literal preservation (uint256 / precision guard)
// ---------------------------------------------------------------------------

describe("graphToSpec — large-integer literal preservation (uint256 safety)", () => {
  it("preserves a uint256-scale token amount string as a string (not a number)", () => {
    const largeInt = "1000000000000000000000"; // 1e21, > Number.MAX_SAFE_INTEGER
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        args: [{ index: 0, kind: "literal", value: largeInt }],
      }),
    ];
    const { deployment } = graphToSpec(nodes, []);
    const arg = deployment.contracts[0].args![0];
    expect(arg.kind).toBe("literal");
    if (arg.kind !== "literal") return;
    // Must be preserved as the original string, NOT a corrupted number
    expect(arg.value).toBe(largeInt);
    expect(typeof arg.value).toBe("string");
    // validateSpec must accept this (string is a valid LiteralScalar)
    expect(validateSpec(deployment).ok).toBe(true);
  });

  it("preserves uint256 max value as a string", () => {
    // 2^256 - 1
    const uint256Max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const nodes: GraphNode[] = [
      makeNode("n1", "vault", "Vault", {
        args: [{ index: 0, kind: "literal", value: uint256Max }],
      }),
    ];
    const { deployment } = graphToSpec(nodes, []);
    const arg = deployment.contracts[0].args![0];
    expect(arg.kind).toBe("literal");
    if (arg.kind !== "literal") return;
    expect(arg.value).toBe(uint256Max);
    expect(typeof arg.value).toBe("string");
    expect(validateSpec(deployment).ok).toBe(true);
  });

  it("preserves off-by-one unsafe integer (9007199254740993) as a string", () => {
    // Number.MAX_SAFE_INTEGER + 1 = 9007199254740993; Number() coercion rounds it
    const offByOne = "9007199254740993";
    const nodes: GraphNode[] = [
      makeNode("n1", "registry", "Registry", {
        args: [{ index: 0, kind: "literal", value: offByOne }],
      }),
    ];
    const { deployment } = graphToSpec(nodes, []);
    const arg = deployment.contracts[0].args![0];
    expect(arg.kind).toBe("literal");
    if (arg.kind !== "literal") return;
    expect(arg.value).toBe(offByOne);
    expect(typeof arg.value).toBe("string");
    expect(validateSpec(deployment).ok).toBe(true);
  });

  it("still coerces a small safe integer string to a number", () => {
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        args: [{ index: 0, kind: "literal", value: "100" }],
      }),
    ];
    const { deployment } = graphToSpec(nodes, []);
    const arg = deployment.contracts[0].args![0];
    expect(arg.kind).toBe("literal");
    if (arg.kind !== "literal") return;
    expect(arg.value).toBe(100);
    expect(typeof arg.value).toBe("number");
    expect(validateSpec(deployment).ok).toBe(true);
  });

  it("preserves large-int as a string in a config setX step and validateConfig accepts it", () => {
    const largeInt = "1000000000000000000000";
    const nodes: GraphNode[] = [
      makeNode("n1", "token", "Token", {
        configSteps: [
          {
            kind: "setX",
            id: "step-mint",
            functionName: "setSupplyCap",
            args: [largeInt],
          },
        ],
      }),
    ];
    const { deployment, config } = graphToSpec(nodes, []);
    const cResult = validateConfig(config, deployment);
    expect(cResult.ok).toBe(true);
    if (!cResult.ok) return;
    const step = cResult.spec.steps[0];
    expect(step.kind).toBe("setX");
    if (step.kind !== "setX") return;
    const arg = step.args![0];
    expect(arg.kind).toBe("literal");
    if (arg.kind !== "literal") return;
    // Large int must be preserved as string, not a corrupted number
    expect(arg.value).toBe(largeInt);
    expect(typeof arg.value).toBe("string");
  });
});

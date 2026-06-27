/**
 * derive.ts
 *
 * Pure derivation logic: Foundry compiled output (one entry per contract file) → ContractManifest[].
 *
 * This module is imported by both the gen-manifest script (Node.js, fs I/O)
 * and the test suite (vitest), so it MUST be side-effect-free and have no
 * Node-only imports (no fs, path, child_process).
 *
 * Input format (Foundry out/<ContractName>.sol/<ContractName>.json):
 *   {
 *     abi: [...],
 *     ast: {
 *       absolutePath: "src/Foo.sol",
 *       nodeType: "SourceUnit",
 *       nodes: [
 *         { nodeType: "ContractDefinition", name: "Foo", id: 123,
 *           contractKind: "contract",
 *           linearizedBaseContracts: [123, 456, ...],
 *           nodes: [ ... FunctionDefinition ... ] }
 *       ]
 *     }
 *   }
 */

import type { ContractManifest, ConstructorArg, ManifestFunction, ManifestFunctionInput } from "./types.js";

// ---------------------------------------------------------------------------
// AST node types (minimal subset we need)
// ---------------------------------------------------------------------------

interface AstNode {
  nodeType: string;
  id?: number;
  name?: string;
  [key: string]: unknown;
}

interface ContractDefinitionNode extends AstNode {
  nodeType: "ContractDefinition";
  id: number;
  name: string;
  contractKind: "contract" | "interface" | "library";
  linearizedBaseContracts: number[];
  nodes: AstNode[];
}

interface ParameterNode extends AstNode {
  name: string;
  typeDescriptions: { typeString: string };
}

interface ParameterList {
  parameters: ParameterNode[];
}

interface FunctionDefinitionNode extends AstNode {
  nodeType: "FunctionDefinition";
  name: string;
  kind: "function" | "constructor" | "fallback" | "receive";
  visibility: "public" | "external" | "internal" | "private";
  stateMutability: "pure" | "view" | "nonpayable" | "payable";
  parameters: ParameterList;
}

interface SourceUnit {
  absolutePath: string;
  nodeType: "SourceUnit";
  nodes: AstNode[];
}

/** One entry per Foundry contract output file. */
export interface FoundryContractOutput {
  abi: unknown[];
  ast: SourceUnit;
}

// ---------------------------------------------------------------------------
// packageSegments derivation
// ---------------------------------------------------------------------------

/**
 * Derive packageSegments from a Foundry source absolutePath.
 *
 * Rules (applied in order):
 *
 * 1. Paths starting with "src/" → ["src"]
 *    e.g. "src/Token.sol" → ["src"]
 *
 * 2. Paths starting with "lib/openzeppelin-contracts/contracts/" →
 *    map to ["@openzeppelin", ...remaining dirs before filename]
 *    e.g. "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol"
 *         → ["@openzeppelin", "token", "ERC20"]
 *    e.g. "lib/openzeppelin-contracts/contracts/utils/Context.sol"
 *         → ["@openzeppelin", "utils"]
 *    e.g. "lib/openzeppelin-contracts/contracts/utils/introspection/ERC165.sol"
 *         → ["@openzeppelin", "utils", "introspection"]
 *
 * 3. Paths starting with "lib/forge-std/" → ["forge-std"]
 *
 * 4. Other "lib/<libname>/..." → ["<libname>"]
 *
 * 5. Fallback: ["unknown"]
 */
export function derivePackageSegments(sourcePath: string): string[] {
  // Rule 1: project source
  if (sourcePath.startsWith("src/")) {
    return ["src"];
  }

  // Rule 2: OpenZeppelin contracts
  const ozPrefix = "lib/openzeppelin-contracts/contracts/";
  if (sourcePath.startsWith(ozPrefix)) {
    const rest = sourcePath.slice(ozPrefix.length); // e.g. "token/ERC20/ERC20.sol"
    const parts = rest.split("/");
    // Drop the last element (filename)
    const dirs = parts.slice(0, parts.length - 1);
    if (dirs.length === 0) {
      return ["@openzeppelin"];
    }
    return ["@openzeppelin", ...dirs];
  }

  // Rule 3: forge-std
  if (sourcePath.startsWith("lib/forge-std/")) {
    return ["forge-std"];
  }

  // Rule 4: other lib
  const libPrefix = "lib/";
  if (sourcePath.startsWith(libPrefix)) {
    const rest = sourcePath.slice(libPrefix.length);
    const libName = rest.split("/")[0];
    return [libName];
  }

  // Rule 5: fallback
  return ["unknown"];
}

// ---------------------------------------------------------------------------
// Build global id→name and id→sourcePath maps
// ---------------------------------------------------------------------------

function buildIdMaps(outputs: FoundryContractOutput[]): {
  idToName: Map<number, string>;
  idToContractNodes: Map<number, ContractDefinitionNode>;
} {
  const idToName = new Map<number, string>();
  const idToContractNodes = new Map<number, ContractDefinitionNode>();

  for (const output of outputs) {
    const ast = output.ast;
    for (const node of ast.nodes) {
      if (node.nodeType === "ContractDefinition") {
        const c = node as ContractDefinitionNode;
        idToName.set(c.id, c.name);
        idToContractNodes.set(c.id, c);
      }
    }
  }

  return { idToName, idToContractNodes };
}

// ---------------------------------------------------------------------------
// Derive ContractManifest for a single ContractDefinition node
// ---------------------------------------------------------------------------

function deriveManifest(
  contractNode: ContractDefinitionNode,
  sourcePath: string,
  idToName: Map<number, string>,
  idToContractNodes: Map<number, ContractDefinitionNode>,
): ContractManifest {
  const name = contractNode.name;

  // packageSegments
  const packageSegments = derivePackageSegments(sourcePath);

  // constructorArgs: find constructor FunctionDefinition in THIS contract's nodes
  const constructorNode = contractNode.nodes.find(
    (n): n is FunctionDefinitionNode =>
      n.nodeType === "FunctionDefinition" &&
      (n as FunctionDefinitionNode).kind === "constructor",
  ) as FunctionDefinitionNode | undefined;

  const constructorArgs: ConstructorArg[] = constructorNode
    ? constructorNode.parameters.parameters.map((p) => ({
        name: p.name,
        type: p.typeDescriptions.typeString,
      }))
    : [];

  // inheritance: resolve linearizedBaseContracts (most-derived first) to names
  const inheritance: string[] = contractNode.linearizedBaseContracts
    .map((id) => idToName.get(id))
    .filter((n): n is string => n !== undefined);

  // functions: collect public/external functions from the entire inheritance chain.
  // Walk linearizedBaseContracts most-derived-first, collect functions, de-dup by name
  // (first occurrence wins = most-derived declaration).
  const seenFunctions = new Set<string>();
  const functions: ManifestFunction[] = [];

  for (const baseId of contractNode.linearizedBaseContracts) {
    const baseNode = idToContractNodes.get(baseId);
    if (!baseNode) continue;

    const baseName = idToName.get(baseId) ?? String(baseId);

    for (const node of baseNode.nodes) {
      if (node.nodeType !== "FunctionDefinition") continue;
      const fn = node as FunctionDefinitionNode;
      if (fn.kind !== "function") continue;
      if (fn.visibility !== "public" && fn.visibility !== "external") continue;

      const fnName = fn.name;
      // De-dup: keep most-derived declaration (first seen)
      if (seenFunctions.has(fnName)) continue;
      seenFunctions.add(fnName);

      const inputs: ManifestFunctionInput[] = fn.parameters.parameters.map((p) => ({
        name: p.name,
        type: p.typeDescriptions.typeString,
      }));

      functions.push({
        name: fnName,
        declaredIn: baseName,
        inputs,
        stateMutability: fn.stateMutability,
      });
    }
  }

  return {
    name,
    sourcePath,
    packageSegments,
    constructorArgs,
    inheritance,
    functions,
  };
}

// ---------------------------------------------------------------------------
// Main derivation entry point
// ---------------------------------------------------------------------------

/**
 * Derive ContractManifest[] from an array of Foundry contract output objects.
 *
 * Each output corresponds to one Foundry `out/<Name>.sol/<Name>.json` file.
 * The function:
 *   1. Deduplicates outputs by absolutePath (the same source file's AST appears
 *      in multiple contract output files when contracts share a source).
 *   2. Builds a global id→name map across all ASTs for cross-contract resolution.
 *   3. For each unique source file, walks ContractDefinition nodes whose
 *      contractKind === "contract".
 *   4. Returns manifests sorted by (sourcePath, contractName) for stable output.
 */
export function deriveManifests(outputs: FoundryContractOutput[]): ContractManifest[] {
  // Deduplicate outputs by absolutePath to avoid duplicate manifests
  // (the same source file AST can appear in multiple Foundry contract output files)
  const uniqueOutputsByPath = new Map<string, FoundryContractOutput>();
  for (const output of outputs) {
    const path = output.ast.absolutePath;
    if (!uniqueOutputsByPath.has(path)) {
      uniqueOutputsByPath.set(path, output);
    }
  }
  const uniqueOutputs = Array.from(uniqueOutputsByPath.values());

  const { idToName, idToContractNodes } = buildIdMaps(uniqueOutputs);

  const manifests: ContractManifest[] = [];

  for (const output of uniqueOutputs) {
    const ast = output.ast;
    const sourcePath = ast.absolutePath;

    for (const node of ast.nodes) {
      if (node.nodeType !== "ContractDefinition") continue;
      const c = node as ContractDefinitionNode;
      if (c.contractKind !== "contract") continue;

      manifests.push(deriveManifest(c, sourcePath, idToName, idToContractNodes));
    }
  }

  // Sort for deterministic output: by sourcePath, then by name within the file
  manifests.sort((a, b) => {
    const pathCmp = a.sourcePath.localeCompare(b.sourcePath);
    if (pathCmp !== 0) return pathCmp;
    return a.name.localeCompare(b.name);
  });

  return manifests;
}

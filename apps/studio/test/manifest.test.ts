/**
 * manifest.test.ts
 *
 * Tests for the studio contract manifest pipeline:
 *   - Loader shape and contents (against committed contracts.generated.json)
 *   - Pure derivation logic (against committed test fixture build-info)
 */

import { describe, it, expect } from "vitest";
import fixtureOutputs from "./fixtures/contracts-build-info.json";
import { contractManifest, getContract } from "../src/manifest/index.js";
import type { ContractManifest } from "../src/manifest/types.js";
import { deriveManifests, derivePackageSegments } from "../src/manifest/derive.js";
import type { FoundryContractOutput } from "../src/manifest/derive.js";

// ---------------------------------------------------------------------------
// Loader shape tests (against committed contracts.generated.json)
// ---------------------------------------------------------------------------

describe("contractManifest loader", () => {
  it("is an array", () => {
    expect(Array.isArray(contractManifest)).toBe(true);
  });

  it("has at least one entry", () => {
    expect(contractManifest.length).toBeGreaterThan(0);
  });

  it("each entry matches ContractManifest shape", () => {
    for (const entry of contractManifest) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.sourcePath).toBe("string");
      expect(Array.isArray(entry.packageSegments)).toBe(true);
      expect(Array.isArray(entry.constructorArgs)).toBe(true);
      expect(Array.isArray(entry.inheritance)).toBe(true);
      expect(Array.isArray(entry.functions)).toBe(true);
      // constructorArgs shape
      for (const arg of entry.constructorArgs) {
        expect(typeof arg.name).toBe("string");
        expect(typeof arg.type).toBe("string");
      }
      // functions shape
      for (const fn of entry.functions) {
        expect(typeof fn.name).toBe("string");
        expect(typeof fn.signature).toBe("string");
        expect(typeof fn.declaredIn).toBe("string");
        expect(Array.isArray(fn.inputs)).toBe(true);
        expect(["pure", "view", "nonpayable", "payable"]).toContain(fn.stateMutability);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The 5 project contracts must be present in the generated manifest
// ---------------------------------------------------------------------------

describe("contractManifest — project contracts present", () => {
  const projectContracts = ["Token", "Vault", "Registry", "PriceOracle", "VaultERC4626", "Overloaded"];

  for (const name of projectContracts) {
    it(`contains ${name}`, () => {
      const entry = getContract(name);
      expect(entry).toBeDefined();
      expect(entry!.name).toBe(name);
    });
  }

  it("project contracts have sourcePath starting with 'src/'", () => {
    for (const name of projectContracts) {
      const entry = getContract(name);
      expect(entry!.sourcePath).toMatch(/^src\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Overloaded contract — two setLimit overloads with distinct signatures
// ---------------------------------------------------------------------------

describe("contractManifest — Overloaded contract overloads", () => {
  it("Overloaded has exactly two setLimit functions with distinct signatures", () => {
    const entry = getContract("Overloaded")!;
    const setLimitFns = entry.functions.filter((f) => f.name === "setLimit");
    expect(setLimitFns).toHaveLength(2);
    const sigs = setLimitFns.map((f) => f.signature).sort();
    expect(sigs).toContain("setLimit(uint256)");
    expect(sigs).toContain("setLimit(uint256,address)");
  });

  it("setLimit(uint256) has one input of type uint256", () => {
    const entry = getContract("Overloaded")!;
    const fn = entry.functions.find((f) => f.signature === "setLimit(uint256)");
    expect(fn).toBeDefined();
    expect(fn!.inputs).toHaveLength(1);
    expect(fn!.inputs[0].type).toBe("uint256");
  });

  it("setLimit(uint256,address) has two inputs: uint256 and address", () => {
    const entry = getContract("Overloaded")!;
    const fn = entry.functions.find((f) => f.signature === "setLimit(uint256,address)");
    expect(fn).toBeDefined();
    expect(fn!.inputs).toHaveLength(2);
    expect(fn!.inputs[0].type).toBe("uint256");
    expect(fn!.inputs[1].type).toBe("address");
  });

  it("both setLimit functions have declaredIn='Overloaded'", () => {
    const entry = getContract("Overloaded")!;
    const setLimitFns = entry.functions.filter((f) => f.name === "setLimit");
    for (const fn of setLimitFns) {
      expect(fn.declaredIn).toBe("Overloaded");
    }
  });

  it("both setLimit functions have stateMutability='nonpayable'", () => {
    const entry = getContract("Overloaded")!;
    const setLimitFns = entry.functions.filter((f) => f.name === "setLimit");
    for (const fn of setLimitFns) {
      expect(fn.stateMutability).toBe("nonpayable");
    }
  });

  it("Overloaded functions list has no duplicate signatures", () => {
    const entry = getContract("Overloaded")!;
    const sigs = entry.functions.map((f) => f.signature);
    const uniqueSigs = new Set(sigs);
    expect(sigs.length).toBe(uniqueSigs.size);
  });
});

// ---------------------------------------------------------------------------
// Constructor arg names and order
// ---------------------------------------------------------------------------

describe("contractManifest — constructor args", () => {
  it("VaultERC4626 has constructor args [asset_, oracle_, name_, symbol_]", () => {
    const entry = getContract("VaultERC4626")!;
    expect(entry.constructorArgs).toHaveLength(4);
    const names = entry.constructorArgs.map((a) => a.name);
    expect(names).toEqual(["asset_", "oracle_", "name_", "symbol_"]);
  });

  it("PriceOracle has constructor args [decimals_, initialAnswer_]", () => {
    const entry = getContract("PriceOracle")!;
    expect(entry.constructorArgs).toHaveLength(2);
    const names = entry.constructorArgs.map((a) => a.name);
    expect(names).toEqual(["decimals_", "initialAnswer_"]);
  });

  it("Token has constructor args [name_, symbol_]", () => {
    const entry = getContract("Token")!;
    expect(entry.constructorArgs).toHaveLength(2);
    const names = entry.constructorArgs.map((a) => a.name);
    expect(names).toEqual(["name_", "symbol_"]);
  });

  it("Vault has constructor args [token_]", () => {
    const entry = getContract("Vault")!;
    expect(entry.constructorArgs).toHaveLength(1);
    expect(entry.constructorArgs[0].name).toBe("token_");
  });

  it("Registry has constructor args [admin]", () => {
    const entry = getContract("Registry")!;
    expect(entry.constructorArgs).toHaveLength(1);
    expect(entry.constructorArgs[0].name).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// packageSegments derivation
// ---------------------------------------------------------------------------

describe("contractManifest — packageSegments", () => {
  it("project contracts (src/) have packageSegments ['src']", () => {
    const projectContracts = ["Token", "Vault", "Registry", "PriceOracle", "VaultERC4626"];
    for (const name of projectContracts) {
      const entry = getContract(name)!;
      expect(entry.packageSegments).toEqual(["src"]);
    }
  });

  it("the loader manifest only contains deployable src/ project contracts", () => {
    // The generated manifest now excludes interfaces, libraries, and abstract
    // bases (e.g. OZ ERC4626/ERC20/Context, forge-std bases). Only concrete,
    // non-abstract project contracts under src/ remain.
    for (const entry of contractManifest) {
      expect(entry.packageSegments).toEqual(["src"]);
      expect(entry.sourcePath).toMatch(/^src\//);
    }
  });

  it("excludes OZ/abstract base contracts (ERC20, Context, ERC4626) from the loader manifest", () => {
    expect(contractManifest.some((c) => c.name === "ERC20")).toBe(false);
    expect(contractManifest.some((c) => c.name === "Context")).toBe(false);
    expect(contractManifest.some((c) => c.name === "ERC4626")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inheritance ordering (most-derived-first)
// ---------------------------------------------------------------------------

describe("contractManifest — inheritance ordering", () => {
  it("VaultERC4626 inheritance[0] is 'VaultERC4626' (most-derived)", () => {
    const entry = getContract("VaultERC4626")!;
    expect(entry.inheritance[0]).toBe("VaultERC4626");
  });

  it("VaultERC4626 inheritance includes 'ERC4626'", () => {
    const entry = getContract("VaultERC4626")!;
    expect(entry.inheritance).toContain("ERC4626");
  });

  it("VaultERC4626 inheritance has 'ERC4626' after 'VaultERC4626'", () => {
    const entry = getContract("VaultERC4626")!;
    const vaultIdx = entry.inheritance.indexOf("VaultERC4626");
    const erc4626Idx = entry.inheritance.indexOf("ERC4626");
    expect(vaultIdx).toBeLessThan(erc4626Idx);
  });
});

// ---------------------------------------------------------------------------
// Function grouping by declaredIn
// ---------------------------------------------------------------------------

describe("contractManifest — function grouping by declaredIn", () => {
  it("VaultERC4626 has assetPrice and totalValue with declaredIn='VaultERC4626'", () => {
    const entry = getContract("VaultERC4626")!;
    const ownFns = entry.functions.filter((f) => f.declaredIn === "VaultERC4626");
    const ownNames = ownFns.map((f) => f.name);
    expect(ownNames).toContain("assetPrice");
    expect(ownNames).toContain("totalValue");
  });

  it("VaultERC4626 has functions from ERC4626 with declaredIn='ERC4626'", () => {
    const entry = getContract("VaultERC4626")!;
    const erc4626Fns = entry.functions.filter((f) => f.declaredIn === "ERC4626");
    expect(erc4626Fns.length).toBeGreaterThan(0);
    // ERC4626 declares deposit, mint, withdraw, redeem etc.
    const names = erc4626Fns.map((f) => f.name);
    expect(names).toContain("deposit");
  });

  it("functions list has no duplicates by SIGNATURE (overloads share a name but differ by signature)", () => {
    // VaultERC4626 has no overloads: signatures are all distinct AND names are all distinct.
    const entry = getContract("VaultERC4626")!;
    const signatures = entry.functions.map((f) => f.signature);
    const uniqueSigs = new Set(signatures);
    expect(signatures.length).toBe(uniqueSigs.size);
  });

  it("each function has a signature matching name(type1,type2,...) pattern", () => {
    const entry = getContract("VaultERC4626")!;
    for (const fn of entry.functions) {
      // Signature must start with the function name
      expect(fn.signature.startsWith(fn.name + "(")).toBe(true);
      // Signature must end with ")"
      expect(fn.signature.endsWith(")")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getContract utility
// ---------------------------------------------------------------------------

describe("getContract", () => {
  it("returns undefined for unknown contract name", () => {
    expect(getContract("NonExistentContract123")).toBeUndefined();
  });

  it("returns the correct entry for a known contract", () => {
    const entry = getContract("Token");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Token");
  });
});

// ---------------------------------------------------------------------------
// Pure derivation tests (against fixture build-info, independent of forge)
// ---------------------------------------------------------------------------

describe("deriveManifests — fixture-based deterministic derivation", () => {
  const outputs = fixtureOutputs as unknown as FoundryContractOutput[];
  const manifests = deriveManifests(outputs);

  it("produces an array of ContractManifest", () => {
    expect(Array.isArray(manifests)).toBe(true);
    expect(manifests.length).toBeGreaterThan(0);
  });

  it("contains all 6 project contracts from fixture", () => {
    const names = manifests.map((m) => m.name);
    expect(names).toContain("Token");
    expect(names).toContain("Vault");
    expect(names).toContain("Registry");
    expect(names).toContain("PriceOracle");
    expect(names).toContain("VaultERC4626");
    expect(names).toContain("Overloaded");
  });

  it("output is sorted by sourcePath then name (stable order)", () => {
    for (let i = 1; i < manifests.length; i++) {
      const prev = manifests[i - 1];
      const curr = manifests[i];
      const cmp =
        prev.sourcePath.localeCompare(curr.sourcePath) ||
        prev.name.localeCompare(curr.name);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("deduplicates contracts with the same sourcePath (no duplicates)", () => {
    const seen = new Set<string>();
    for (const m of manifests) {
      const key = `${m.sourcePath}::${m.name}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  describe("packageSegments derivation from fixture", () => {
    it("src/ contracts → ['src']", () => {
      const src = manifests.filter((m) => m.sourcePath.startsWith("src/"));
      expect(src.length).toBeGreaterThan(0);
      for (const m of src) {
        expect(m.packageSegments).toEqual(["src"]);
      }
    });

    it("OZ contracts → starts with '@openzeppelin'", () => {
      const oz = manifests.filter((m) =>
        m.sourcePath.startsWith("lib/openzeppelin-contracts/"),
      );
      expect(oz.length).toBeGreaterThan(0);
      for (const m of oz) {
        expect(m.packageSegments[0]).toBe("@openzeppelin");
      }
    });
  });

  describe("inheritance ordering from fixture", () => {
    it("VaultERC4626 most-derived-first: index 0 = 'VaultERC4626'", () => {
      const m = manifests.find((x) => x.name === "VaultERC4626")!;
      expect(m.inheritance[0]).toBe("VaultERC4626");
    });

    it("VaultERC4626 includes ERC4626 in inheritance", () => {
      const m = manifests.find((x) => x.name === "VaultERC4626")!;
      expect(m.inheritance).toContain("ERC4626");
    });
  });

  describe("constructor args from fixture", () => {
    it("VaultERC4626 → [asset_, oracle_, name_, symbol_] in order", () => {
      const m = manifests.find((x) => x.name === "VaultERC4626")!;
      const names = m.constructorArgs.map((a) => a.name);
      expect(names).toEqual(["asset_", "oracle_", "name_", "symbol_"]);
    });

    it("PriceOracle → [decimals_, initialAnswer_]", () => {
      const m = manifests.find((x) => x.name === "PriceOracle")!;
      const names = m.constructorArgs.map((a) => a.name);
      expect(names).toEqual(["decimals_", "initialAnswer_"]);
    });

    it("Registry → [admin]", () => {
      const m = manifests.find((x) => x.name === "Registry")!;
      expect(m.constructorArgs[0].name).toBe("admin");
    });
  });

  describe("declaredIn from fixture", () => {
    it("VaultERC4626 own functions have declaredIn='VaultERC4626'", () => {
      const m = manifests.find((x) => x.name === "VaultERC4626")!;
      const ownFns = m.functions.filter((f) => f.declaredIn === "VaultERC4626");
      const names = ownFns.map((f) => f.name);
      expect(names).toContain("assetPrice");
      expect(names).toContain("totalValue");
    });

    it("VaultERC4626 ERC4626-inherited functions have declaredIn='ERC4626'", () => {
      const m = manifests.find((x) => x.name === "VaultERC4626")!;
      const erc4626Fns = m.functions.filter((f) => f.declaredIn === "ERC4626");
      expect(erc4626Fns.length).toBeGreaterThan(0);
    });
  });

  describe("Overloaded contract — fixture-based overload derivation", () => {
    it("Overloaded yields two distinct setLimit entries with correct signatures", () => {
      const m = manifests.find((x) => x.name === "Overloaded")!;
      expect(m).toBeDefined();
      const setLimitFns = m.functions.filter((f) => f.name === "setLimit");
      expect(setLimitFns).toHaveLength(2);
      const sigs = setLimitFns.map((f) => f.signature).sort();
      expect(sigs).toEqual(["setLimit(uint256)", "setLimit(uint256,address)"]);
    });

    it("Overloaded function list has no duplicate signatures (by-signature uniqueness)", () => {
      const m = manifests.find((x) => x.name === "Overloaded")!;
      const sigs = m.functions.map((f) => f.signature);
      const uniqueSigs = new Set(sigs);
      expect(sigs.length).toBe(uniqueSigs.size);
    });

    it("each function entry has a signature field matching name(types) pattern", () => {
      const m = manifests.find((x) => x.name === "Overloaded")!;
      for (const fn of m.functions) {
        expect(fn.signature).toMatch(/^\w+\(.*\)$/);
        expect(fn.signature.startsWith(fn.name + "(")).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// derivePackageSegments unit tests
// ---------------------------------------------------------------------------

describe("derivePackageSegments", () => {
  it("src/ paths → ['src']", () => {
    expect(derivePackageSegments("src/Token.sol")).toEqual(["src"]);
    expect(derivePackageSegments("src/VaultERC4626.sol")).toEqual(["src"]);
  });

  it("OZ contracts/token/ERC20/ → ['@openzeppelin', 'token', 'ERC20']", () => {
    expect(
      derivePackageSegments(
        "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol",
      ),
    ).toEqual(["@openzeppelin", "token", "ERC20"]);
  });

  it("OZ contracts/utils/ → ['@openzeppelin', 'utils']", () => {
    expect(
      derivePackageSegments("lib/openzeppelin-contracts/contracts/utils/Context.sol"),
    ).toEqual(["@openzeppelin", "utils"]);
  });

  it("OZ contracts/utils/introspection/ → ['@openzeppelin', 'utils', 'introspection']", () => {
    expect(
      derivePackageSegments(
        "lib/openzeppelin-contracts/contracts/utils/introspection/ERC165.sol",
      ),
    ).toEqual(["@openzeppelin", "utils", "introspection"]);
  });

  it("OZ contracts/access/ → ['@openzeppelin', 'access']", () => {
    expect(
      derivePackageSegments(
        "lib/openzeppelin-contracts/contracts/access/Ownable.sol",
      ),
    ).toEqual(["@openzeppelin", "access"]);
  });

  it("forge-std paths → ['forge-std']", () => {
    expect(derivePackageSegments("lib/forge-std/src/Test.sol")).toEqual(["forge-std"]);
  });

  it("other lib paths → [libname]", () => {
    expect(derivePackageSegments("lib/some-lib/src/Foo.sol")).toEqual(["some-lib"]);
  });

  it("unknown paths → ['unknown']", () => {
    expect(derivePackageSegments("weirdpath/Foo.sol")).toEqual(["unknown"]);
  });
});


// ---------------------------------------------------------------------------
// MAJOR 1 -- fixture-derived VaultERC4626 inheritance deep-equals full real array
// ---------------------------------------------------------------------------

describe("deriveManifests -- VaultERC4626 full inheritance (fixture)", () => {
  const outputs = fixtureOutputs as unknown as FoundryContractOutput[];
  const manifests = deriveManifests(outputs);

  it("VaultERC4626 fixture-derived inheritance deep-equals full most-derived-first array including interfaces", () => {
    const m = manifests.find((x) => x.name === "VaultERC4626")!;
    expect(m.inheritance).toEqual([
      "VaultERC4626",
      "ERC4626",
      "IERC4626",
      "ERC20",
      "IERC20Errors",
      "IERC20Metadata",
      "IERC20",
      "Context",
    ]);
  });
});

// ---------------------------------------------------------------------------
// MAJOR 2 -- most-derived-wins dedup: decimals resolves to ERC4626, not ERC20
// ---------------------------------------------------------------------------

describe("deriveManifests -- most-derived-wins dedup invariant (fixture)", () => {
  const outputs = fixtureOutputs as unknown as FoundryContractOutput[];
  const manifests = deriveManifests(outputs);

  it("VaultERC4626 decimals.declaredIn is 'ERC4626' (most-derived wins over ERC20)", () => {
    const m = manifests.find((x) => x.name === "VaultERC4626")!;
    const decimals = m.functions.find((f) => f.name === "decimals");
    expect(decimals).toBeDefined();
    expect(decimals!.declaredIn).toBe("ERC4626");
  });
});

// ---------------------------------------------------------------------------
// MINOR 3 -- interface filtering: AggregatorV3Interface excluded from output
// ---------------------------------------------------------------------------

describe("deriveManifests -- interface filtering (fixture)", () => {
  const outputs = fixtureOutputs as unknown as FoundryContractOutput[];
  const manifests = deriveManifests(outputs);

  it("AggregatorV3Interface (contractKind='interface') is excluded from manifests", () => {
    expect(manifests.some((m) => m.name === "AggregatorV3Interface")).toBe(false);
  });

  it("IERC4626 (contractKind='interface') is excluded from manifests", () => {
    expect(manifests.some((m) => m.name === "IERC4626")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Abstract-contract filtering — synthetic outputs
//
// Builds a synthetic Foundry output array containing:
//   (a) a concrete `contract` Concrete (inherits abstract Base),
//   (b) an `abstract` contract Base (declares baseFn), and
//   (c) an `interface` IThing.
// deriveManifests must emit ONLY the concrete contract, while still resolving
// functions inherited from the abstract base (abstract/interface nodes remain
// indexed for resolution).
// ---------------------------------------------------------------------------

describe("deriveManifests -- abstract contract filtering (synthetic)", () => {
  // ids: Concrete=1, Base=2, IThing=3
  const syntheticOutputs: FoundryContractOutput[] = [
    {
      abi: [],
      ast: {
        absolutePath: "src/Concrete.sol",
        nodeType: "SourceUnit",
        nodes: [
          {
            nodeType: "ContractDefinition",
            id: 1,
            name: "Concrete",
            contractKind: "contract",
            // abstract intentionally omitted → treated as concrete (deployable)
            linearizedBaseContracts: [1, 2, 3],
            nodes: [
              {
                nodeType: "FunctionDefinition",
                id: 11,
                kind: "constructor",
                name: "",
                visibility: "public",
                stateMutability: "nonpayable",
                parameters: { parameters: [{ name: "owner_", typeDescriptions: { typeString: "address" } }] },
              },
              {
                nodeType: "FunctionDefinition",
                id: 12,
                kind: "function",
                name: "concreteFn",
                visibility: "public",
                stateMutability: "nonpayable",
                parameters: { parameters: [] },
              },
            ],
          },
        ],
      },
    },
    {
      abi: [],
      ast: {
        absolutePath: "src/Base.sol",
        nodeType: "SourceUnit",
        nodes: [
          {
            nodeType: "ContractDefinition",
            id: 2,
            name: "Base",
            contractKind: "contract",
            abstract: true,
            linearizedBaseContracts: [2, 3],
            nodes: [
              {
                nodeType: "FunctionDefinition",
                id: 21,
                kind: "function",
                name: "baseFn",
                visibility: "external",
                stateMutability: "view",
                parameters: { parameters: [] },
              },
            ],
          },
        ],
      },
    },
    {
      abi: [],
      ast: {
        absolutePath: "src/IThing.sol",
        nodeType: "SourceUnit",
        nodes: [
          {
            nodeType: "ContractDefinition",
            id: 3,
            name: "IThing",
            contractKind: "interface",
            linearizedBaseContracts: [3],
            nodes: [
              {
                nodeType: "FunctionDefinition",
                id: 31,
                kind: "function",
                name: "thing",
                visibility: "external",
                stateMutability: "view",
                parameters: { parameters: [] },
              },
            ],
          },
        ],
      },
    },
  ] as unknown as FoundryContractOutput[];

  const manifests = deriveManifests(syntheticOutputs);

  it("returns only the concrete contract (abstract base + interface excluded)", () => {
    expect(manifests.map((m) => m.name)).toEqual(["Concrete"]);
  });

  it("does not emit the abstract Base contract", () => {
    expect(manifests.some((m) => m.name === "Base")).toBe(false);
  });

  it("does not emit the interface IThing", () => {
    expect(manifests.some((m) => m.name === "IThing")).toBe(false);
  });

  it("still resolves functions inherited from the abstract base onto the concrete contract", () => {
    const concrete = manifests.find((m) => m.name === "Concrete")!;
    const baseFn = concrete.functions.find((f) => f.name === "baseFn");
    expect(baseFn).toBeDefined();
    // The abstract base is still indexed, so declaredIn resolves to its name.
    expect(baseFn!.declaredIn).toBe("Base");
    // The concrete contract's own function is also present.
    expect(concrete.functions.some((f) => f.name === "concreteFn")).toBe(true);
  });

  it("preserves the concrete contract's own constructor args", () => {
    const concrete = manifests.find((m) => m.name === "Concrete")!;
    expect(concrete.constructorArgs).toEqual([{ name: "owner_", type: "address" }]);
  });
});

// ---------------------------------------------------------------------------
// MINOR 4 -- uncovered OZ-root packageSegments branch (dirs.length === 0)
// ---------------------------------------------------------------------------

describe("derivePackageSegments -- OZ root (dirs.length === 0)", () => {
  it("lib/openzeppelin-contracts/contracts/Foo.sol maps to ['@openzeppelin']", () => {
    expect(derivePackageSegments("lib/openzeppelin-contracts/contracts/Foo.sol")).toEqual([
      "@openzeppelin",
    ]);
  });
});

// ---------------------------------------------------------------------------
// MINOR 5 -- types and stateMutability assertions
// ---------------------------------------------------------------------------

describe("deriveManifests -- types and stateMutability (fixture)", () => {
  const outputs = fixtureOutputs as unknown as FoundryContractOutput[];
  const manifests = deriveManifests(outputs);

  it("VaultERC4626 constructorArgs types deep-equal expected", () => {
    const m = manifests.find((x) => x.name === "VaultERC4626")!;
    const types = m.constructorArgs.map((a) => a.type);
    expect(types).toEqual([
      "contract IERC20",
      "contract AggregatorV3Interface",
      "string",
      "string",
    ]);
  });

  it("VaultERC4626 assetPrice function has stateMutability='view' and empty inputs", () => {
    const m = manifests.find((x) => x.name === "VaultERC4626")!;
    const fn = m.functions.find((f) => f.name === "assetPrice");
    expect(fn).toBeDefined();
    expect(fn!.stateMutability).toBe("view");
    expect(fn!.inputs).toEqual([]);
  });

  it("PriceOracle constructorArgs types are ['uint8','int256']", () => {
    const m = manifests.find((x) => x.name === "PriceOracle")!;
    const types = m.constructorArgs.map((a) => a.type);
    expect(types).toEqual(["uint8", "int256"]);
  });

  it("VaultERC4626 totalValue function has stateMutability='view'", () => {
    const m = manifests.find((x) => x.name === "VaultERC4626")!;
    const fn = m.functions.find((f) => f.name === "totalValue");
    expect(fn).toBeDefined();
    expect(fn!.stateMutability).toBe("view");
  });
});

// ---------------------------------------------------------------------------
// Manifest type compatibility check (type assertion compiles cleanly)
// ---------------------------------------------------------------------------

describe("manifest type compatibility", () => {
  it("contractManifest items are assignable to ContractManifest", () => {
    // This is a compile-time check; runtime just verifies the cast works
    const items: ContractManifest[] = contractManifest;
    expect(items).toBe(contractManifest);
  });
});

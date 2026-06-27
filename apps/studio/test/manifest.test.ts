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
  const projectContracts = ["Token", "Vault", "Registry", "PriceOracle", "VaultERC4626"];

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

  it("at least one OZ base contract has packageSegments starting with '@openzeppelin'", () => {
    const ozEntry = contractManifest.find(
      (c) => c.sourcePath.startsWith("lib/openzeppelin-contracts/"),
    );
    expect(ozEntry).toBeDefined();
    expect(ozEntry!.packageSegments[0]).toBe("@openzeppelin");
  });

  it("OZ ERC20 has packageSegments ['@openzeppelin', 'token', 'ERC20']", () => {
    const erc20 = contractManifest.find((c) => c.name === "ERC20");
    expect(erc20).toBeDefined();
    expect(erc20!.packageSegments).toEqual(["@openzeppelin", "token", "ERC20"]);
  });

  it("OZ Context has packageSegments ['@openzeppelin', 'utils']", () => {
    const ctx = contractManifest.find((c) => c.name === "Context");
    expect(ctx).toBeDefined();
    expect(ctx!.packageSegments).toEqual(["@openzeppelin", "utils"]);
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

  it("functions list has no duplicates by name", () => {
    const entry = getContract("VaultERC4626")!;
    const names = entry.functions.map((f) => f.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
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

  it("contains all 5 project contracts from fixture", () => {
    const names = manifests.map((m) => m.name);
    expect(names).toContain("Token");
    expect(names).toContain("Vault");
    expect(names).toContain("Registry");
    expect(names).toContain("PriceOracle");
    expect(names).toContain("VaultERC4626");
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
// Manifest type compatibility check (type assertion compiles cleanly)
// ---------------------------------------------------------------------------

describe("manifest type compatibility", () => {
  it("contractManifest items are assignable to ContractManifest", () => {
    // This is a compile-time check; runtime just verifies the cast works
    const items: ContractManifest[] = contractManifest;
    expect(items).toBe(contractManifest);
  });
});

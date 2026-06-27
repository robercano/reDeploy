/**
 * types.ts
 *
 * Type definitions for the studio contract manifest.
 * The manifest is generated at build time from Foundry compiled output
 * by scripts/gen-manifest.mts and stored as src/manifest/contracts.generated.json.
 */

export interface ConstructorArg {
  name: string;
  type: string;
}

export interface ManifestFunctionInput {
  name: string;
  type: string;
}

export interface ManifestFunction {
  name: string;
  /** The name of the contract that DECLARES this function (for inheritance grouping). */
  declaredIn: string;
  inputs: ManifestFunctionInput[];
  stateMutability: "pure" | "view" | "nonpayable" | "payable";
}

export interface ContractManifest {
  name: string;
  sourcePath: string;
  /**
   * Path segments derived from sourcePath, used for grouping in the UI.
   * Examples:
   *   "src/Foo.sol"                                              → ["src"]
   *   "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol" → ["@openzeppelin","token","ERC20"]
   */
  packageSegments: string[];
  constructorArgs: ConstructorArg[];
  /** From linearizedBaseContracts, most-derived first (index 0 = the contract itself). */
  inheritance: string[];
  functions: ManifestFunction[];
}

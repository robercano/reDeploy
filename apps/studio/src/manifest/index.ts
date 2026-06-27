/**
 * index.ts
 *
 * Typed loader for the studio contract manifest.
 *
 * The manifest (contracts.generated.json) is generated at build time from
 * Foundry compiled output via:
 *
 *   pnpm --filter @redeploy/studio gen:manifest
 *
 * Re-export all types so consumers only need to import from this module.
 */

import generated from "./contracts.generated.json";
import type { ContractManifest } from "./types.js";

export type { ContractManifest, ConstructorArg, ManifestFunction, ManifestFunctionInput } from "./types.js";

export const contractManifest: ContractManifest[] = generated as ContractManifest[];

/**
 * Look up a contract by name. Returns undefined if not found.
 * When multiple contracts share the same name (e.g. from different source paths),
 * returns the first one found in the manifest (typically the project-local one,
 * since manifests are sorted by sourcePath and "src/" sorts before "lib/").
 */
export function getContract(name: string): ContractManifest | undefined {
  return contractManifest.find((c) => c.name === name);
}

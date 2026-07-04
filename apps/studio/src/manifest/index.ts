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
import type { ContractManifest, ManifestFunction } from "./types.js";

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

/**
 * Return the STATE-CHANGING functions (stateMutability "nonpayable" or
 * "payable") declared or inherited by a contract, in manifest order, deduped
 * by canonical signature (overloads are kept as distinct entries).
 *
 * Used by the "Add config call" picker (AddConfigCallMenu) so it lists the
 * target contract's REAL functions instead of a synthetic set. `view`/`pure`
 * functions (and the constructor, which is never part of `.functions`) are
 * excluded because they cannot be the target of a post-deployment config
 * call. Returns an empty array when the contract isn't in the manifest
 * (free-text fallback) — callers should treat that as "no functions
 * available" rather than crashing.
 */
export function getStateChangingFunctions(name: string): ManifestFunction[] {
  const manifest = getContract(name);
  if (!manifest) return [];
  const seen = new Set<string>();
  const result: ManifestFunction[] = [];
  for (const fn of manifest.functions) {
    if (fn.stateMutability !== "nonpayable" && fn.stateMutability !== "payable") continue;
    if (seen.has(fn.signature)) continue;
    seen.add(fn.signature);
    result.push(fn);
  }
  return result;
}

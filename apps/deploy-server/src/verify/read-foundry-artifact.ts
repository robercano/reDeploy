/**
 * Raw Foundry artifact JSON reader for source verification.
 *
 * `@redeploy/core`'s `foundryArtifactResolver` (used for deploys) narrows a
 * Foundry artifact down to `{abi, bytecode}` — exactly what Ignition needs,
 * nothing more. Source verification instead needs the artifact's embedded
 * solc `metadata` (compiler version + source file list), so this module
 * reads the SAME on-disk file directly and returns the full parsed JSON.
 *
 * Mirrors `foundryArtifactResolver`'s path convention
 * (`<outDir>/<Name>.sol/<Name>.json`) and its path-traversal guards, but
 * NEVER throws — a missing/unreadable/invalid-JSON artifact simply means
 * "cannot build a source-verification payload for this contract", which the
 * caller (run-source-verify.ts) surfaces as a per-contract "skipped" result
 * rather than failing the whole batch.
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** Regex that matches valid Solidity contract identifiers (path-traversal guard). */
const VALID_CONTRACT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Read and JSON-parse the Foundry artifact for `contractName` from `outDir`.
 *
 * @returns the parsed JSON (untyped — callers narrow the fields they need),
 *   or `null` on any failure (invalid name, missing file, invalid JSON, or a
 *   resolved path escaping `outDir`). Never throws.
 */
export async function readFoundryArtifactJson(
  outDir: string,
  contractName: string,
): Promise<unknown | null> {
  if (!VALID_CONTRACT_NAME_RE.test(contractName)) {
    return null;
  }

  const resolvedOutDir = resolve(outDir);
  const artifactPath = join(resolvedOutDir, `${contractName}.sol`, `${contractName}.json`);
  const resolvedArtifactPath = resolve(artifactPath);

  // SECURITY: defense-in-depth — mirrors foundryArtifactResolver's guard.
  if (
    resolvedArtifactPath !== resolvedOutDir &&
    !resolvedArtifactPath.startsWith(resolvedOutDir + sep)
  ) {
    return null;
  }

  try {
    const raw = await readFile(artifactPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Foundry artifact resolver for @redeploy/core.
 *
 * Reads compiled artifacts from Foundry's default `out/` layout:
 *   <outDir>/<ContractName>.sol/<ContractName>.json
 *
 * This covers the common case where a Foundry project's contracts are named
 * after their file (e.g., Registry.sol → out/Registry.sol/Registry.json).
 *
 * LIMITATIONS
 * ===========
 * - Contracts with names that differ from their source file name are not
 *   supported by this factory. Use a custom resolver for those.
 * - getBuildInfo() always returns undefined because Foundry's out/ layout
 *   does not include Hardhat-style per-contract build-info JSON files.
 *   Ignition uses build-info for source-level verification but does not
 *   require it for deployment. Pass a custom resolver if you need build-info.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactResolver, Artifact } from "@nomicfoundation/ignition-core";

/**
 * Creates an ArtifactResolver that reads Foundry out/ artifacts.
 *
 * @param outDir - Absolute or relative path to the Foundry output directory
 *   (typically `<project>/out`). Each contract `Foo` must have an artifact at
 *   `<outDir>/Foo.sol/Foo.json`.
 *
 * @returns An ArtifactResolver compatible with deploy()'s `artifactResolver`
 *   option.
 */
export function foundryArtifactResolver(outDir: string): ArtifactResolver {
  return {
    /**
     * Load a compiled Foundry artifact by contract name.
     *
     * Reads `<outDir>/<name>.sol/<name>.json`, parses it, and maps Foundry's
     * output format to Ignition's Artifact type:
     *   - `.abi`                   → `abi`
     *   - `.bytecode.object`       → `bytecode` (0x-prefixed)
     *   - `contractName`           = `name` (the requested contract name)
     *   - `sourceName`             = `<name>.sol`
     *   - `linkReferences`         = `{}` (Foundry links before writing the artifact
     *                                for simple fixtures; library-link cases need a
     *                                custom resolver)
     *
     * @throws Error if the file is missing, contains invalid JSON, or is
     *   missing required fields (abi or bytecode.object).
     */
    async loadArtifact(name: string): Promise<Artifact> {
      const artifactPath = join(outDir, `${name}.sol`, `${name}.json`);

      let raw: string;
      try {
        raw = await readFile(artifactPath, "utf-8");
      } catch (cause) {
        throw new Error(
          `Foundry artifact not found for contract "${name}". ` +
            `Expected file at: ${artifactPath}`,
          { cause },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        throw new Error(
          `Foundry artifact for contract "${name}" contains invalid JSON. ` +
            `File: ${artifactPath}`,
          { cause },
        );
      }

      // Validate the parsed object has the required fields
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("abi" in parsed) ||
        !("bytecode" in parsed) ||
        parsed.bytecode === null ||
        typeof parsed.bytecode !== "object" ||
        !("object" in (parsed.bytecode as object))
      ) {
        throw new Error(
          `Foundry artifact for contract "${name}" is missing required fields ` +
            `(abi or bytecode.object). File: ${artifactPath}`,
        );
      }

      const foundryArtifact = parsed as {
        abi: unknown[];
        bytecode: { object: string };
      };

      const abi = foundryArtifact.abi;
      const rawBytecode = foundryArtifact.bytecode.object;

      if (!Array.isArray(abi)) {
        throw new Error(
          `Foundry artifact for contract "${name}" has an invalid abi field ` +
            `(expected array). File: ${artifactPath}`,
        );
      }

      if (typeof rawBytecode !== "string" || rawBytecode.length === 0) {
        throw new Error(
          `Foundry artifact for contract "${name}" has an invalid bytecode.object field ` +
            `(expected non-empty string). File: ${artifactPath}`,
        );
      }

      // Ensure bytecode is 0x-prefixed as Ignition and ethers expect
      const bytecode = rawBytecode.startsWith("0x") ? rawBytecode : `0x${rawBytecode}`;

      return {
        contractName: name,
        sourceName: `${name}.sol`,
        abi,
        bytecode,
        linkReferences: {},
      };
    },

    /**
     * Returns undefined for all contracts.
     *
     * Foundry's out/ layout does not include Hardhat-style per-contract
     * build-info JSON blobs (those live in Hardhat's artifacts/build-info/
     * directory). Ignition uses build-info only for optional Etherscan
     * source verification, not for deployment. Pass a custom resolver that
     * reads Foundry's build-info equivalent if you need source verification.
     */
    async getBuildInfo(): Promise<undefined> {
      return undefined;
    },
  };
}

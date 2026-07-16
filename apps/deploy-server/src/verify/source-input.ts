/**
 * Assemble an Etherscan `solidity-standard-json-input` payload from a Foundry
 * artifact's embedded solc metadata.
 *
 * WHY THIS IS NEEDED
 * ===================
 * Foundry's per-contract artifact (`out/<Name>.sol/<Name>.json`) embeds the
 * full solc OUTPUT metadata under `.metadata`, including `compiler.version`
 * and a `sources` map listing every source file (own + transitive imports)
 * by project-relative path. By default Foundry's `sources` entries carry only
 * `keccak256`/`urls`/`license` — NOT literal file content — because
 * `metadata.useLiteralContent` is off by default.
 *
 * Etherscan's `codeformat=solidity-standard-json-input` instead needs a
 * genuine solc STANDARD-JSON-INPUT: `{language, sources: {path: {content}},
 * settings}`. This module reassembles that by reading each listed source
 * file's literal content directly off disk (relative to the Foundry project
 * root, i.e. the directory containing `src/`, `lib/`, and `out/`), reusing
 * `metadata.settings` (optimizer, remappings, compilationTarget, evmVersion,
 * libraries, etc.) as-is so the reconstructed input matches what solc was
 * actually invoked with.
 *
 * FAILURE MODE
 * ============
 * Never throws. Returns `null` when the artifact has no metadata/sources, any
 * listed file cannot be read, or a listed path would resolve outside
 * `contractsRoot` (defense-in-depth). Callers (run-source-verify.ts) treat a
 * `null` result as "skip this contract" rather than failing the whole batch.
 */

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface SourceInputResult {
  readonly sourceCode: string;
  readonly compilerVersion: string;
  readonly codeFormat: "solidity-standard-json-input";
}

interface FoundryMetadataSource {
  readonly content?: string;
}

interface FoundryMetadata {
  readonly language?: string;
  readonly compiler?: { readonly version?: string };
  readonly sources?: Readonly<Record<string, FoundryMetadataSource>>;
  readonly settings?: Readonly<Record<string, unknown>>;
}

interface FoundryArtifactJson {
  readonly metadata?: FoundryMetadata;
}

function isFoundryArtifactJson(value: unknown): value is FoundryArtifactJson {
  return typeof value === "object" && value !== null;
}

/**
 * Build a standard-json-input `sourceCode` string (+ compiler version) for
 * Etherscan verification, reading every listed source file's content from
 * `contractsRoot` (the Foundry project root — typically `path.dirname(outDir)`).
 */
export function buildStandardJsonInput(
  artifactJson: unknown,
  contractsRoot: string,
): SourceInputResult | null {
  if (!isFoundryArtifactJson(artifactJson)) return null;

  const metadata = artifactJson.metadata;
  if (!metadata || typeof metadata !== "object") return null;

  const sourcesMeta = metadata.sources;
  if (!sourcesMeta || typeof sourcesMeta !== "object") return null;

  const sourcePaths = Object.keys(sourcesMeta);
  if (sourcePaths.length === 0) return null;

  const compilerVersionRaw = metadata.compiler?.version;
  if (typeof compilerVersionRaw !== "string" || compilerVersionRaw.trim() === "") return null;

  const resolvedRoot = resolve(contractsRoot);
  const sources: Record<string, { content: string }> = {};

  for (const relPath of sourcePaths) {
    const abs = resolve(resolvedRoot, relPath);
    // SECURITY: reject any source path that resolves outside contractsRoot
    // (defense-in-depth against a crafted/unexpected artifact).
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + sep)) {
      return null;
    }
    try {
      sources[relPath] = { content: readFileSync(abs, "utf8") };
    } catch {
      return null;
    }
  }

  const compilerVersion = compilerVersionRaw.startsWith("v")
    ? compilerVersionRaw
    : `v${compilerVersionRaw}`;

  const standardInput = {
    language: metadata.language ?? "Solidity",
    sources,
    settings: metadata.settings ?? {},
  };

  return {
    sourceCode: JSON.stringify(standardInput),
    compilerVersion,
    codeFormat: "solidity-standard-json-input",
  };
}

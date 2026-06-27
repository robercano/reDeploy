/**
 * gen-manifest.mts
 *
 * Generates apps/studio/src/manifest/contracts.generated.json from
 * Foundry compiled output. Run via:
 *
 *   pnpm --filter @redeploy/studio gen:manifest
 *
 * What this script does:
 *   1. Runs `forge build --ast` in the contracts directory.
 *      If forge is absent (ENOENT), logs a warning and proceeds with existing
 *      Foundry output files (graceful degradation for forge-less CI).
 *   2. Reads all Foundry contract output JSON files from contracts/out/**\/*.json
 *      (excluding build-info/ and test files ending in .t.sol/).
 *      Each file has { abi, ast } where ast.absolutePath is the source path.
 *   3. Calls deriveManifests() (pure function in src/manifest/derive.ts) to
 *      compute ContractManifest[] from the AST + ABI data.
 *   4. Writes the result to src/manifest/contracts.generated.json.
 *
 * Graceful degradation:
 *   - If forge is not available, existing out/ files are reused.
 *   - If no out/ directory exists at all (fresh checkout without build artifacts),
 *     the script SKIPS generation and leaves the committed JSON untouched,
 *     so `pnpm build` still works in forge-less CI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveManifests } from "../src/manifest/derive.js";
import type { FoundryContractOutput } from "../src/manifest/derive.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths (relative to this script's location: apps/studio/scripts/)
const studioDir = resolve(__dirname, "..");
const contractsDir = resolve(__dirname, "../../../contracts");
const outDir = join(contractsDir, "out");
const outputFile = join(studioDir, "src", "manifest", "contracts.generated.json");

// ---------------------------------------------------------------------------
// Step 1: Run forge build --ast (graceful degradation if forge absent)
// ---------------------------------------------------------------------------

if (!existsSync(outDir)) {
  // No out/ directory at all — skip generation (forge-less CI with committed JSON)
  console.log(
    "[gen-manifest] No contracts/out directory found. Skipping manifest generation (using committed JSON).",
  );
  process.exit(0);
}

try {
  const result = spawnSync("forge", ["build", "--ast"], {
    cwd: contractsDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  if (result.error) {
    // ENOENT or similar — forge not available
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.warn(
        "[gen-manifest] WARNING: forge not found. Reusing existing contracts/out/ files.",
      );
    } else {
      console.warn(
        `[gen-manifest] WARNING: forge spawn failed (${err.message}). Reusing existing contracts/out/ files.`,
      );
    }
  } else if (result.status !== 0) {
    console.warn(
      `[gen-manifest] WARNING: forge build exited with status ${result.status}. Reusing existing contracts/out/ files.`,
    );
    if (result.stderr) {
      console.warn(result.stderr);
    }
  } else {
    console.log("[gen-manifest] forge build --ast succeeded.");
  }
} catch (err) {
  console.warn(`[gen-manifest] WARNING: forge build error: ${String(err)}. Proceeding with existing files.`);
}

// ---------------------------------------------------------------------------
// Step 2: Read all contract output JSON files from contracts/out/
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .json files under a directory,
 * excluding a directory named 'build-info'.
 */
function collectJsonFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry === "build-info") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Skip test output directories (*.t.sol)
      if (entry.endsWith(".t.sol")) continue;
      results.push(...collectJsonFiles(fullPath));
    } else if (entry.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

const jsonFiles = collectJsonFiles(outDir);

if (jsonFiles.length === 0) {
  console.warn("[gen-manifest] No contract output files found in contracts/out/. Skipping generation.");
  process.exit(0);
}

console.log(`[gen-manifest] Reading ${jsonFiles.length} contract output files...`);

const outputs: FoundryContractOutput[] = [];

for (const filePath of jsonFiles) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    // Must have an ast field with absolutePath and nodes
    if (
      typeof data === "object" &&
      data !== null &&
      "ast" in data &&
      typeof data.ast === "object" &&
      data.ast !== null &&
      "absolutePath" in (data.ast as Record<string, unknown>)
    ) {
      outputs.push(data as unknown as FoundryContractOutput);
    }
  } catch {
    // Skip malformed files
  }
}

if (outputs.length === 0) {
  console.warn("[gen-manifest] No valid contract outputs found. Skipping generation.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 3: Derive manifests
// ---------------------------------------------------------------------------

console.log(`[gen-manifest] Deriving manifests from ${outputs.length} source files...`);

const manifests = deriveManifests(outputs);

console.log(`[gen-manifest] Generated ${manifests.length} contract manifests.`);

// ---------------------------------------------------------------------------
// Step 4: Write output JSON (pretty-printed, stable order, trailing newline)
// ---------------------------------------------------------------------------

const json = JSON.stringify(manifests, null, 2) + "\n";
writeFileSync(outputFile, json, "utf-8");

console.log(`[gen-manifest] Written to ${outputFile}`);

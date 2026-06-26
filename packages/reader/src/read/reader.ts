/**
 * Read-only deployment and configuration state reader for @redeploy/reader.
 *
 * DESIGN
 * ======
 *
 * This module reads deployment and config state from an on-disk directory
 * produced by the reDeploy pipeline:
 *   - `<deploymentDir>/deployed_addresses.json` — Ignition-written map of
 *     futureId → deployed address.
 *   - `<deploymentDir>/journal.jsonl` — Ignition's append-only journal.
 *   - `<configStateDir>/config-state.jsonl` — @redeploy/config's completion
 *     journal (NDJSON, one record per completed step).
 *
 * WHY WE PARSE IGNITION FILES DIRECTLY (not via Ignition's public status() API)
 * ==============================================================================
 *
 * Ignition's public `status()` call (from @nomicfoundation/ignition-core):
 *   1. Requires per-future artifact JSON files on disk and throws when they are
 *      absent — making it unusable in chain-free, fixture-based tests and
 *      read-only contexts where artifact files are not present.
 *   2. Does NOT expose constructorArgs or libraries — both required by this API.
 *
 * Instead we read `deployed_addresses.json` and `journal.jsonl` directly,
 * reusing Ignition's on-disk FILE FORMAT and its bigint (de)serialization
 * semantics without importing its runtime. We use string literal constants
 * matching Ignition's JournalMessageType enum values (e.g.
 * "DEPLOYMENT_EXECUTION_STATE_INITIALIZE") for message dispatch, keeping
 * @nomicfoundation/ignition-core as a type-only dev dependency for
 * documentation purposes while leaving the full runtime out of the execution
 * path.
 *
 * BIGINT NORMALIZATION
 * ====================
 *
 * Ignition serializes bigints to the journal in TWO forms:
 *   - Object form: `{ "_kind": "bigint", "value": "<decimal-digits>" }`
 *     (produced by serializeReplacer for standard bigint fields like `value`).
 *   - String form: `"<decimal-digits>n"` (sometimes written for parameters).
 *
 * Since our public API must be JSON-safe and `any`-free, we normalize both
 * forms into `{ "$bigint": "<decimal-digits>" }` — a stable, serializable
 * representation typed as `BigIntValue` in ArgValue.
 *
 * CONFIG JOURNAL
 * ==============
 *
 * @redeploy/config writes config-state.jsonl as standard NDJSON (one JSON
 * object per line, lines terminated by \n). We parse it directly here —
 * do NOT import @redeploy/config at runtime to preserve the dependency
 * direction rule (reader → core only; no reader → config cycle).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ReadError } from "./errors.js";

// ---------------------------------------------------------------------------
// Re-export errors for convenience
// ---------------------------------------------------------------------------
export { ReadError } from "./errors.js";
export type { ReadErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// ArgValue — a recursive JSON-safe union, no `any`.
// ---------------------------------------------------------------------------

/**
 * A normalized bigint value extracted from the Ignition journal.
 * The decimal string representation is stored in `$bigint`.
 *
 * @example `{ "$bigint": "1000000000000000000" }` represents 1 ETH in wei.
 */
export interface BigIntValue {
  readonly $bigint: string;
}

/**
 * A recursive, JSON-safe union for constructor argument values read from the
 * Ignition journal. No `any` on the public surface.
 *
 * Mapping from Ignition's SolidityParameterType:
 *   - `string`  → `string`
 *   - `number`  → `number`
 *   - `boolean` → `boolean`
 *   - `bigint`  → `BigIntValue` (normalized from both Ignition bigint forms)
 *   - `null`    → `null`
 *   - Array     → `ReadonlyArray<ArgValue>`
 *   - Object    → `{ readonly [k: string]: ArgValue }`
 */
export type ArgValue =
  | string
  | number
  | boolean
  | null
  | BigIntValue
  | ReadonlyArray<ArgValue>
  | { readonly [k: string]: ArgValue };

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Links from a contract to its dependencies and Solidity libraries. */
export interface ContractLinks {
  /**
   * Spec ids of other contracts this contract depends on (from
   * `dependencies` in the DEPLOYMENT_EXECUTION_STATE_INITIALIZE record,
   * prefix-stripped to spec ids).
   */
  readonly dependencies: ReadonlyArray<string>;
  /**
   * Solidity library name → address (or spec id if the library is another
   * deployed contract in the same module, prefix-stripped).
   */
  readonly libraries: Readonly<Record<string, string>>;
}

/**
 * A single deployed contract as read from the Ignition journal and/or
 * deployed_addresses.json.
 */
export interface ContractView {
  /** Spec id (the part after `<moduleId>#` in the Ignition futureId). */
  readonly id: string;
  /** Solidity contract name (from the INITIALIZE journal record). */
  readonly contractName: string;
  /**
   * Deployed address. `null` if the contract was initialized but never
   * completed (partial deployment) and is absent from deployed_addresses.json.
   */
  readonly address: string | null;
  /** Constructor arguments, normalized (bigints → BigIntValue). */
  readonly args: ReadonlyArray<ArgValue>;
  /** Links: inter-contract dependencies and Solidity library links. */
  readonly links: ContractLinks;
}

/** Completion status for a config step read from config-state.jsonl. */
export interface ConfigStepStatus {
  /** The step id. */
  readonly id: string;
  /** The step kind at the time of completion (e.g. "functionCall"). */
  readonly kind: string;
  /** True iff a completion record for this step was found in the journal. */
  readonly completed: boolean;
  /**
   * ISO-8601 timestamp of when the step was marked complete, or `null` if not
   * yet completed or if `expectedConfigStepIds` listed it as expected but it is
   * absent from the journal.
   */
  readonly completedAt: string | null;
}

/**
 * The full view of a deployment as read from disk. Fully read-only.
 *
 * `warnings` lists lines that were skipped during journal parsing (malformed
 * JSON, missing required fields, etc.). Non-empty warnings do NOT indicate
 * failure — the valid records are still returned.
 */
export interface DeploymentView {
  readonly contracts: ReadonlyArray<ContractView>;
  readonly configSteps: ReadonlyArray<ConfigStepStatus>;
  /**
   * Human-readable descriptions of journal lines that were skipped due to
   * parse errors or missing required fields.
   */
  readonly warnings: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for readDeployment().
 */
export interface ReadDeploymentOptions {
  /**
   * Directory where `journal.jsonl` and `deployed_addresses.json` live.
   * Must exist and be a directory — throws ReadError("DEPLOYMENT_DIR_NOT_FOUND")
   * otherwise.
   */
  deploymentDir: string;
  /**
   * Directory where `config-state.jsonl` lives. Defaults to `deploymentDir`.
   */
  configStateDir?: string;
  /**
   * The Ignition module id used as the prefix on futureIds (e.g. "Deployment").
   * If omitted, the prefix is inferred from the first futureId encountered in
   * the journal (everything before the first `#`).
   */
  moduleId?: string;
  /**
   * Optional list of config step ids that are expected to exist. Steps that
   * appear here but are absent from config-state.jsonl are included in
   * `configSteps` with `completed: false` and `completedAt: null`. Steps NOT
   * in this list but present in the journal are still included.
   *
   * If omitted, only steps that appear in the journal are reported.
   */
  expectedConfigStepIds?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPLOYED_ADDRESSES_FILE = "deployed_addresses.json";
const JOURNAL_FILE = "journal.jsonl";
const CONFIG_STATE_FILE = "config-state.jsonl";

// Journal message type constants (string literals matching Ignition's enum)
// We use string literals instead of importing the enum to avoid any runtime
// dependency on @nomicfoundation/ignition-core.
const MSG_DEPLOY_EXECUTION_STATE_INIT = "DEPLOYMENT_EXECUTION_STATE_INITIALIZE";
const MSG_DEPLOY_EXECUTION_STATE_COMPLETE = "DEPLOYMENT_EXECUTION_STATE_COMPLETE";
const EXECUTION_RESULT_SUCCESS = "SUCCESS";

// ---------------------------------------------------------------------------
// Bigint normalization
// ---------------------------------------------------------------------------

/**
 * Detect and normalize Ignition's two bigint serialization forms into
 * `{ $bigint: "<decimal>" }`.
 *
 * Form 1 (string): `"<digits>n"` — e.g. `"1000000000000000000n"`
 * Form 2 (object): `{ "_kind": "bigint", "value": "<digits>" }`
 */
function isBigIntString(v: unknown): v is string {
  return typeof v === "string" && /^\d+n$/.test(v);
}

function isSerializedBigIntObject(v: unknown): v is { _kind: "bigint"; value: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "_kind" in v &&
    (v as Record<string, unknown>)["_kind"] === "bigint" &&
    "value" in v &&
    typeof (v as Record<string, unknown>)["value"] === "string"
  );
}

/**
 * Recursively normalize an unknown value from the Ignition journal into an
 * `ArgValue`. Returns `null` for truly unrecognized shapes.
 */
function normalizeArg(v: unknown): ArgValue {
  if (v === null) return null;
  if (isBigIntString(v)) {
    return { $bigint: v.slice(0, -1) };
  }
  if (isSerializedBigIntObject(v)) {
    return { $bigint: v.value };
  }
  if (typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    return v.map(normalizeArg);
  }
  if (typeof v === "object") {
    // Use a null-prototype object to prevent prototype pollution when writing
    // untrusted journal keys. Skip the three well-known dangerous key names
    // that could be used to pollute Object.prototype or Function.prototype.
    const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    const out = Object.create(null) as Record<string, ArgValue>;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = normalizeArg(val);
    }
    return out;
  }
  // Fallback for any other primitive (bigint at runtime, symbol, etc.)
  return String(v);
}

// ---------------------------------------------------------------------------
// Prefix stripping
// ---------------------------------------------------------------------------

/**
 * Strip the `<moduleId>#` prefix from a futureId to recover the spec id.
 * Splits on the FIRST `#` only — mirrors packages/core/src/deploy/deploy.ts.
 */
function stripPrefix(futureId: string, prefix: string): string {
  return futureId.startsWith(prefix) ? futureId.slice(prefix.length) : futureId;
}

/**
 * Infer `<moduleId>#` prefix from a futureId (everything up to and including
 * the first `#`). Returns an empty string if there is no `#`.
 */
function inferPrefix(futureId: string): string {
  const idx = futureId.indexOf("#");
  return idx === -1 ? "" : futureId.slice(0, idx + 1);
}

// ---------------------------------------------------------------------------
// Journal parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw unknown object that claims to be a DEPLOYMENT_EXECUTION_STATE_INITIALIZE
 * message. Returns the relevant fields or `null` if required fields are missing.
 */
interface InitMessage {
  futureId: string;
  contractName: string;
  constructorArgs: unknown[];
  libraries: Record<string, string>;
  dependencies: string[];
}

function parseInitMessage(obj: Record<string, unknown>): InitMessage | null {
  if (typeof obj["futureId"] !== "string") return null;
  if (typeof obj["contractName"] !== "string") return null;
  if (!Array.isArray(obj["constructorArgs"])) return null;

  // libraries: Record<string, string>
  const libs = obj["libraries"];
  const librariesMap: Record<string, string> = {};
  if (typeof libs === "object" && libs !== null && !Array.isArray(libs)) {
    for (const [k, v] of Object.entries(libs as Record<string, unknown>)) {
      if (typeof v === "string") librariesMap[k] = v;
    }
  }

  // dependencies: string[]
  const rawDeps = obj["dependencies"];
  const dependencies: string[] = [];
  if (Array.isArray(rawDeps)) {
    for (const d of rawDeps) {
      if (typeof d === "string") dependencies.push(d);
    }
  }

  return {
    futureId: obj["futureId"] as string,
    contractName: obj["contractName"] as string,
    constructorArgs: obj["constructorArgs"] as unknown[],
    libraries: librariesMap,
    dependencies,
  };
}

/**
 * Parse a raw unknown object that claims to be a DEPLOYMENT_EXECUTION_STATE_COMPLETE
 * message. Returns `{ futureId, address }` or `null` if the message is missing
 * required fields or result is not a success.
 */
interface CompleteMessage {
  futureId: string;
  address: string;
}

function parseCompleteMessage(obj: Record<string, unknown>): CompleteMessage | null {
  if (typeof obj["futureId"] !== "string") return null;
  const result = obj["result"];
  if (typeof result !== "object" || result === null) return null;
  const res = result as Record<string, unknown>;
  if (res["type"] !== EXECUTION_RESULT_SUCCESS) return null;
  if (typeof res["address"] !== "string") return null;
  return { futureId: obj["futureId"] as string, address: res["address"] as string };
}

// ---------------------------------------------------------------------------
// Main reader implementation
// ---------------------------------------------------------------------------

/**
 * Read deployment and configuration state from disk.
 *
 * @param options - See ReadDeploymentOptions.
 * @returns A DeploymentView with contracts, configSteps, and warnings.
 *
 * @throws ReadError with code "DEPLOYMENT_DIR_NOT_FOUND" if deploymentDir does
 *         not exist or is not a directory.
 * @throws ReadError with code "JOURNAL_READ_ERROR" if journal.jsonl exists but
 *         cannot be read (e.g. permission denied).
 * @throws ReadError with code "CONFIG_JOURNAL_READ_ERROR" if config-state.jsonl
 *         exists but cannot be read (e.g. permission denied).
 */
export function readDeployment(options: ReadDeploymentOptions): DeploymentView {
  const { deploymentDir, moduleId, expectedConfigStepIds } = options;
  const configStateDir = options.configStateDir ?? deploymentDir;

  // --- 1. Validate deploymentDir exists --------------------------------------
  try {
    const stat = fs.statSync(deploymentDir);
    if (!stat.isDirectory()) {
      throw new ReadError(
        "DEPLOYMENT_DIR_NOT_FOUND",
        `deploymentDir is not a directory: "${deploymentDir}"`,
      );
    }
  } catch (err) {
    if (err instanceof ReadError) throw err;
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new ReadError(
        "DEPLOYMENT_DIR_NOT_FOUND",
        `Deployment directory not found: "${deploymentDir}"`,
      );
    }
    throw new ReadError(
      "DEPLOYMENT_DIR_NOT_FOUND",
      `Cannot access deployment directory "${deploymentDir}": ${nodeErr.message}`,
    );
  }

  const warnings: string[] = [];

  // --- 2. Read deployed_addresses.json (primary address source) ---------------
  const deployedAddressesPath = path.join(deploymentDir, DEPLOYED_ADDRESSES_FILE);
  const deployedAddresses = readDeployedAddresses(deployedAddressesPath, warnings);

  // --- 3. Parse journal.jsonl -------------------------------------------------
  const journalPath = path.join(deploymentDir, JOURNAL_FILE);
  const { contracts } = parseJournal(
    journalPath,
    moduleId,
    deployedAddresses,
    warnings,
  );

  // --- 4. Parse config-state.jsonl -------------------------------------------
  const configStatePath = path.join(configStateDir, CONFIG_STATE_FILE);
  const configSteps = parseConfigJournal(
    configStatePath,
    expectedConfigStepIds,
    warnings,
  );

  return { contracts, configSteps, warnings };
}

// ---------------------------------------------------------------------------
// deployed_addresses.json reader
// ---------------------------------------------------------------------------

function readDeployedAddresses(
  filePath: string,
  warnings: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return result; // file absent is fine
    warnings.push(
      `Could not read ${DEPLOYED_ADDRESSES_FILE}: ${nodeErr.message}`,
    );
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`Could not parse ${DEPLOYED_ADDRESSES_FILE}: invalid JSON`);
    return result;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${DEPLOYED_ADDRESSES_FILE}: expected a JSON object at root`);
    return result;
  }

  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") {
      result.set(k, v);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// journal.jsonl parser
// ---------------------------------------------------------------------------

interface JournalParseResult {
  contracts: ReadonlyArray<ContractView>;
  /**
   * The module prefix inferred/detected during journal parsing (e.g.
   * "Deployment#"). Used to strip config step ids if needed.
   */
  inferredPrefix: string;
}

function parseJournal(
  journalPath: string,
  explicitModuleId: string | undefined,
  deployedAddresses: Map<string, string>,
  warnings: string[],
): JournalParseResult {
  // --- Read the raw file -------------------------------------------------------
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // No journal — return empty (happens in fresh or missing state).
      return { contracts: [], inferredPrefix: "" };
    }
    throw new ReadError(
      "JOURNAL_READ_ERROR",
      `Failed to read journal at "${journalPath}": ${nodeErr.message}`,
    );
  }

  // --- Split on \n, skip blank lines ------------------------------------------
  // Ignition writes: \n + JSON.stringify(record) — so the file starts with a
  // blank line and records are separated by \n with no trailing newline.
  const lines = raw.split("\n");

  // Maps from spec id → data accumulated across messages
  // We use Map to preserve insertion order (first INIT sets the order).
  const initMessages = new Map<string, InitMessage>();
  // futureId → address from COMPLETE messages (fallback for missing deployed_addresses)
  const completeAddresses = new Map<string, string>();

  let inferredPrefix = explicitModuleId != null ? `${explicitModuleId}#` : "";

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim();
    if (line === "") continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      warnings.push(`journal.jsonl line ${lineIdx + 1}: invalid JSON — skipped`);
      continue;
    }

    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      warnings.push(`journal.jsonl line ${lineIdx + 1}: expected JSON object — skipped`);
      continue;
    }

    const record = obj as Record<string, unknown>;
    const type = record["type"];

    if (type === MSG_DEPLOY_EXECUTION_STATE_INIT) {
      const msg = parseInitMessage(record);
      if (msg === null) {
        warnings.push(
          `journal.jsonl line ${lineIdx + 1}: DEPLOYMENT_EXECUTION_STATE_INITIALIZE has missing required fields — skipped`,
        );
        continue;
      }
      // Infer prefix from first futureId seen if not provided
      if (inferredPrefix === "") {
        inferredPrefix = inferPrefix(msg.futureId);
      }
      const specId = stripPrefix(msg.futureId, inferredPrefix);
      // Only keep the first INITIALIZE for each specId (idempotent)
      if (!initMessages.has(specId)) {
        initMessages.set(specId, msg);
      }
    } else if (type === MSG_DEPLOY_EXECUTION_STATE_COMPLETE) {
      const msg = parseCompleteMessage(record);
      if (msg !== null) {
        // Infer prefix if not yet set
        if (inferredPrefix === "") {
          inferredPrefix = inferPrefix(msg.futureId);
        }
        completeAddresses.set(msg.futureId, msg.address);
      }
    }
    // All other message types are silently ignored.
  }

  // --- Build ContractView array -----------------------------------------------
  const contracts: ContractView[] = [];

  for (const [specId, msg] of initMessages) {
    const futureId = msg.futureId;

    // Prefer deployed_addresses.json, fall back to COMPLETE message address.
    const addressFromDeployed = deployedAddresses.get(futureId);
    const addressFromComplete = completeAddresses.get(futureId);
    const address = addressFromDeployed ?? addressFromComplete ?? null;

    // Normalize constructor args
    const args: ArgValue[] = msg.constructorArgs.map(normalizeArg);

    // Build links:
    //   - dependencies: futureIds → strip prefix → spec ids
    //   - libraries: name → address or futureId → strip prefix if it looks like a futureId
    const dependencies = msg.dependencies.map((dep) => stripPrefix(dep, inferredPrefix));

    const librariesNormalized: Record<string, string> = {};
    for (const [libName, libRef] of Object.entries(msg.libraries)) {
      // libRef may be an address (0x...) or a futureId (moduleId#id)
      // Strip prefix from futureIds so callers get spec ids.
      librariesNormalized[libName] = stripPrefix(libRef, inferredPrefix);
    }

    contracts.push({
      id: specId,
      contractName: msg.contractName,
      address,
      args,
      links: {
        dependencies,
        libraries: librariesNormalized,
      },
    });
  }

  return { contracts, inferredPrefix };
}

// ---------------------------------------------------------------------------
// config-state.jsonl parser
// ---------------------------------------------------------------------------

interface RawConfigRecord {
  id: string;
  kind: string;
  completedAt: string;
}

function isValidConfigRecord(obj: unknown): obj is RawConfigRecord {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    r["id"] !== "" &&
    typeof r["kind"] === "string" &&
    typeof r["completedAt"] === "string"
  );
}

function parseConfigJournal(
  filePath: string,
  expectedConfigStepIds: ReadonlyArray<string> | undefined,
  warnings: string[],
): ReadonlyArray<ConfigStepStatus> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // Fresh state — no steps completed
      raw = "";
    } else {
      throw new ReadError(
        "CONFIG_JOURNAL_READ_ERROR",
        `Failed to read config-state journal at "${filePath}": ${nodeErr.message}`,
      );
    }
  }

  // Parse journaled completions (NDJSON — one record per line, \n-terminated)
  const completedMap = new Map<string, RawConfigRecord>();
  const lines = raw.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim();
    if (line === "") continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      warnings.push(`config-state.jsonl line ${lineIdx + 1}: invalid JSON — skipped`);
      continue;
    }

    if (!isValidConfigRecord(obj)) {
      warnings.push(
        `config-state.jsonl line ${lineIdx + 1}: missing required fields (id/kind/completedAt) — skipped`,
      );
      continue;
    }

    // Keep the last record for a given id (most recent completion wins)
    completedMap.set(obj.id, obj);
  }

  // Build output: start with all journaled completions
  const resultMap = new Map<string, ConfigStepStatus>();

  for (const [id, record] of completedMap) {
    resultMap.set(id, {
      id,
      kind: record.kind,
      completed: true,
      completedAt: record.completedAt,
    });
  }

  // Overlay expected-but-absent steps
  if (expectedConfigStepIds != null) {
    for (const expectedId of expectedConfigStepIds) {
      if (!resultMap.has(expectedId)) {
        resultMap.set(expectedId, {
          id: expectedId,
          kind: "",
          completed: false,
          completedAt: null,
        });
      }
    }
  }

  return Array.from(resultMap.values());
}

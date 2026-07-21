/**
 * Address book exporter for @redeploy/reader.
 *
 * DESIGN
 * ======
 *
 * `exportAddressBook()` takes one or more `DeploymentSnapshot`s (see
 * `../snapshot/snapshot.ts`) plus optional caller-supplied ABIs and returns a
 * deterministic, JSON-safe `AddressBookArtifact` bundling:
 *   - `json` — a pretty-printed address book keyed by chain id, then contract
 *     id, suitable for persisting to disk (e.g. `address-book.json`).
 *   - `ts` / `dts` — a typed TS module (`export const addresses = {...} as
 *     const;`) and matching `.d.ts` declarations, so downstream consumers get
 *     compile-time-checked access like `addresses[1].MyContract.address`.
 *   - `packageFiles` — when `packageName` is supplied, a minimal publishable
 *     package scaffold (`package.json` + compiled `index.js` + `index.d.ts`)
 *     wrapping the same data.
 *
 * This module is READ-ONLY / PURE by design, matching the rest of
 * @redeploy/reader: it performs NO filesystem writes. Persisting any of the
 * returned strings to disk is the caller's responsibility.
 *
 * SNAPSHOTS DO NOT CARRY ABIs
 * ===========================
 *
 * `DeploymentSnapshot` deliberately excludes ABIs (see `../snapshot/snapshot.ts`).
 * ABIs are therefore an OPTIONAL caller-supplied input here (`options.abis`,
 * keyed by Solidity contract name) — this module never reads Foundry
 * artifacts or imports ignition-core at runtime.
 *
 * DETERMINISM
 * ============
 *
 * Given identical inputs, `exportAddressBook()` returns byte-identical
 * `json`/`ts`/`dts`/`packageFiles` strings, regardless of input ordering:
 *   - Chain id keys are sorted ascending numerically.
 *   - Contract id keys (within a chain) are sorted ascending via
 *     `localeCompare`.
 *   - Entry fields are always emitted in a fixed order: `address`,
 *     `contractName`, `chainId`, `network` (omitted if the snapshot has none),
 *     `deployedAt`, `abi` (omitted unless supplied via `options.abis`).
 *
 * SKIPPED / CONFLICTING CONTRACTS
 * =================================
 *
 * - Contracts with `address: null` (not yet completed) are excluded from the
 *   address book entirely — an address book only records deployed addresses.
 *   A single combined warning lists everything skipped this way.
 * - If the SAME `(chainId, contractId)` pair appears in more than one input
 *   snapshot with a DIFFERENT address, the FIRST occurrence wins (subsequent
 *   snapshots are processed in `options.snapshots` array order) and a warning
 *   is recorded describing the conflict. Duplicate entries with an IDENTICAL
 *   address never produce a warning.
 */

import type { ContractView } from "../read/reader.js";
import type { DeploymentSnapshot } from "../snapshot/snapshot.js";

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/**
 * A single address book entry: the deployed address of one contract on one
 * chain, plus enough metadata to be useful standalone (contract name, chain
 * id, optional network label, when it was recorded, and an optional ABI).
 *
 * Field order is significant for deterministic serialization — see the
 * module-level doc comment.
 */
export interface AddressBookEntry {
  /** Deployed address. Always present — null-address contracts are excluded. */
  readonly address: string;
  /** Solidity contract name. */
  readonly contractName: string;
  /** Chain id this entry was deployed on. */
  readonly chainId: number;
  /** Optional human-readable network label (e.g. "sepolia", "mainnet"). */
  readonly network?: string;
  /** `takenAt` of the snapshot this entry was recorded from (ISO-8601). */
  readonly deployedAt: string;
  /**
   * Viem-ready ABI, embedded verbatim from `options.abis[contractName]` when
   * supplied. Omitted entirely (not `null`) when no ABI was supplied for this
   * contract name.
   */
  readonly abi?: unknown;
}

/**
 * The address book data model: chain id (as a string key) → contract id →
 * `AddressBookEntry`. This is exactly the shape serialized into `json`/`ts`.
 */
export type AddressBookData = Readonly<Record<string, Readonly<Record<string, AddressBookEntry>>>>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for `exportAddressBook()`. */
export interface ExportAddressBookOptions {
  /** One or more deployment snapshots (e.g. one per network/chain id). */
  readonly snapshots: ReadonlyArray<DeploymentSnapshot>;
  /** Optional map of Solidity contract name → viem-ready ABI. */
  readonly abis?: Readonly<Record<string, unknown>>;
  /**
   * If set, also emit a publishable package scaffold in `packageFiles`
   * (`package.json` name = this value).
   */
  readonly packageName?: string;
  /** JSON/TS pretty-print indent width. Defaults to `2`. */
  readonly indent?: number;
}

/** The artifact returned by `exportAddressBook()`. */
export interface AddressBookArtifact {
  /** Deterministic pretty-printed JSON address book, trailing-newline terminated. */
  readonly json: string;
  /**
   * Typed TS module source: `export const addresses = {...} as const;` plus
   * `export type AddressBook = typeof addresses;`.
   */
  readonly ts: string;
  /** Matching `.d.ts` declarations for `ts` (and for `packageFiles["index.js"]`). */
  readonly dts: string;
  /** Warnings: skipped null-address contracts, address conflicts. */
  readonly warnings: ReadonlyArray<string>;
  /**
   * Present iff `options.packageName` was given: a minimal publishable
   * package scaffold — `package.json`, compiled `index.js`, and `index.d.ts`.
   */
  readonly packageFiles?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

function buildEntry(
  contract: ContractView,
  address: string,
  snapshot: DeploymentSnapshot,
  abis: Readonly<Record<string, unknown>> | undefined,
): AddressBookEntry {
  const abi = abis?.[contract.contractName];
  return {
    address,
    contractName: contract.contractName,
    chainId: snapshot.chainId,
    ...(snapshot.network !== undefined ? { network: snapshot.network } : {}),
    deployedAt: snapshot.takenAt,
    ...(abi !== undefined ? { abi } : {}),
  };
}

/**
 * Merge `snapshots` into a sorted, deterministic `AddressBookData` structure
 * plus any warnings (skipped null-address contracts, address conflicts).
 *
 * Conflict policy: FIRST-WINS. When the same `(chainId, contractId)` appears
 * more than once with differing addresses, the first occurrence (in
 * `snapshots` array order) is kept and a warning is recorded.
 */
function buildAddressBookData(
  snapshots: ReadonlyArray<DeploymentSnapshot>,
  abis: Readonly<Record<string, unknown>> | undefined,
  warnings: string[],
): AddressBookData {
  const byChain = new Map<number, Map<string, AddressBookEntry>>();
  const skipped: string[] = [];

  for (const snapshot of snapshots) {
    for (const contract of snapshot.contracts) {
      if (contract.address === null) {
        skipped.push(`"${contract.id}" (chain ${snapshot.chainId})`);
        continue;
      }

      let chainMap = byChain.get(snapshot.chainId);
      if (chainMap === undefined) {
        chainMap = new Map<string, AddressBookEntry>();
        byChain.set(snapshot.chainId, chainMap);
      }

      const entry = buildEntry(contract, contract.address, snapshot, abis);
      const existing = chainMap.get(contract.id);

      if (existing !== undefined) {
        if (existing.address !== entry.address) {
          warnings.push(
            `Conflicting address for "${contract.id}" on chain ${snapshot.chainId}: ` +
              `keeping "${existing.address}", ignoring "${entry.address}"`,
          );
        }
        // First-wins: never overwrite an already-recorded entry.
        continue;
      }

      chainMap.set(contract.id, entry);
    }
  }

  if (skipped.length > 0) {
    warnings.push(
      `Skipped ${skipped.length} contract(s) with no deployed address (excluded from address book): ${skipped.join(", ")}`,
    );
  }

  const sortedChainIds = Array.from(byChain.keys()).sort((a, b) => a - b);
  const data: Record<string, Record<string, AddressBookEntry>> = {};
  for (const chainId of sortedChainIds) {
    const chainMap = byChain.get(chainId);
    if (chainMap === undefined) continue;
    const sortedContractIds = Array.from(chainMap.keys()).sort((a, b) => a.localeCompare(b));
    const chainEntries: Record<string, AddressBookEntry> = {};
    for (const contractId of sortedContractIds) {
      const entry = chainMap.get(contractId);
      if (entry !== undefined) {
        chainEntries[contractId] = entry;
      }
    }
    data[String(chainId)] = chainEntries;
  }

  return data;
}

// ---------------------------------------------------------------------------
// TS / dts pretty-printers
// ---------------------------------------------------------------------------

/** True iff `key` can be written as a bare (unquoted) object key in TS/JS. */
function isBareKey(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) || /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function tsKey(key: string): string {
  return isBareKey(key) ? key : JSON.stringify(key);
}

/**
 * Pretty-print a JSON-safe value as TS/JS source (a runtime-valid object/array
 * literal). Used to render both `ts` (with `as const` appended by the caller)
 * and `packageFiles["index.js"]` (plain JS, no `as const`).
 */
function printTsValue(value: unknown, indent: number, depth: number): string {
  const pad = " ".repeat(indent * (depth + 1));
  const closePad = " ".repeat(indent * depth);

  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => pad + printTsValue(v, indent, depth + 1));
    return "[\n" + items.join(",\n") + "\n" + closePad + "]";
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(
      ([k, v]) => pad + tsKey(k) + ": " + printTsValue(v, indent, depth + 1),
    );
    return "{\n" + lines.join(",\n") + "\n" + closePad + "}";
  }

  // Fallback — should not occur for JSON-safe values.
  return JSON.stringify(value);
}

/**
 * Pretty-print a JSON-safe value as a TS literal TYPE mirroring the shape
 * `printTsValue()` would emit for the same value (as if inferred from
 * `as const`). Used to render `dts`.
 */
function printTsLiteralType(value: unknown, indent: number, depth: number): string {
  const pad = " ".repeat(indent * (depth + 1));
  const closePad = " ".repeat(indent * depth);

  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "readonly []";
    const items = value.map((v) => pad + printTsLiteralType(v, indent, depth + 1));
    return "readonly [\n" + items.join(",\n") + "\n" + closePad + "]";
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "Record<string, never>";
    const lines = entries.map(
      ([k, v]) => pad + "readonly " + tsKey(k) + ": " + printTsLiteralType(v, indent, depth + 1),
    );
    return "{\n" + lines.join(",\n") + "\n" + closePad + "}";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Package scaffold
// ---------------------------------------------------------------------------

function buildPackageFiles(
  packageName: string,
  indexJs: string,
  dts: string,
  indent: number,
): Readonly<Record<string, string>> {
  const pkgJson = {
    name: packageName,
    version: "0.0.0",
    private: false,
    type: "module",
    main: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
    },
  };

  return {
    "package.json": JSON.stringify(pkgJson, null, indent) + "\n",
    "index.js": indexJs,
    "index.d.ts": dts,
  };
}

// ---------------------------------------------------------------------------
// exportAddressBook
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, JSON-safe address book artifact from one or more
 * `DeploymentSnapshot`s.
 *
 * PURE / READ-ONLY: performs NO filesystem access. Persisting `json`, `ts`,
 * `dts`, or `packageFiles` entries to disk is the caller's responsibility.
 *
 * See the module-level doc comment for the merge/conflict policy, skip
 * behavior, and determinism guarantees.
 */
export function exportAddressBook(options: ExportAddressBookOptions): AddressBookArtifact {
  const { snapshots, abis, packageName, indent = 2 } = options;

  const warnings: string[] = [];
  const data = buildAddressBookData(snapshots, abis, warnings);

  const json = JSON.stringify(data, null, indent) + "\n";

  const rendered = printTsValue(data, indent, 0);
  const renderedType = printTsLiteralType(data, indent, 0);

  const ts = `export const addresses = ${rendered} as const;\n\nexport type AddressBook = typeof addresses;\n`;
  const dts = `export declare const addresses: ${renderedType};\n\nexport type AddressBook = typeof addresses;\n`;

  const artifact: {
    json: string;
    ts: string;
    dts: string;
    warnings: ReadonlyArray<string>;
    packageFiles?: Readonly<Record<string, string>>;
  } = { json, ts, dts, warnings };

  if (packageName !== undefined) {
    const indexJs = `export const addresses = ${rendered};\n`;
    artifact.packageFiles = buildPackageFiles(packageName, indexJs, dts, indent);
  }

  return artifact;
}

/**
 * snapshot-view.ts
 *
 * Pure, browser-safe helpers for the snapshot viewer (issue #105):
 *   - `snapshotToDeploymentView`: adapts a `DeploymentSnapshot` (persisted by
 *     @redeploy/reader's `buildSnapshot()`) into the `DeploymentView` shape
 *     the existing read-only `<Inspector>` component already renders.
 *   - `parseSnapshot`: validates an arbitrary `unknown` (e.g. `JSON.parse()`
 *     of a user-loaded file) into a `DeploymentSnapshot`, throwing a clear
 *     `Error` when the shape doesn't match.
 *
 * ## Browser safety
 * Only TYPES are imported from `@redeploy/reader` (no `readDeployment`,
 * `buildSnapshot`, etc. value imports) — this module contains no Node.js
 * dependency and is safe to bundle into the browser.
 */

import type {
  ArgValue,
  ConfigStepStatus,
  ContractLinks,
  ContractView,
  DeploymentSnapshot,
  DeploymentView,
} from "@redeploy/reader";

// ---------------------------------------------------------------------------
// snapshotToDeploymentView
// ---------------------------------------------------------------------------

/**
 * Adapt a `DeploymentSnapshot` into a `DeploymentView` for reuse with the
 * existing `<Inspector>` canvas + config-steps sidebar. `contracts`,
 * `configSteps`, and `warnings` are exactly the `DeploymentView` fields, so
 * this is a straight pass-through (the snapshot-only metadata — takenAt,
 * chainId, network, toolVersion, specHash — is rendered separately by
 * `<SnapshotViewer>`'s own metadata panel).
 */
export function snapshotToDeploymentView(snapshot: DeploymentSnapshot): DeploymentView {
  return {
    contracts: snapshot.contracts,
    configSteps: snapshot.configSteps,
    warnings: snapshot.warnings,
  };
}

// ---------------------------------------------------------------------------
// parseSnapshot — pragmatic runtime validation for the file-load path
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: string): never {
  throw new Error(`Invalid deployment snapshot: ${reason}`);
}

/** Validate an ArgValue recursively (best-effort; matches the reader's recursive union). */
function isArgValue(value: unknown): value is ArgValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isArgValue);
  }
  if (isRecord(value)) {
    // BigIntValue: { $bigint: string }
    if ("$bigint" in value) {
      return typeof value["$bigint"] === "string";
    }
    return Object.values(value).every(isArgValue);
  }
  return false;
}

function isContractLinks(value: unknown): value is ContractLinks {
  if (!isRecord(value)) return false;
  const { dependencies, libraries } = value;
  if (!Array.isArray(dependencies) || !dependencies.every((d) => typeof d === "string")) {
    return false;
  }
  if (!isRecord(libraries) || !Object.values(libraries).every((v) => typeof v === "string")) {
    return false;
  }
  return true;
}

function isContractView(value: unknown): value is ContractView {
  if (!isRecord(value)) return false;
  const { id, contractName, address, args, links } = value;
  if (typeof id !== "string") return false;
  if (typeof contractName !== "string") return false;
  if (address !== null && typeof address !== "string") return false;
  if (!Array.isArray(args) || !args.every(isArgValue)) return false;
  if (!isContractLinks(links)) return false;
  return true;
}

function isConfigStepStatus(value: unknown): value is ConfigStepStatus {
  if (!isRecord(value)) return false;
  const { id, kind, completed, completedAt } = value;
  if (typeof id !== "string") return false;
  if (typeof kind !== "string") return false;
  if (typeof completed !== "boolean") return false;
  if (completedAt !== null && typeof completedAt !== "string") return false;
  return true;
}

/**
 * Validate a JSON-parsed `unknown` value into a `DeploymentSnapshot`.
 *
 * Guards the file-load path (issue #105 — "Load snapshot" in the studio)
 * against garbage/malformed input: throws a clear `Error` describing the
 * first validation failure encountered when a required field is missing or
 * wrong-typed. `network` is the only optional field.
 *
 * Validation is pragmatic (not a full JSON-schema pass) but real: it checks
 * every required top-level field's presence and primitive type, plus a
 * best-effort recursive shape check on `contracts` and `configSteps`.
 */
export function parseSnapshot(raw: unknown): DeploymentSnapshot {
  if (!isRecord(raw)) {
    fail("expected a JSON object");
  }

  const {
    snapshotVersion,
    takenAt,
    chainId,
    network,
    toolVersion,
    specHash,
    contracts,
    configSteps,
    warnings,
  } = raw;

  if (typeof snapshotVersion !== "number") {
    fail("`snapshotVersion` must be a number");
  }
  if (typeof takenAt !== "string") {
    fail("`takenAt` must be a string (ISO-8601 timestamp)");
  }
  if (typeof chainId !== "number") {
    fail("`chainId` must be a number");
  }
  if (network !== undefined && typeof network !== "string") {
    fail("`network` must be a string when present");
  }
  if (typeof toolVersion !== "string") {
    fail("`toolVersion` must be a string");
  }
  if (typeof specHash !== "string") {
    fail("`specHash` must be a string");
  }
  if (!Array.isArray(contracts)) {
    fail("`contracts` must be an array");
  }
  if (!contracts.every(isContractView)) {
    fail("`contracts` contains an entry with an invalid shape");
  }
  if (!Array.isArray(configSteps)) {
    fail("`configSteps` must be an array");
  }
  if (!configSteps.every(isConfigStepStatus)) {
    fail("`configSteps` contains an entry with an invalid shape");
  }
  if (!Array.isArray(warnings)) {
    fail("`warnings` must be an array");
  }
  if (!warnings.every((w) => typeof w === "string")) {
    fail("`warnings` must be an array of strings");
  }

  return {
    snapshotVersion: snapshotVersion as DeploymentSnapshot["snapshotVersion"],
    takenAt,
    chainId,
    ...(network !== undefined ? { network } : {}),
    toolVersion,
    specHash,
    contracts: contracts as ReadonlyArray<ContractView>,
    configSteps: configSteps as ReadonlyArray<ConfigStepStatus>,
    warnings: warnings as ReadonlyArray<string>,
  };
}

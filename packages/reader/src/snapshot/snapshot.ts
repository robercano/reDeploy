/**
 * Deployment snapshot builder for @redeploy/reader.
 *
 * DESIGN
 * ======
 *
 * `buildSnapshot()` takes an already-read (or freshly read) `DeploymentView`
 * plus caller-supplied metadata (chain id, network label, tool/spec version,
 * and the input spec+config used to produce the deployment) and returns a
 * single, JSON-safe, deterministic `DeploymentSnapshot` object.
 *
 * This module is READ-ONLY by design, matching the rest of @redeploy/reader:
 * it performs NO filesystem writes. Persisting the returned object to disk
 * (e.g. under `snapshots/<timestamp>.json`) is the caller's responsibility —
 * see `snapshotRelativePath()` below for a pure helper that computes the
 * conventional relative path for a given `takenAt` timestamp, without ever
 * touching the filesystem.
 *
 * DETERMINISM
 * ===========
 *
 * Given identical inputs (including an explicitly supplied `takenAt`),
 * `buildSnapshot()` returns byte-identical output: `JSON.stringify(a) ===
 * JSON.stringify(b)`. This is required for the resulting snapshot files to be
 * diff-friendly and for tests to assert equality directly. To achieve this:
 *   - `takenAt` is injectable; it defaults to `new Date().toISOString()` only
 *     when the caller does not supply one.
 *   - `specHash` is computed via a canonical (recursively sorted-object-keys)
 *     JSON serialization of the input spec+config, so key reordering in the
 *     input does not change the hash.
 *   - Arrays (contracts, configSteps, warnings) preserve the order already
 *     established by `DeploymentView` — we do not re-sort them, since
 *     `readDeployment()` already returns them in a stable (insertion) order.
 *
 * CONFIG STEP LIMITATION
 * =======================
 *
 * `DeploymentView.configSteps` (see `../read/reader.ts`) currently exposes
 * only `{ id, kind, completed, completedAt }` — it does NOT include the
 * resolved target/arguments for each config step (e.g. the contract + function
 * + resolved call arguments a "functionCall" step would invoke). Capturing
 * those would require extending the config-state journal parser's contract
 * (parsing additional fields from `config-state.jsonl` and/or cross-referencing
 * the original config spec), which is out of scope for this change per the
 * ticket. This snapshot therefore captures the *completion status* of config
 * steps (id/kind/completed/completedAt) as-is from `DeploymentView`, and does
 * NOT include fully-resolved per-step call arguments. This is a known,
 * documented limitation — see `DeploymentSnapshot.configSteps`.
 */

import * as crypto from "node:crypto";
import type {
  ContractView,
  ConfigStepStatus,
  DeploymentView,
  ReadDeploymentOptions,
} from "../read/reader.js";
import { readDeployment } from "../read/reader.js";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * The current snapshot schema version. Bump this (and add a migration note
 * here) whenever the shape of `DeploymentSnapshot` changes in a
 * backwards-incompatible way.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** The literal type of `SNAPSHOT_SCHEMA_VERSION`, for use in the schema. */
export type SnapshotVersion = typeof SNAPSHOT_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

/**
 * A point-in-time, JSON-safe snapshot of a deployment's contracts and applied
 * configuration, suitable for persisting to disk (e.g.
 * `snapshots/<timestamp>.json`) or shipping over the wire.
 *
 * Fully JSON-safe: `JSON.parse(JSON.stringify(snapshot))` deep-equals
 * `snapshot`. Bigints are already normalized to `BigIntValue` by the reader
 * (`{ $bigint: "<decimal>" }`) — see `../read/reader.ts`.
 */
export interface DeploymentSnapshot {
  /** Schema version for forward-compatibility of this snapshot shape. */
  readonly snapshotVersion: SnapshotVersion;
  /** ISO-8601 timestamp of when this snapshot was taken. */
  readonly takenAt: string;
  /** Chain id the deployment targets. */
  readonly chainId: number;
  /** Optional human-readable network label (e.g. "sepolia", "mainnet"). */
  readonly network?: string;
  /** Version string of the reDeploy tool/spec that produced this deployment. */
  readonly toolVersion: string;
  /**
   * SHA-256 hex digest of a canonical (sorted-keys) JSON serialization of the
   * input spec+config that produced this deployment. Stable across key
   * reordering of the input; changes iff the input content changes.
   */
  readonly specHash: string;
  /** Deployed contracts: id, name, address, resolved args, and links. */
  readonly contracts: ReadonlyArray<ContractView>;
  /**
   * Completion status of config steps applied to this deployment.
   *
   * LIMITATION: this reflects only what `DeploymentView.configSteps` exposes
   * today (id/kind/completed/completedAt). It does NOT include fully-resolved
   * per-step call targets/arguments — see the module-level doc comment for
   * why. Only steps `readDeployment()` returned (per its
   * `expectedConfigStepIds` option) appear here.
   */
  readonly configSteps: ReadonlyArray<ConfigStepStatus>;
  /** Warnings surfaced while reading the underlying deployment state, if any. */
  readonly warnings: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for `buildSnapshot()`.
 *
 * Exactly one of `deployment` or `read` must be provided:
 *   - `deployment`: a pre-read `DeploymentView` (e.g. from a prior
 *     `readDeployment()` call) — use this to avoid re-reading from disk.
 *   - `read`: `ReadDeploymentOptions` to pass to `readDeployment()` internally.
 *
 * If both are omitted (or both provided), `buildSnapshot()` throws.
 */
export interface BuildSnapshotOptions {
  /** A pre-read deployment view. Mutually exclusive with `read`. */
  deployment?: DeploymentView;
  /** Options to pass to `readDeployment()`. Mutually exclusive with `deployment`. */
  read?: ReadDeploymentOptions;
  /** Chain id the deployment targets. */
  chainId: number;
  /** Optional human-readable network label (e.g. "sepolia", "mainnet"). */
  network?: string;
  /** Version string of the reDeploy tool/spec that produced this deployment. */
  toolVersion: string;
  /**
   * The input spec+config that produced this deployment, OR a precomputed
   * SHA-256 hex digest to use directly as `specHash`.
   *
   * - If `{ spec: unknown }` is passed, `specHash` is derived by canonically
   *   (sorted-keys) JSON-serializing `spec` and hashing it with SHA-256.
   * - If `{ hash: string }` is passed, that hash is used verbatim as
   *   `specHash` (no re-hashing) — useful when the caller already computed a
   *   stable hash elsewhere.
   */
  spec: { spec: unknown } | { hash: string };
  /**
   * The timestamp to record as `takenAt`. Injectable for deterministic
   * tests. Defaults to `new Date().toISOString()` when omitted.
   */
  takenAt?: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys so that JSON serialization is stable
 * regardless of the original key insertion order. Arrays are left in their
 * original order (order is significant for arrays). Primitives and `null`
 * pass through unchanged.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialize `value` to a canonical JSON string (sorted object keys,
 * deterministic regardless of input key order).
 */
function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Compute a SHA-256 hex digest of the canonical JSON serialization of
 * `spec`. Pure — no filesystem or network access.
 */
export function hashSpec(spec: unknown): string {
  const canonical = canonicalJsonStringify(spec);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

/**
 * Build a JSON-safe, deterministic `DeploymentSnapshot` from deployment
 * state and caller-supplied metadata.
 *
 * PURE / READ-ONLY w.r.t. this function's own behavior: it performs NO
 * filesystem writes. If `options.read` is provided, it delegates to
 * `readDeployment()` (from `../read/reader.ts`), which itself only reads from
 * disk. If `options.deployment` is provided instead, no filesystem access
 * occurs at all.
 *
 * @throws Error if neither or both of `options.deployment` / `options.read`
 *         are provided.
 */
export function buildSnapshot(options: BuildSnapshotOptions): DeploymentSnapshot {
  const { deployment, read, chainId, network, toolVersion, spec, takenAt } = options;

  if (deployment != null && read != null) {
    throw new Error(
      "buildSnapshot: provide exactly one of `deployment` or `read`, not both",
    );
  }
  if (deployment == null && read == null) {
    throw new Error("buildSnapshot: provide one of `deployment` or `read`");
  }

  const view: DeploymentView = deployment ?? readDeployment(read as ReadDeploymentOptions);

  const specHash = "hash" in spec ? spec.hash : hashSpec(spec.spec);

  const snapshot: DeploymentSnapshot = {
    snapshotVersion: SNAPSHOT_SCHEMA_VERSION,
    takenAt: takenAt ?? new Date().toISOString(),
    chainId,
    ...(network !== undefined ? { network } : {}),
    toolVersion,
    specHash,
    contracts: view.contracts,
    configSteps: view.configSteps,
    warnings: view.warnings,
  };

  return snapshot;
}

// ---------------------------------------------------------------------------
// Path helper (pure — no filesystem access)
// ---------------------------------------------------------------------------

/**
 * The directory (relative to a deployment/output root) conventionally used
 * to store persisted snapshot files.
 */
export const SNAPSHOTS_DIR = "snapshots";

/**
 * Compute the conventional relative path for a snapshot file taken at
 * `takenAt`, WITHOUT touching the filesystem (no existence check, no
 * directory creation, no write). Actually persisting the snapshot at this
 * path is the caller's responsibility.
 *
 * Sanitization: ISO-8601 timestamps (e.g. "2026-07-05T12:00:00.000Z")
 * contain `:` characters, which are invalid in filenames on some filesystems
 * (notably Windows). This helper replaces every character that is not
 * `[A-Za-z0-9.-]` with `-` so the resulting filename is safe cross-platform.
 * `.` is preserved so the milliseconds separator and the trailing `.json`
 * extension remain readable.
 *
 * @example
 *   snapshotRelativePath("2026-07-05T12:00:00.000Z")
 *   // => "snapshots/2026-07-05T12-00-00.000Z.json"
 */
export function snapshotRelativePath(takenAt: string): string {
  const sanitized = takenAt.replace(/[^A-Za-z0-9.-]/g, "-");
  return `${SNAPSHOTS_DIR}/${sanitized}.json`;
}

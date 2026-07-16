/**
 * Config-drift orchestration for `POST /api/verify/config`.
 *
 * Wraps `@redeploy/verify`'s `verifyConfig()` with:
 *   1. Structural validation of the incoming (client-supplied) ConfigSpec shape.
 *   2. Pre-filtering of steps that reference an undeployed contract id (would
 *      otherwise throw `ConfigVerifyError("UNKNOWN_REF")`) into direct "error"
 *      results.
 *   3. Heuristic getter-mapping derivation (see derive-reads.ts) so steps with
 *      no derivable mapping degrade to "skipped" results instead of throwing
 *      `ConfigVerifyError("MISSING_GETTER_MAPPING")`.
 *   4. A final safety-net try/catch around `verifyConfig()` itself, so ANY
 *      unexpected `ConfigVerifyError` (or other throw) degrades to a single
 *      synthetic "error" result rather than ever crashing the HTTP handler.
 *
 * `orderedSteps` are merged with `steps` before checking — `verifyConfig()`
 * only reads `spec.steps`, but drift detection has no notion of "ordered";
 * every step (regardless of which list it came from in the studio's
 * ConfigSpec) is checked exactly once.
 *
 * Result ordering mirrors the original spec (steps, then orderedSteps) so the
 * studio can render results in the same order the user authored them.
 */

import type { ConfigSpec, ConfigStep } from "@redeploy/config";
import { verifyConfig, ConfigVerifyError } from "@redeploy/verify";
import type { ChainReader } from "@redeploy/verify";
import type { DeploymentView } from "@redeploy/reader";
import { deriveReads } from "./derive-reads.js";
import { findUnresolvedRef } from "./step-refs.js";

export type ConfigDriftStatus = "match" | "drift" | "error" | "skipped";

export interface ConfigDriftResultEntry {
  readonly id: string;
  readonly status: ConfigDriftStatus;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message?: string;
}

export interface ConfigDriftResponse {
  readonly clean: boolean;
  readonly results: ConfigDriftResultEntry[];
}

/**
 * Recursively normalize a value for safe `JSON.stringify()`.
 *
 * `ChainReader.call()` (viem's `readContract`) returns raw ABI-decoded
 * values, which routinely include `bigint` for uint/int-typed return values
 * (e.g. a `getFee()` returning `500n`). `JSON.stringify()` THROWS on a
 * `bigint` — left unhandled, a single drift-checked `uint256` getter would
 * crash the whole `/api/verify/config` response. We normalize any `bigint`
 * into `{ $bigint: "<decimal>" }`, mirroring `@redeploy/reader`'s
 * `BigIntValue` convention used elsewhere in this codebase for the same
 * reason, so the studio can render it the same way it already renders
 * constructor args.
 */
function normalizeForJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForJson);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeForJson(v);
    }
    return out;
  }
  return value;
}

/**
 * Structural (shape-only) validation of an unknown request body as a
 * ConfigSpec. Returns a human-readable error string when invalid, or `null`
 * when the body is at least shaped like `{ version, steps, orderedSteps? }`.
 *
 * Deliberately lenient about step CONTENTS — malformed individual steps are
 * still handled gracefully downstream (findUnresolvedRef / deriveReads /
 * verifyConfig's own MALFORMED_SPEC handling), never a hard 500.
 */
export function validateConfigSpecShape(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b["steps"])) {
    return 'Request body must have a "steps" array';
  }
  if (b["orderedSteps"] !== undefined && !Array.isArray(b["orderedSteps"])) {
    return '"orderedSteps" must be an array when present';
  }
  return null;
}

export interface RunConfigDriftOptions {
  /** The ConfigSpec to check (already shape-validated via validateConfigSpecShape). */
  readonly spec: ConfigSpec;
  /** The persisted deployment (from readDeployment()) — the source of deployed addresses. */
  readonly deployment: DeploymentView;
  /** Injected read-only chain reader (see chain-reader.ts) — never a signer. */
  readonly reader: ChainReader;
}

/**
 * Run config-drift detection for every step in `spec` against the live chain
 * state. NEVER throws — every failure mode (undeployed ref, no derivable
 * getter, or an unexpected verifyConfig() error) degrades to a per-step or
 * synthetic "error"/"skipped" result instead.
 */
export async function runConfigDrift(options: RunConfigDriftOptions): Promise<ConfigDriftResponse> {
  const { spec, deployment, reader } = options;

  const deployedAddresses: Record<string, string> = {};
  for (const c of deployment.contracts) {
    if (c.address !== null) {
      deployedAddresses[c.id] = c.address;
    }
  }

  const allSteps: ConfigStep[] = [...spec.steps, ...(spec.orderedSteps ?? [])];
  const order = new Map<string, number>(allSteps.map((s, i) => [s.id, i]));

  const results: ConfigDriftResultEntry[] = [];
  const resolvableSteps: ConfigStep[] = [];

  for (const step of allSteps) {
    const missingId = findUnresolvedRef(step, deployedAddresses);
    if (missingId !== null) {
      results.push({
        id: step.id,
        status: "error",
        expected: null,
        actual: null,
        message: `Cannot verify step "${step.id}": contract "${missingId}" is not deployed.`,
      });
      continue;
    }
    resolvableSteps.push(step);
  }

  const { includable, reads, skipped } = deriveReads(resolvableSteps);
  for (const s of skipped) {
    results.push({ id: s.id, status: "skipped", expected: null, actual: null, message: s.reason });
  }

  if (includable.length > 0) {
    try {
      const subSpec: ConfigSpec = { version: 1, steps: includable };
      const verifyResult = await verifyConfig({ spec: subSpec, deployedAddresses, reader, reads });
      for (const r of verifyResult.results) {
        results.push({
          id: r.id,
          status: r.status,
          expected: normalizeForJson(r.expected),
          actual: normalizeForJson(r.actual),
          message: r.message,
        });
      }
    } catch (err) {
      const message =
        err instanceof ConfigVerifyError
          ? `Config drift check could not run: ${err.message}`
          : "Config drift check failed unexpectedly";
      results.push({ id: "__config__", status: "error", expected: null, actual: null, message });
    }
  }

  // Preserve the original spec's step order (unresolved-ref/skipped entries
  // are pushed before verifyConfig()'s results above, regardless of their
  // position in the original spec).
  results.sort((a, b) => (order.get(a.id) ?? Number.POSITIVE_INFINITY) - (order.get(b.id) ?? Number.POSITIVE_INFINITY));

  const clean = results.every((r) => r.status === "match" || r.status === "skipped");
  return { clean, results };
}

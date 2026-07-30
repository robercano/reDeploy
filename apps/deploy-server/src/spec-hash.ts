/**
 * Stable, deterministic hashing for a `DeploymentSpec` (or any JSON-ish
 * value) — used to key the simulate-first interlock (see `simulate-state.ts`
 * and `server.ts`'s `handleSimulate`/`handleDeploy`).
 *
 * DESIGN
 * ======
 *
 * `JSON.stringify` alone is NOT a stable serialization: two structurally
 * identical objects with keys in a different order produce different
 * strings, and thus different hashes. Since the studio (or any client) may
 * re-serialize the same logical spec with keys in a different order between
 * a `POST /api/simulate` call and a subsequent `POST /api/deploy` call, a
 * naive `sha256(JSON.stringify(spec))` would spuriously treat them as
 * different specs and defeat the "same spec" interlock check.
 *
 * `specHash` fixes this by recursively sorting object keys (arrays keep
 * their original order — element order is semantically meaningful, e.g.
 * constructor `args`) before serializing, then hashing the canonical string
 * with SHA-256 (`node:crypto`), hex-encoded.
 *
 * This module has NO knowledge of the `DeploymentSpec` shape — it operates
 * on `unknown` so it can hash the raw parsed request body exactly as both
 * `handleSimulate` and `handleDeploy` receive it, without importing
 * `@redeploy/core`'s spec types.
 */

import { createHash } from "node:crypto";

/**
 * Recursively produce a canonical (deterministically ordered) clone of
 * `value`, suitable for stable JSON serialization:
 *   - Plain objects: keys are sorted lexicographically (recursively).
 *   - Arrays: element order is preserved (order is semantically meaningful),
 *     but each element is itself canonicalized.
 *   - Everything else (strings, numbers, booleans, null, undefined):
 *     returned as-is — `JSON.stringify` already handles these deterministically.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * Produce a deterministic SHA-256 hex digest of `spec`'s canonical JSON
 * serialization. Two values that are structurally equal (same keys/values,
 * regardless of object key order) always produce the same hash; any
 * structural difference (a changed value, an added/removed key, a reordered
 * array) produces a different hash.
 */
export function specHash(spec: unknown): string {
  const canonical = canonicalize(spec);
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized).digest("hex");
}

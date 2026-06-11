/**
 * Validation entry point for the declarative deployment spec.
 *
 * Validation is two-phase:
 *   1. Zod schema parse — structural shape, required fields, discriminated union.
 *   2. Cross-field rules — duplicate ids, missing refs, self-references, cycles.
 *
 * All errors are COLLECTED and returned together (never fail-fast).
 */

import type { DeploymentSpec } from "./types.js";
import { deploymentSpecSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// SpecError — structured validation error
// ---------------------------------------------------------------------------

/** Stable string codes for every validation failure mode. */
export type SpecErrorCode =
  | "INVALID_SHAPE"
  | "DUPLICATE_ID"
  | "MISSING_REF"
  | "SELF_REFERENCE"
  | "CYCLE";

/**
 * A single structured validation error.
 *
 * - `path`    — JSON-pointer-ish location string (e.g. `contracts[2].args[0].contract`).
 * - `code`    — Stable enum value for programmatic handling.
 * - `message` — Human-readable description.
 */
export interface SpecError {
  readonly path: string;
  readonly code: SpecErrorCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { readonly ok: true; readonly spec: DeploymentSpec }
  | { readonly ok: false; readonly errors: SpecError[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a zod issue path array to a human-readable JSON-pointer-ish string.
 * e.g. ["contracts", 2, "args", 0, "kind"] → "contracts[2].args[0].kind"
 */
function zodPathToString(path: (string | number)[]): string {
  return path
    .map((seg, i) =>
      typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`,
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

function collectCrossFieldErrors(spec: DeploymentSpec): SpecError[] {
  const errors: SpecError[] = [];

  // --- 1. Build the id set and detect duplicates ----------------------------
  const seenIds = new Map<string, number>(); // id → first occurrence index
  for (let i = 0; i < spec.contracts.length; i++) {
    const entry = spec.contracts[i];
    const basePath = `contracts[${i}]`;
    if (seenIds.has(entry.id)) {
      errors.push({
        path: `${basePath}.id`,
        code: "DUPLICATE_ID",
        message: `Duplicate contract id "${entry.id}" (first seen at contracts[${seenIds.get(entry.id)!}])`,
      });
    } else {
      seenIds.set(entry.id, i);
    }
  }

  // The valid id set is those ids that appear EXACTLY once (first occurrence).
  // For subsequent cross-field checks we still want to allow all ids to be
  // referenced — so we track all ids regardless of duplication.
  const allIds = new Set<string>(spec.contracts.map((c) => c.id));

  // --- 2. Iterate entries for ref/after checks ------------------------------
  for (let i = 0; i < spec.contracts.length; i++) {
    const entry = spec.contracts[i];
    const basePath = `contracts[${i}]`;

    // Check args refs
    if (entry.args) {
      for (let j = 0; j < entry.args.length; j++) {
        const arg = entry.args[j];
        if (arg.kind === "ref") {
          const argPath = `${basePath}.args[${j}].contract`;
          // Self-reference
          if (arg.contract === entry.id) {
            errors.push({
              path: argPath,
              code: "SELF_REFERENCE",
              message: `Contract "${entry.id}" references itself in args`,
            });
          } else if (!allIds.has(arg.contract)) {
            // Missing ref — Set.has() is pollution-safe; no extra own-key guard needed.
            errors.push({
              path: argPath,
              code: "MISSING_REF",
              message: `Contract "${entry.id}" args[${j}] references unknown id "${arg.contract}"`,
            });
          }
        }
      }
    }

    // Check after entries
    if (entry.after) {
      for (let k = 0; k < entry.after.length; k++) {
        const afterId = entry.after[k];
        const afterPath = `${basePath}.after[${k}]`;
        // Self-reference via after
        if (afterId === entry.id) {
          errors.push({
            path: afterPath,
            code: "SELF_REFERENCE",
            message: `Contract "${entry.id}" lists itself in after`,
          });
        } else if (!allIds.has(afterId)) {
          errors.push({
            path: afterPath,
            code: "MISSING_REF",
            message: `Contract "${entry.id}" after[${k}] references unknown id "${afterId}"`,
          });
        }
      }
    }
  }

  // --- 3. Cycle detection (iterative Kahn's topological sort) ---------------
  // Only run cycle detection if we don't already have shape errors that would
  // make the edge set unreliable. We still run it in the presence of duplicate
  // id / missing ref errors because those don't prevent us from finding cycles
  // in the well-defined edges.

  const cycleErrors = detectCycles(spec);
  for (const e of cycleErrors) {
    errors.push(e);
  }

  return errors;
}

/**
 * Build the combined ref+after edge set and run an iterative Kahn's
 * topological sort. If any nodes remain after the sort, they are part of a
 * cycle. Returns CYCLE errors for each such node.
 *
 * Uses only iterative algorithms — no recursion — so adversarial deep graphs
 * (e.g. 100k-node chains) will NOT stack-overflow.
 */
function detectCycles(spec: DeploymentSpec): SpecError[] {
  // Only consider entries with unique ids to avoid ambiguity.
  // Map id → index for unique-id entries.
  const idToIndex = new Map<string, number>();
  const duplicateIds = new Set<string>();

  for (let i = 0; i < spec.contracts.length; i++) {
    const id = spec.contracts[i].id;
    if (idToIndex.has(id)) {
      duplicateIds.add(id);
    } else {
      idToIndex.set(id, i);
    }
  }

  // Build adjacency list (from → set of tos) using only safe own-key access.
  // We skip edges involving duplicate ids or unknown ids to avoid false positives.
  const allIds = new Set(idToIndex.keys());

  // indegree[id] = number of incoming edges for Kahn's algorithm
  const indegree = new Map<string, number>();
  // adjacency: from → [to, ...]
  const adj = new Map<string, string[]>();

  for (const id of allIds) {
    indegree.set(id, 0);
    adj.set(id, []);
  }

  for (let i = 0; i < spec.contracts.length; i++) {
    const entry = spec.contracts[i];
    // Skip entries with duplicate ids
    if (duplicateIds.has(entry.id)) continue;
    // Skip self-references (already reported separately, and they'd break Kahn)
    const fromId = entry.id;

    // Collect all unique dependency ids for this entry
    const deps = new Set<string>();

    if (entry.args) {
      for (const arg of entry.args) {
        if (arg.kind === "ref") {
          const toId = arg.contract;
          // Skip unknown ids and self-refs
          if (!allIds.has(toId) || toId === fromId) continue;
          deps.add(toId);
        }
      }
    }

    if (entry.after) {
      for (const toId of entry.after) {
        // Skip unknown ids and self-refs
        if (!allIds.has(toId) || toId === fromId) continue;
        deps.add(toId);
      }
    }

    // Edge: toId → fromId (fromId depends on toId, so toId must come first)
    // In Kahn's terms: fromId has edges FROM toId, meaning toId → fromId
    // We'll build: adj[toId] contains fromId, and indegree[fromId] counts deps
    for (const toId of deps) {
      const existing = adj.get(toId);
      if (existing !== undefined) {
        existing.push(fromId);
      }
      const current = indegree.get(fromId);
      if (current !== undefined) {
        indegree.set(fromId, current + 1);
      }
    }
  }

  // Kahn's algorithm: iterative BFS
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let processedCount = 0;
  // Use an index pointer instead of shift() to avoid O(n) array operations
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    processedCount++;

    const neighbors = adj.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        const deg = (indegree.get(neighbor) ?? 0) - 1;
        indegree.set(neighbor, deg);
        if (deg === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  if (processedCount === allIds.size) {
    // All nodes processed — no cycle
    return [];
  }

  // Nodes not processed are part of a cycle
  const errors: SpecError[] = [];
  for (const [id, deg] of indegree) {
    if (deg > 0) {
      const idx = idToIndex.get(id) ?? -1;
      errors.push({
        path: idx >= 0 ? `contracts[${idx}]` : `contracts[?]`,
        code: "CYCLE",
        message: `Contract "${id}" is part of a deployment cycle`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value against the deployment spec.
 *
 * Returns `{ ok: true, spec }` on success or `{ ok: false, errors }` with ALL
 * collected errors on failure. Never throws.
 *
 * Input is treated as untrusted `unknown` — prototype-pollution via crafted
 * keys (`__proto__`, `constructor`, etc.) is not a concern because:
 *   - Zod parses with its own structural traversal (not JSON.parse assignment).
 *   - Cross-field logic uses Map/Set with explicit `.has()` guards, never
 *     indexing plain objects with attacker-controlled keys.
 */
export function validateSpec(input: unknown): ValidateResult {
  // --- Phase 1: Zod shape validation ----------------------------------------
  // We wrap safeParse in a try/catch because zod's recursive descent on
  // pathological inputs (e.g. extremely deeply nested arrays) can throw a
  // V8 RangeError ("Maximum call stack size exceeded") that safeParse does
  // NOT convert to a ZodError. The depth-bound in schema.ts (LITERAL_MAX_DEPTH)
  // prevents most such cases; this catch is the last-resort safety net so that
  // validateSpec never throws on untrusted input.
  let parseResult: ReturnType<typeof deploymentSpecSchema.safeParse>;
  try {
    parseResult = deploymentSpecSchema.safeParse(input);
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "",
          code: "INVALID_SHAPE",
          message: "spec could not be parsed (too deeply nested or malformed)",
        },
      ],
    };
  }

  if (!parseResult.success) {
    // Convert all zod issues to SpecErrors
    const errors: SpecError[] = parseResult.error.issues.map((issue) => ({
      path: zodPathToString(issue.path as (string | number)[]),
      code: "INVALID_SHAPE" as SpecErrorCode,
      message: issue.message,
    }));
    return { ok: false, errors };
  }

  const spec = parseResult.data;

  // --- Phase 2: Cross-field validation --------------------------------------
  const crossErrors = collectCrossFieldErrors(spec);

  if (crossErrors.length > 0) {
    return { ok: false, errors: crossErrors };
  }

  return { ok: true, spec };
}

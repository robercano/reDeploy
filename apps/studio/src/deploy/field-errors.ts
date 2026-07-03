/**
 * field-errors.ts
 *
 * Shared error-path parsing + per-node field error mapping for the studio's
 * Deploy (simulate) and Deploy (real) flows (issue #83).
 *
 * ## Background
 * The deploy-server's structured errors carry a `path` shaped like a
 * JSON-pointer-ish string relative to the DeploymentSpec's `contracts` array,
 * e.g.:
 *   - "contracts[2].id"                → the contract entry's deploy id
 *   - "contracts[2].args[0]"           → a constructor arg literal/ref value
 *   - "contracts[2].args[0].contract"  → a ref arg's target contract id
 *   - "contracts[2].after[1]"          → an ordering constraint entry
 *   - "contracts[2]"                   → the contract entry as a whole
 *
 * Because graphToSpec builds `contracts[i]` from `nodes[i]` IN ARRAY ORDER
 * (see spec/graph-to-spec.ts), `contracts[i]` positionally corresponds to the
 * i-th node in the studio canvas's `nodes` array. This module maps parsed
 * error paths back to canvas node ids using that positional correspondence,
 * and groups them into a per-field error shape ContractNode can render.
 *
 * ## Fallback chain (issue #83)
 *   1. Field-level (preferred): path resolves to a specific input (the
 *      deploy-id input or a constructor arg slot) → highlight that input.
 *   2. Node-level (fallback): path resolves to the contract entry but not a
 *      more specific field (e.g. an "after[...]" entry, or the bare
 *      "contracts[i]") → red-border the node.
 *   3. Message-only (last resort): the error's path is absent or doesn't
 *      parse into the contracts[] array at all → the caller keeps the plain
 *      red banner (this module skips such errors — it has nothing to map).
 *
 * ## Studio-side empty-constructor-arg pre-validation (issue #83 follow-up)
 * Neither `@redeploy/core`'s `validateSpec` nor the deploy-server reject an
 * empty/blank constructor arg literal value today — an empty arg slot
 * serializes to a literal `null` (or a whitespace string), which is a
 * structurally VALID `LiteralValue`, so it sails through schema + cross-field
 * validation and would silently be deployed. Per product requirement, every
 * constructor parameter must have a real value before Deploy (simulate) / (real)
 * is allowed to proceed. {@link validateConstructorArgs} implements that check
 * on the studio side (see App.tsx's handleSimulate/handleDeploy, which call it
 * BEFORE talking to the deploy-server) and reports errors using the exact same
 * `StructuredDeployError` shape/path convention as the server, so they flow
 * through the same `buildNodeFieldErrors` highlighting path uniformly. A
 * matching server-side check is a follow-up for apps/deploy-server (tracked
 * separately — out of scope for the studio module boundary).
 */

import type { DeploymentSpec, LiteralValue } from "@redeploy/core/spec";

/** A structured error as received from the deploy-server (simulate or deploy). */
export interface StructuredDeployError {
  code?: string;
  path?: string;
  message: string;
}

/** Result of parsing a structured error's `path` field. */
export type ParsedErrorPath =
  | { kind: "id"; contractIndex: number }
  | { kind: "arg"; contractIndex: number; argIndex: number }
  | { kind: "contract"; contractIndex: number };

const ID_RE = /^contracts\[(\d+)\]\.id\b/;
const ARG_RE = /^contracts\[(\d+)\]\.args\[(\d+)\]/;
const CONTRACT_RE = /^contracts\[(\d+)\]/;

/**
 * Parse an error `path` string into a {@link ParsedErrorPath}, or `null` if
 * the path is absent or doesn't map into the `contracts[]` array at all
 * (message-only fallback — the caller keeps the banner).
 *
 * Order matters: the more specific patterns (`.id`, `.args[n]`) are tried
 * before the generic `contracts[n]` prefix match so e.g. "contracts[2].id"
 * is classified as `kind: "id"` rather than the generic `kind: "contract"`.
 */
export function parseErrorPath(path: string | undefined): ParsedErrorPath | null {
  if (!path) return null;

  const idMatch = ID_RE.exec(path);
  if (idMatch) {
    return { kind: "id", contractIndex: Number(idMatch[1]) };
  }

  const argMatch = ARG_RE.exec(path);
  if (argMatch) {
    return { kind: "arg", contractIndex: Number(argMatch[1]), argIndex: Number(argMatch[2]) };
  }

  const contractMatch = CONTRACT_RE.exec(path);
  if (contractMatch) {
    return { kind: "contract", contractIndex: Number(contractMatch[1]) };
  }

  return null;
}

/** Per-node field error state consumed by ContractNode for highlighting. */
export interface NodeFieldErrors {
  /** Error message for the deploy-id input. */
  deployId?: string;
  /** Error messages for constructor arg inputs, keyed by arg slot index. */
  args?: Record<number, string>;
  /**
   * Node-level error message: the path mapped to this contract entry but not
   * to a more specific field (e.g. an "after[...]" entry, or the bare
   * "contracts[i]" path). Rendered as a red border on the node container.
   */
  node?: string;
}

/**
 * Build a per-node-id map of field errors from a list of structured errors
 * and the canvas node ids in array order (nodes[i].id ⇔ contracts[i]).
 *
 * Errors with an unmappable/absent path (parseErrorPath returns null) or an
 * out-of-range contractIndex are skipped — the caller is expected to keep the
 * plain-text banner for those (message-only fallback).
 *
 * @param errors  - Structured errors from runSimulate/runDeploy's failure result.
 * @param nodeIds - Canvas node ids in the SAME order as the `nodes` array that
 *                  was serialized into the DeploymentSpec (nodes[i].id ⇔ contracts[i]).
 */
export function buildNodeFieldErrors(
  errors: StructuredDeployError[],
  nodeIds: string[],
): Map<string, NodeFieldErrors> {
  const result = new Map<string, NodeFieldErrors>();

  for (const err of errors) {
    const parsed = parseErrorPath(err.path);
    if (parsed === null) continue;

    const nodeId = nodeIds[parsed.contractIndex];
    if (nodeId === undefined) continue;

    const entry = result.get(nodeId) ?? {};
    if (parsed.kind === "id") {
      entry.deployId = err.message;
    } else if (parsed.kind === "arg") {
      entry.args = { ...entry.args, [parsed.argIndex]: err.message };
    } else {
      // "contract" — no more specific field mapping: node-level fallback.
      // Keep the first node-level message if multiple errors map here.
      entry.node = entry.node ?? err.message;
    }
    result.set(nodeId, entry);
  }

  return result;
}

/** Stable code for the studio-local empty-constructor-arg pre-validation error. */
export const EMPTY_ARG_CODE = "EMPTY_CONSTRUCTOR_ARG";

/**
 * A literal constructor arg value counts as "empty" (per owner feedback: blank
 * string is invalid for every constructor param) when it is:
 *   - `null` (what an empty arg slot's raw "" input parses to — see
 *     graph-to-spec.ts's parseLiteralValue), or
 *   - a string that is empty or whitespace-only.
 *
 * Any other literal (a real string, a number including 0, a boolean including
 * false, or an array) is a value the user explicitly provided and is NOT empty.
 */
function isBlankLiteral(value: LiteralValue): boolean {
  if (value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Studio-side pre-validation (issue #83): find constructor arg slots whose
 * LITERAL value is empty/blank and report them using the same structured
 * error shape as the deploy-server, so the existing field-highlight machinery
 * (buildNodeFieldErrors) lights up the offending input identically whether
 * the error originated locally or from the server.
 *
 * Ref-bound args (kind === "ref" — supplied by an incoming constructorRef
 * edge, see graph-to-spec.ts) are supplied by the link and are NEVER flagged,
 * regardless of what value the (ignored) literal input might otherwise hold.
 *
 * @param deployment - The serialized DeploymentSpec (graphToSpec's output).
 *                     Its `contracts[i].args[j]` positions are the same ones
 *                     `parseErrorPath`/`buildNodeFieldErrors` expect.
 */
export function validateConstructorArgs(deployment: DeploymentSpec): StructuredDeployError[] {
  const errors: StructuredDeployError[] = [];

  deployment.contracts.forEach((entry, i) => {
    if (!entry.args) return;
    entry.args.forEach((arg, j) => {
      if (arg.kind !== "literal") return; // ref-bound — supplied by the edge link.
      if (isBlankLiteral(arg.value)) {
        errors.push({
          code: EMPTY_ARG_CODE,
          path: `contracts[${i}].args[${j}]`,
          message: "constructor argument must have a value",
        });
      }
    });
  });

  return errors;
}

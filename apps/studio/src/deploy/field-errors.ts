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
 *
 * ## Manifest-anchored arity (issue #83, 2nd follow-up)
 * The check above only ever inspects arg slots that ALREADY EXIST on a
 * `ContractEntry` — but `graph-to-spec.ts`'s `buildContractArgs` maps a node's
 * arg slots 1:1 into `entry.args`, so a node with FEWER slots than the
 * contract's true constructor arity (e.g. a graph persisted to localStorage
 * before `contracts.generated.json` was regenerated with an extra Foundry
 * constructor param) simply omits the missing parameter(s) from `entry.args`
 * entirely. Blank-literal detection alone never sees an omitted slot, so
 * Deploy (simulate)/(real) would proceed with a missing constructor argument.
 * {@link validateConstructorArgs} therefore anchors its slot count to the
 * contract manifest's `constructorArgs.length` (looked up via `getContract`)
 * rather than trusting `entry.args.length`: any manifest parameter beyond the
 * node's actual slot count is reported as a NODE-level error (no specific
 * input to highlight), while blank literals within existing slots remain
 * FIELD-level errors as before. Contracts absent from the manifest (free-text
 * fallback) fall back to `entry.args.length` since their true arity is
 * unknowable — behavior for those is unchanged.
 */

import type { DeploymentSpec, LiteralValue } from "@redeploy/core/spec";
import { getContract } from "../manifest/index.js";

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
 * Studio-side pre-validation (issue #83, manifest-anchored): find constructor
 * parameters whose value is missing or blank and report them using the same
 * structured error shape as the deploy-server, so the existing field-highlight
 * machinery (buildNodeFieldErrors) lights up the offending input/node
 * identically whether the error originated locally or from the server.
 *
 * For each contract entry the number of parameters checked is the contract's
 * manifest `constructorArgs.length` (its true, current arity), NOT
 * `entry.args.length` — a node persisted before the manifest gained a param
 * has fewer arg slots than the manifest expects, and that gap must still be
 * caught. Contracts absent from the manifest fall back to `entry.args.length`
 * since their true arity can't be determined.
 *
 * Two error shapes come out of this, matching what can actually be
 * highlighted:
 *   - FIELD-level (`contracts[i].args[j]`): the slot exists but its literal
 *     value is blank. Ref-bound args (kind === "ref" — supplied by an
 *     incoming constructorRef edge, see graph-to-spec.ts) are supplied by the
 *     link and are NEVER flagged, regardless of what value the (ignored)
 *     literal input might otherwise hold.
 *   - NODE-level (`contracts[i]`): the manifest expects a parameter at index
 *     j but the node has no slot for it at all — there is no input to
 *     highlight, so the whole node is flagged instead. At most one such
 *     error is emitted per contract (buildNodeFieldErrors only keeps the
 *     first node-level message anyway, so extra ones would just be noise).
 *
 * @param deployment - The serialized DeploymentSpec (graphToSpec's output).
 *                     Its `contracts[i].args[j]` positions are the same ones
 *                     `parseErrorPath`/`buildNodeFieldErrors` expect.
 */
export function validateConstructorArgs(deployment: DeploymentSpec): StructuredDeployError[] {
  const errors: StructuredDeployError[] = [];

  deployment.contracts.forEach((entry, i) => {
    const argsLen = entry.args?.length ?? 0;
    const manifest = getContract(entry.contract);
    // Unknown contracts (not in the manifest): can't know the true arity, so
    // fall back to the slots the node actually has (unchanged behavior).
    const arity = manifest ? manifest.constructorArgs.length : argsLen;
    // Check every slot the node has (even beyond `arity`, to preserve the
    // pre-existing blank-literal check) PLUS any manifest parameters beyond
    // the node's slot count (the missing-slot case this fix adds).
    const slotCount = Math.max(arity, argsLen);

    let nodeLevelReported = false;
    for (let j = 0; j < slotCount; j++) {
      if (j < argsLen) {
        const arg = entry.args![j];
        if (arg.kind !== "literal") continue; // ref-bound — supplied by the edge link.
        if (isBlankLiteral(arg.value)) {
          errors.push({
            code: EMPTY_ARG_CODE,
            path: `contracts[${i}].args[${j}]`,
            message: "constructor argument must have a value",
          });
        }
      } else if (!nodeLevelReported) {
        // Manifest expects a parameter here but the node has no slot for it —
        // nothing to highlight at field level, so flag the node itself.
        errors.push({
          code: EMPTY_ARG_CODE,
          path: `contracts[${i}]`,
          message: "constructor parameter(s) missing a value",
        });
        nodeLevelReported = true;
      }
    }
  });

  return errors;
}

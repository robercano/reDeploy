/**
 * Zod runtime schema for the declarative deployment spec.
 *
 * Shape validation only — cross-field rules (dup id, missing refs, cycles,
 * self-ref) are handled in validate.ts after parsing succeeds.
 */

import { z } from "zod";
import type {
  ContractArg,
  ContractEntry,
  DeploymentSpec,
  LiteralValue,
  PreflightPolicy,
  UpgradeableConfig,
  UpgradeableInitializer,
} from "./types.js";

// ---------------------------------------------------------------------------
// Literal value (recursive JSON-serializable scalar / array)
// ---------------------------------------------------------------------------

/**
 * Maximum nesting depth allowed for literal array values.
 * Inputs deeper than this cap are rejected with a clean structured error
 * rather than causing a stack overflow in zod's recursive descent.
 */
export const LITERAL_MAX_DEPTH = 32;

/**
 * Iteratively measure the maximum nesting depth of a literal value using an
 * explicit stack — no recursion so adversarial deeply-nested inputs cannot
 * cause a stack overflow here.
 *
 * A scalar (non-array) has depth 0. A one-level array like `[1, 2]` has depth
 * 1. `[[1]]` has depth 2, and so on.
 */
function measureLiteralDepth(value: unknown): number {
  let maxDepth = 0;
  // Each entry is [node, currentDepth].
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        stack.push([child, depth + 1]);
      }
    }
  }
  return maxDepth;
}

/**
 * Scalar schema for LiteralValue leaf nodes.
 * Accepts: string | number | boolean | null
 */
const literalScalarSchema: z.ZodType<string | number | boolean | null> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// Internal lazy recursive schema for LiteralValue (no depth bound).
// The depth bound is enforced by literalValueSchema below BEFORE this schema
// is allowed to recurse into user input.
const literalValueSchemaBase: z.ZodType<LiteralValue> = z.lazy(() =>
  z.union([literalScalarSchema, z.array(literalValueSchemaBase)]),
);

/**
 * LiteralValue schema with an iterative depth guard.
 *
 * The superRefine runs an iterative (non-recursive) depth walk before
 * handing off to zod's recursive descent. Inputs nested beyond
 * LITERAL_MAX_DEPTH are rejected with a clean INVALID_SHAPE message
 * instead of crashing with a RangeError.
 */
const literalValueSchema: z.ZodType<LiteralValue> = z
  .unknown()
  .superRefine((val, ctx) => {
    const depth = measureLiteralDepth(val);
    if (depth > LITERAL_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Literal value exceeds maximum nesting depth of ${LITERAL_MAX_DEPTH}`,
      });
      return z.NEVER;
    }
  })
  .pipe(literalValueSchemaBase) as z.ZodType<LiteralValue>;

// ---------------------------------------------------------------------------
// Contract argument discriminated union
// ---------------------------------------------------------------------------

/** `{ kind: "ref", contract: "<non-empty id>" }` */
const refArgSchema = z.object({
  kind: z.literal("ref"),
  contract: z.string().min(1, { message: "ref.contract must be a non-empty string" }),
});

/** `{ kind: "literal", value: <LiteralValue> }` */
const literalArgSchema = z.object({
  kind: z.literal("literal"),
  value: literalValueSchema,
});

/** `{ kind: "param", name: "<non-empty parameter name>" }` */
const paramArgSchema = z.object({
  kind: z.literal("param"),
  name: z.string().min(1, { message: "param.name must be a non-empty string" }),
});

/** `{ kind: "expr", expression: "<non-empty expression>" }` */
const exprArgSchema = z.object({
  kind: z.literal("expr"),
  expression: z.string().min(1, { message: "expr.expression must be a non-empty string" }),
});

/**
 * `{ kind: "resolver", name: "<non-empty resolver name>", args?: <LiteralValue[]> }`
 *
 * Shape validation only — whether `name` is actually registered in the
 * injected `ResolverRegistry` is NOT checked here (validateSpec has no
 * visibility into the registry; see deploy/deploy.ts's pre-resolution pass
 * and resolve/errors.ts's UNKNOWN_RESOLVER error for that check).
 */
export const resolverArgSchema = z.object({
  kind: z.literal("resolver"),
  name: z.string().min(1, { message: "resolver.name must be a non-empty string" }),
  args: z.array(literalValueSchema).optional(),
});

/**
 * `{ kind: "crossRef", network: "<non-empty network name>", contract: "<non-empty id>" }`
 *
 * Shape validation only — both `network` and `contract` are opaque strings to
 * this layer. `network` resolution against an injected journals map, and
 * whether `contract` was actually deployed there, are checked at deploy time
 * by `resolveCrossRefArgs()` (resolve/crossRef.ts) — see `CrossRefArg`'s doc
 * comment in spec/types.ts for the full design.
 */
export const crossRefArgSchema = z.object({
  kind: z.literal("crossRef"),
  network: z.string().min(1, { message: "crossRef.network must be a non-empty string" }),
  contract: z.string().min(1, { message: "crossRef.contract must be a non-empty string" }),
});

/**
 * ContractArg discriminated union.
 * Unknown `kind` values produce a clear parse error.
 */
export const contractArgSchema: z.ZodType<ContractArg> = z.discriminatedUnion("kind", [
  refArgSchema,
  literalArgSchema,
  paramArgSchema,
  exprArgSchema,
  resolverArgSchema,
  crossRefArgSchema,
]);

// ---------------------------------------------------------------------------
// Contract entry
// ---------------------------------------------------------------------------

/**
 * Solidity contract identifier regex (used in both schema validation and the
 * foundryArtifactResolver path-traversal guard).
 */
export const VALID_CONTRACT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ---------------------------------------------------------------------------
// Upgradeable proxy configuration
// ---------------------------------------------------------------------------

/**
 * `{ function: "<non-empty>", args?: ContractArg[] }`
 *
 * Shape validation only. `function` non-emptiness is checked here; whether it
 * is a VALID Solidity identifier (it flows into on-chain calldata via
 * `m.encodeFunctionCall`) is a cross-field rule enforced by validate.ts's
 * `SpecErrorCode` "INVALID_IDENTIFIER" — kept out of this zod layer so
 * validateSpec can attach a precise, dedicated error code instead of a
 * generic INVALID_SHAPE one.
 */
const upgradeableInitializerSchema: z.ZodType<UpgradeableInitializer> = z.object({
  function: z.string().min(1, { message: "upgradeable.initializer.function must be a non-empty string" }),
  args: z.array(contractArgSchema).optional(),
});

/**
 * `{ kind: "uups" | "transparent", initializer?: {...}, proxyAdminOwner?: ContractArg }`
 *
 * Shape validation only. Cross-field rules (proxyAdminOwner REQUIRED for
 * "transparent", rejected for "uups"; ref/param resolution inside
 * initializer.args/proxyAdminOwner) are enforced by validate.ts.
 */
export const upgradeableConfigSchema: z.ZodType<UpgradeableConfig> = z.object({
  kind: z.enum(["uups", "transparent"]),
  initializer: upgradeableInitializerSchema.optional(),
  proxyAdminOwner: contractArgSchema.optional(),
});

export const contractEntrySchema: z.ZodType<ContractEntry> = z.object({
  id: z.string().min(1, { message: "contract entry id must be a non-empty string" }),
  contract: z
    .string()
    .min(1, { message: "contract entry contract must be a non-empty string" })
    .regex(VALID_CONTRACT_NAME_RE, {
      message: "contract entry contract must be a valid Solidity identifier",
    }),
  args: z.array(contractArgSchema).optional(),
  after: z.array(z.string().min(1, { message: "after entry must be a non-empty string" })).optional(),
  upgradeable: upgradeableConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// PREFLIGHT policy — pre-broadcast safety checks (see deploy/preflight.ts)
// ---------------------------------------------------------------------------

/**
 * Matches a non-negative decimal (base-10) integer string with no leading
 * zeros (other than the literal "0" itself), e.g. "0", "42", "1000000000000000000".
 * Used for `minBalanceWei` / `maxGasPriceWei`, which are bigint-as-string
 * encoded wei amounts (see `PreflightPolicy`'s docs in spec/types.ts).
 */
export const DECIMAL_BIGINT_RE = /^(0|[1-9][0-9]*)$/;

/**
 * `{ expectedChainId?: <positive integer>, minBalanceWei?: <decimal string>,
 *    maxGasPriceWei?: <decimal string> }`
 *
 * Shape validation only. All three fields are optional and independent — see
 * `PreflightPolicy`'s docs in spec/types.ts and `runPreflight`'s check
 * semantics in deploy/preflight.ts.
 */
export const preflightPolicySchema: z.ZodType<PreflightPolicy> = z.object({
  expectedChainId: z
    .number()
    .int({ message: "preflight.expectedChainId must be a positive integer" })
    .positive({ message: "preflight.expectedChainId must be a positive integer" })
    .optional(),
  minBalanceWei: z
    .string()
    .regex(DECIMAL_BIGINT_RE, {
      message: "preflight.minBalanceWei must be a non-negative decimal integer string",
    })
    .optional(),
  maxGasPriceWei: z
    .string()
    .regex(DECIMAL_BIGINT_RE, {
      message: "preflight.maxGasPriceWei must be a non-negative decimal integer string",
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Top-level deployment spec
// ---------------------------------------------------------------------------

export const deploymentSpecSchema: z.ZodType<DeploymentSpec> = z.object({
  version: z.literal(1),
  contracts: z.array(contractEntrySchema),
  parameters: z.record(z.string(), literalValueSchema).optional(),
  preflight: preflightPolicySchema.optional(),
});

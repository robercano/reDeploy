/**
 * Zod runtime schema for declarative post-deployment configuration steps.
 *
 * Shape validation only — cross-field rules (duplicate ids, missing refs,
 * self-references) are handled in validate.ts after parsing succeeds.
 *
 * Uses zod 4.4.3 (matching @redeploy/core's exact version).
 * Depth-guard approach mirrors core's schema.ts to prevent stack overflows on
 * adversarially deeply-nested literal values.
 */

import { z } from "zod";
import type { AddressRef, ConfigArg, ConfigArgExtended, ConfigSpec, ConfigStep, LiteralValue } from "./types.js";

// ---------------------------------------------------------------------------
// Literal value (re-implemented here to avoid importing private internals from
// core; the logic is identical to core's literalValueSchema)
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

/** Scalar schema for LiteralValue leaf nodes. */
const literalScalarSchema: z.ZodType<string | number | boolean | null> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// Internal lazy recursive schema (no depth bound — enforced by literalValueSchema below).
const literalValueSchemaBase: z.ZodType<LiteralValue> = z.lazy(() =>
  z.union([literalScalarSchema, z.array(literalValueSchemaBase)]),
);

/**
 * LiteralValue schema with an iterative depth guard.
 *
 * The superRefine runs an iterative (non-recursive) depth walk before handing
 * off to zod's recursive descent. Inputs nested beyond LITERAL_MAX_DEPTH are
 * rejected with a clean message instead of crashing with a RangeError.
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
// ConfigArg discriminated union
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

/**
 * ConfigArg discriminated union.
 * Unknown `kind` values produce a clear parse error.
 */
export const configArgSchema: z.ZodType<ConfigArg> = z.discriminatedUnion("kind", [
  refArgSchema,
  literalArgSchema,
]);

// ---------------------------------------------------------------------------
// AddressRef — explicit address-of-a-deployed-contract reference
// ---------------------------------------------------------------------------

/**
 * Schema for `AddressRef` — a studio-internal address-of-contract reference.
 *
 * `{ kind: "addressRef", deployId: "<non-empty deploy-id>" }`
 *
 * NOTE: `AddressRef` is NOT accepted by `configStepSchema` / the execution
 * engine. Studio components that hold `AddressRef` values must normalise them
 * to `{ kind: "ref", contract: deployId }` before placing them in a
 * `ConfigSpec` that will be validated or executed.
 */
export const addressRefSchema: z.ZodType<AddressRef> = z.object({
  kind: z.literal("addressRef"),
  deployId: z.string().min(1, { message: "addressRef.deployId must be a non-empty string" }),
});

/**
 * Extended arg schema for studio-internal use — accepts `RefArg`, `LiteralArg`,
 * and `AddressRef`.
 *
 * NOTE: this schema is for validating studio-internal arg representations only.
 * It is NOT used by `configStepSchema` or the execution engine. Any `AddressRef`
 * parsed with this schema must be normalised to a `RefArg` before being placed
 * in a `ConfigSpec` for validation or execution.
 */
export const configArgExtendedSchema: z.ZodType<ConfigArgExtended> = z.discriminatedUnion("kind", [
  refArgSchema,
  literalArgSchema,
  z.object({
    kind: z.literal("addressRef"),
    deployId: z.string().min(1, { message: "addressRef.deployId must be a non-empty string" }),
  }),
]);

// ---------------------------------------------------------------------------
// Step schemas
// Note: intermediate step schemas are NOT annotated as ZodType<T> so that
// TypeScript can infer the full discriminated union information needed by
// z.discriminatedUnion(). Only the combined configStepSchema and
// configSpecSchema carry ZodType<T> annotations.
// ---------------------------------------------------------------------------

/**
 * Schema for a `setX` step: generic setter call on a deployed contract.
 */
export const setXStepSchema = z.object({
  kind: z.literal("setX"),
  id: z.string().min(1, { message: "step id must be a non-empty string" }),
  target: z.string().min(1, { message: "setX.target must be a non-empty string" }),
  function: z.string().min(1, { message: "setX.function must be a non-empty string" }),
  args: z.array(configArgSchema).optional(),
});

/**
 * Schema for a `grantRole` step: role grant on an access-controlled contract.
 */
export const grantRoleStepSchema = z.object({
  kind: z.literal("grantRole"),
  id: z.string().min(1, { message: "step id must be a non-empty string" }),
  target: z.string().min(1, { message: "grantRole.target must be a non-empty string" }),
  role: z.string().min(1, { message: "grantRole.role must be a non-empty string" }),
  account: configArgSchema,
});

/**
 * Schema for a `wire` step: wires one deployed contract into another via a setter.
 */
export const wireStepSchema = z.object({
  kind: z.literal("wire"),
  id: z.string().min(1, { message: "step id must be a non-empty string" }),
  source: z.string().min(1, { message: "wire.source must be a non-empty string" }),
  into: z.string().min(1, { message: "wire.into must be a non-empty string" }),
  function: z.string().min(1, { message: "wire.function must be a non-empty string" }),
});

/**
 * ConfigStep discriminated union schema.
 * Unknown `kind` values produce a clear parse error.
 */
export const configStepSchema: z.ZodType<ConfigStep> = z.discriminatedUnion("kind", [
  setXStepSchema,
  grantRoleStepSchema,
  wireStepSchema,
]);

// ---------------------------------------------------------------------------
// Top-level config spec
// ---------------------------------------------------------------------------

/**
 * Top-level ConfigSpec schema.
 *
 * Both `steps` (unordered) and `orderedSteps` (globally ordered) are
 * validated against the same `configStepSchema`. The `orderedSteps` field
 * is optional — existing specs without it remain valid (backward compat).
 *
 * Cross-field rules (duplicate ids across both lists, missing refs) are
 * enforced in validate.ts after this structural parse succeeds.
 */
export const configSpecSchema: z.ZodType<ConfigSpec> = z.object({
  version: z.literal(1),
  steps: z.array(configStepSchema),
  orderedSteps: z.array(configStepSchema).optional(),
});

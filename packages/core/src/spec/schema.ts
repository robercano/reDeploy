/**
 * Zod runtime schema for the declarative deployment spec.
 *
 * Shape validation only — cross-field rules (dup id, missing refs, cycles,
 * self-ref) are handled in validate.ts after parsing succeeds.
 */

import { z } from "zod";
import type { ContractArg, ContractEntry, DeploymentSpec, LiteralValue } from "./types.js";

// ---------------------------------------------------------------------------
// Literal value (recursive JSON-serializable scalar / array)
// ---------------------------------------------------------------------------

/**
 * Lazy recursive schema for LiteralValue.
 * Accepts: string | number | boolean | null | LiteralValue[]
 */
const literalScalarSchema: z.ZodType<string | number | boolean | null> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// We use z.lazy for the recursive array variant.
const literalValueSchema: z.ZodType<LiteralValue> = z.lazy(() =>
  z.union([literalScalarSchema, z.array(literalValueSchema)]),
);

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

/**
 * ContractArg discriminated union.
 * Unknown `kind` values produce a clear parse error.
 */
export const contractArgSchema: z.ZodType<ContractArg> = z.discriminatedUnion("kind", [
  refArgSchema,
  literalArgSchema,
]);

// ---------------------------------------------------------------------------
// Contract entry
// ---------------------------------------------------------------------------

export const contractEntrySchema: z.ZodType<ContractEntry> = z.object({
  id: z.string().min(1, { message: "contract entry id must be a non-empty string" }),
  contract: z.string().min(1, { message: "contract entry contract must be a non-empty string" }),
  args: z.array(contractArgSchema).optional(),
  after: z.array(z.string().min(1, { message: "after entry must be a non-empty string" })).optional(),
});

// ---------------------------------------------------------------------------
// Top-level deployment spec
// ---------------------------------------------------------------------------

export const deploymentSpecSchema: z.ZodType<DeploymentSpec> = z.object({
  version: z.literal(1),
  contracts: z.array(contractEntrySchema),
});

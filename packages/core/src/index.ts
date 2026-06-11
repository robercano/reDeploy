// Declarative deployment spec — types, schema, and validation
export type {
  RefArg,
  LiteralArg,
  LiteralScalar,
  LiteralValue,
  ContractArg,
  ContractEntry,
  DeploymentSpec,
} from "./spec/types.js";

export { contractArgSchema, contractEntrySchema, deploymentSpecSchema } from "./spec/schema.js";

export type { SpecError, SpecErrorCode, ValidateResult } from "./spec/validate.js";
export { validateSpec } from "./spec/validate.js";

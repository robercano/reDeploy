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

// Spec compiler — converts a validated DeploymentSpec into an Ignition module
export type { CompileOptions, CompiledModule } from "./compile/compile.js";
export { compileSpec } from "./compile/compile.js";
export type { CompileErrorCode } from "./compile/errors.js";
export { CompileError } from "./compile/errors.js";

// Deployment runner — idempotent, resumable deploy() backed by Ignition's journal
export type { DeployOptions, DeployResult } from "./deploy/deploy.js";
export { deploy } from "./deploy/deploy.js";
export type { DeployErrorCode } from "./deploy/errors.js";
export { DeployError } from "./deploy/errors.js";

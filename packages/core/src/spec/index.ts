// Browser-safe subpath: deployment spec types, schema, and validation only.
// Importing this entry pulls in NO Ignition/Hardhat code (no native `.node`
// deps), so it is safe to use from browser bundles (e.g. @redeploy/studio).
// For the deploy/compile runtime (Node-only) import the package root instead.

export type {
  RefArg,
  LiteralArg,
  ParamArg,
  ExprArg,
  ResolverArg,
  LiteralScalar,
  LiteralValue,
  ContractArg,
  ContractEntry,
  DeploymentSpec,
} from "./types.js";

export {
  contractArgSchema,
  contractEntrySchema,
  deploymentSpecSchema,
  resolverArgSchema,
} from "./schema.js";

export type { SpecError, SpecErrorCode, ValidateResult } from "./validate.js";
export { validateSpec } from "./validate.js";

export type { EvaluationContext } from "./evaluator.js";
export { evaluateExpression, EvaluationError } from "./evaluator.js";

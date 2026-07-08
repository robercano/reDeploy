// Declarative deployment spec — types, schema, and validation
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
} from "./spec/types.js";

export {
  contractArgSchema,
  contractEntrySchema,
  deploymentSpecSchema,
  resolverArgSchema,
} from "./spec/schema.js";

export type { SpecError, SpecErrorCode, ValidateResult } from "./spec/validate.js";
export { validateSpec } from "./spec/validate.js";

// Spec compiler — converts a validated DeploymentSpec into an Ignition module
export type { CompileOptions, CompiledModule } from "./compile/compile.js";
export { compileSpec, buildCreationOrder } from "./compile/compile.js";
export type { CompileErrorCode } from "./compile/errors.js";
export { CompileError } from "./compile/errors.js";

// Deployment runner — idempotent, resumable deploy() backed by Ignition's journal
export type { DeployOptions, DeployResult } from "./deploy/deploy.js";
export { deploy } from "./deploy/deploy.js";
export type { DeployErrorCode } from "./deploy/errors.js";
export { DeployError } from "./deploy/errors.js";

// Dry-run / plan-only simulation — no chain, no provider, no journal
export type {
  SimulateErrorCode,
  SimulateError,
  PlannedStep,
  SimulateResult,
} from "./simulate/simulate.js";
export { simulate } from "./simulate/simulate.js";

// Artifact resolver helpers — wire deploy() without a Hardhat project
export { foundryArtifactResolver } from "./resolvers/foundry.js";

// EIP-1193 provider factory — wire deploy() with a local key + JSON-RPC URL
export type { JsonRpcProviderOptions } from "./provider/jsonRpc.js";
export { jsonRpcProvider } from "./provider/jsonRpc.js";

// Typed resolver escape-hatch (Layer 2) — async pre-deploy resolution of
// `{ kind: "resolver" }` args against an injected ResolverRegistry, wired via
// DeployOptions.resolvers. See resolve/registry.ts for the full
// Resolver/ResolverContext contract, the v1 scope boundary, and the
// security/trust-boundary notes.
//
// NOTE: resolve/errors.ts's ResolveError is intentionally NOT exported here —
// it is an internal detail of the pre-resolution pass. deploy() always
// catches it and re-throws the equivalent DeployError code (UNKNOWN_RESOLVER
// / RESOLVER_ERROR, exported above via DeployErrorCode), so callers of
// deploy() only ever need to catch DeployError.
export type { Resolver, ResolverContext, ResolverRegistry } from "./resolve/registry.js";

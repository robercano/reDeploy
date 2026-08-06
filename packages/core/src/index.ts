// Declarative deployment spec — types, schema, and validation
export type {
  RefArg,
  LiteralArg,
  ParamArg,
  ExprArg,
  ResolverArg,
  CrossRefArg,
  LiteralScalar,
  LiteralValue,
  ContractArg,
  ContractEntry,
  DeploymentSpec,
  UpgradeableConfig,
  UpgradeableInitializer,
  PreflightPolicy,
} from "./spec/types.js";

export {
  contractArgSchema,
  contractEntrySchema,
  deploymentSpecSchema,
  resolverArgSchema,
  crossRefArgSchema,
  upgradeableConfigSchema,
  preflightPolicySchema,
} from "./spec/schema.js";

export type { SpecError, SpecErrorCode, ValidateResult } from "./spec/validate.js";
export { validateSpec } from "./spec/validate.js";

// Spec compiler — converts a validated DeploymentSpec into an Ignition module
export type { CompileOptions, CompiledModule, UpgradeOptions, UpgradeInitializer } from "./compile/compile.js";
export { compileSpec, buildCreationOrder, compileUpgrade } from "./compile/compile.js";
export type { CompileErrorCode } from "./compile/errors.js";
export { CompileError } from "./compile/errors.js";

// Deployment runner — idempotent, resumable deploy() backed by Ignition's journal
export type { DeployOptions, DeployResult } from "./deploy/deploy.js";
export { deploy } from "./deploy/deploy.js";
export type { DeployErrorCode } from "./deploy/errors.js";
export { DeployError } from "./deploy/errors.js";

// PREFLIGHT phase — declarative pre-broadcast safety checks (chain id,
// deployer balance, gas price ceiling), run BEFORE any transaction is
// broadcast. See deploy/preflight.ts for the full design; DeployOptions.preflight
// and DeploymentSpec.preflight (spec/types.js) feed the effective merged policy.
export type { PreflightFailure, PreflightCheck } from "./deploy/preflight.js";
export { runPreflight } from "./deploy/preflight.js";

// Upgradeable proxy implementation-history data model — types + pure helpers
// only (v1 scope; see deploy/proxyHistory.ts's module doc). NOT wired into
// any reader/verify package — that is explicit follow-up work.
export type {
  ProxyImplementationRecord,
  ProxyImplementationHistory,
} from "./deploy/proxyHistory.js";
export {
  deriveInitialProxyHistory,
  deriveProxyHistoriesFromSpec,
  appendProxyImplementationRecord,
} from "./deploy/proxyHistory.js";

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
export type { JsonRpcProviderOptions, SignerProviderOptions } from "./provider/jsonRpc.js";
export { jsonRpcProvider, signerProvider } from "./provider/jsonRpc.js";

// Pluggable signer seam (issue #154) — generalizes jsonRpcProvider's signing
// step so deploy/config transactions can be signed by an external signer
// (hardware wallet, remote KMS, ...) instead of a raw private key. See
// provider/signer.ts for the full Signer contract.
export type { Signer } from "./provider/signer.js";
export { privateKeySigner } from "./provider/signer.js";

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

// Cross-chain dependency refs (issue #159) — async pre-deploy resolution of
// `{ kind: "crossRef" }` args against an injected map of network -> journal
// location, wired via DeployOptions.crossNetworkJournals. See
// resolve/crossRef.ts for the full ResolveCrossRefOptions/CrossNetworkJournal
// contract and the v1 scope boundary (core has no network registry; the
// referenced network's deployment must already be complete).
//
// Unlike resolve/errors.ts's ResolveError, CrossRefError IS exported here —
// resolveCrossRefArgs() is intended to be callable directly (e.g. by a
// multi-network orchestration layer outside deploy()), not only through
// deploy()'s own pre-resolution pass.
export type { CrossNetworkJournal, ResolveCrossRefOptions } from "./resolve/crossRef.js";
export { resolveCrossRefArgs, specHasCrossRefArgs } from "./resolve/crossRef.js";
export type { CrossRefErrorCode } from "./resolve/crossRefErrors.js";
export { CrossRefError } from "./resolve/crossRefErrors.js";

// Propose execution mode (issue #154) — collects the ordered batch of
// transactions a deployment WOULD send (to/data/value) instead of
// broadcasting them, for external-signer / Safe-multisig workflows. See
// propose/propose.ts for the full design, especially the "JOURNAL SAFETY"
// section (proposed-but-not-executed transactions are never journaled as
// complete), and this package's README ("Propose mode") for the
// propose -> Safe execution -> resume operator flow.
export type { ProposeOptions, ProposeResult, ProposedTransaction } from "./propose/propose.js";
export { proposeDeploy } from "./propose/propose.js";
export type { ProposeErrorCode } from "./propose/errors.js";
export { ProposeError } from "./propose/errors.js";

// Safe Transaction Builder-compatible JSON batch output (issue #154, point 3)
// — a pure, offline transform from ProposeResult.transactions to the Safe
// Transaction Builder batch schema. See safeBatch.ts's module doc for the
// documented scope boundary (raw contract-creation steps, `to: null`,
// cannot be represented — throws SafeBatchError) and the Safe Transaction
// Service API seam (deliberately not implemented).
export type {
  SafeBatchErrorCode,
  SafeBatchJson,
  SafeBatchTransactionJson,
  BuildSafeBatchOptions,
} from "./propose/safeBatch.js";
export { buildSafeBatch, SafeBatchError } from "./propose/safeBatch.js";

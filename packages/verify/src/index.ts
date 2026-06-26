/**
 * @redeploy/verify — Source/bytecode verification for deployed contracts.
 *
 * PUBLIC API
 * ==========
 *
 * Entry point:
 *   verifyDeployment(options)  — submit a set of deployed contracts for
 *                                verification and collect per-contract results.
 *
 * Clients (injectable, HTTP-layer mockable):
 *   createEtherscanClient(config, fetchFn, sleepFn?)
 *   createSourcifyClient(config, fetchFn)
 *
 * Types:
 *   VerifyDeploymentOptions<TSubmitRequest>
 *   VerifyDeploymentResult
 *   ContractVerifyEntry
 *   ContractVerifyResult
 *   VerificationStatus   — "verified" | "already-verified" | "pending" | "failed"
 *   VerifierClient<TSubmitRequest>
 *   SubmitRequest / SubmitResult / StatusResult
 *   EtherscanConfig / EtherscanSubmitRequest
 *   SourcifyConfig / SourcifySubmitRequest
 *   FetchLike            — injectable fetch type
 *
 * Errors (thrown for setup/usage problems, not per-contract provider failures):
 *   VerifyError          — extends Error, has .code: VerifyErrorCode
 *   VerifyErrorCode      — stable discriminated union
 */

// ---------------------------------------------------------------------------
// Core verify orchestrator
// ---------------------------------------------------------------------------
export { verifyDeployment } from "./verify/verify.js";
export type {
  VerifyDeploymentOptions,
  VerifyDeploymentResult,
  ContractVerifyEntry,
  ContractVerifyResult,
  VerificationStatus,
  VerifierClient,
  SubmitRequest,
  SubmitResult,
  StatusResult,
} from "./verify/verify.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export { VerifyError } from "./verify/errors.js";
export type { VerifyErrorCode } from "./verify/errors.js";

// ---------------------------------------------------------------------------
// Etherscan client
// ---------------------------------------------------------------------------
export { createEtherscanClient } from "./verify/clients/etherscan.js";
export type {
  EtherscanConfig,
  EtherscanSubmitRequest,
  FetchLike,
} from "./verify/clients/etherscan.js";

// ---------------------------------------------------------------------------
// Sourcify client
// ---------------------------------------------------------------------------
export { createSourcifyClient } from "./verify/clients/sourcify.js";
export type {
  SourcifyConfig,
  SourcifySubmitRequest,
} from "./verify/clients/sourcify.js";

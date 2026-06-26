/**
 * @redeploy/reader — read-only deployment and configuration state API.
 *
 * Provides a typed, chain-free API to load deployment state (contracts,
 * addresses, constructor args, links) and configuration step status from
 * an on-disk deployment directory written by the reDeploy pipeline.
 */

// Public read API
export {
  readDeployment,
  ReadError,
} from "./read/reader.js";

export type {
  ReadDeploymentOptions,
  DeploymentView,
  ContractView,
  ContractLinks,
  ConfigStepStatus,
  ArgValue,
  BigIntValue,
  ReadErrorCode,
} from "./read/reader.js";

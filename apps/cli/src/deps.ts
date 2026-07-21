/**
 * Injectable bindings to the reDeploy libraries this CLI wraps.
 *
 * Every subcommand receives a `CliDeps` object instead of importing the
 * library functions directly. Production code uses `defaultDeps` (the real
 * library functions); tests inject stubs so subcommand dispatch can be
 * exercised without a live chain, a real Foundry `out/` dir, or network
 * access.
 */

import { deploy, simulate, foundryArtifactResolver, jsonRpcProvider } from "@redeploy/core";
import { applyConfig } from "@redeploy/config";
import { verifyDeployment, verifyConfig, createEtherscanClient, createSourcifyClient } from "@redeploy/verify";
import { readDeployment, buildSnapshot } from "@redeploy/reader";

export interface CliDeps {
  readonly deploy: typeof deploy;
  readonly simulate: typeof simulate;
  readonly foundryArtifactResolver: typeof foundryArtifactResolver;
  readonly jsonRpcProvider: typeof jsonRpcProvider;
  readonly applyConfig: typeof applyConfig;
  readonly verifyDeployment: typeof verifyDeployment;
  readonly verifyConfig: typeof verifyConfig;
  readonly createEtherscanClient: typeof createEtherscanClient;
  readonly createSourcifyClient: typeof createSourcifyClient;
  readonly readDeployment: typeof readDeployment;
  readonly buildSnapshot: typeof buildSnapshot;
  /** Injectable fetch, forwarded to the verify clients (real `fetch` in production). */
  readonly fetch: typeof fetch;
}

export const defaultDeps: CliDeps = {
  deploy,
  simulate,
  foundryArtifactResolver,
  jsonRpcProvider,
  applyConfig,
  verifyDeployment,
  verifyConfig,
  createEtherscanClient,
  createSourcifyClient,
  readDeployment,
  buildSnapshot,
  fetch,
};

/** Type aliases mirroring the deploy-server pattern (avoids importing ignition-core types directly). */
export type ArtifactResolverLike = ReturnType<typeof foundryArtifactResolver>;
export type Eip1193ProviderLike = ReturnType<typeof jsonRpcProvider>;

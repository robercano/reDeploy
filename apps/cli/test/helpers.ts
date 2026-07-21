/** Shared test helpers: build a CommandContext with every CliDeps field stubbed to fail loudly unless overridden. */

import { vi } from "vitest";
import type { CliDeps } from "../src/deps.js";
import type { ResolvedEnv } from "../src/env.js";
import type { CommandContext } from "../src/types.js";

function notImplemented(name: string) {
  return vi.fn(() => {
    throw new Error(`unexpected call to deps.${name} in this test`);
  });
}

export function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    deploy: notImplemented("deploy"),
    simulate: notImplemented("simulate"),
    foundryArtifactResolver: notImplemented("foundryArtifactResolver"),
    jsonRpcProvider: notImplemented("jsonRpcProvider"),
    applyConfig: notImplemented("applyConfig"),
    verifyDeployment: notImplemented("verifyDeployment"),
    verifyConfig: notImplemented("verifyConfig"),
    createEtherscanClient: notImplemented("createEtherscanClient"),
    createSourcifyClient: notImplemented("createSourcifyClient"),
    readDeployment: notImplemented("readDeployment"),
    buildSnapshot: notImplemented("buildSnapshot"),
    fetch: notImplemented("fetch"),
    ...overrides,
  } as unknown as CliDeps;
}

export function makeEnv(overrides: Partial<ResolvedEnv> = {}): ResolvedEnv {
  return {
    rpcUrl: "http://127.0.0.1:8545",
    rawPrivateKey: undefined,
    foundryOut: "/tmp/redeploy-cli-test-out",
    deploymentDir: undefined,
    ...overrides,
  };
}

export function makeCtx(overrides: { deps?: Partial<CliDeps>; env?: Partial<ResolvedEnv> } = {}): CommandContext {
  return { deps: makeDeps(overrides.deps), env: makeEnv(overrides.env) };
}

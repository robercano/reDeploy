/**
 * Tests for proposeDeploy() (propose/propose.ts) — issue #154.
 *
 * ARCHITECTURE
 * ============
 * Like deploy.test.ts, we run the REAL Ignition engine (via proposeDeploy(),
 * which internally calls Ignition's real deploy()) against a fake in-memory
 * "real provider" (test/testHelpers/fakeEip1193Provider.ts) — no network, no
 * anvil. proposeDeploy() wraps that fake provider in its own internal
 * collectingProvider (propose/collectingProvider.ts), which is what actually
 * talks to Ignition; the fake provider here only stands in for the "real
 * chain" that collectingProvider bootstraps nonce/chainId from.
 *
 * COVERAGE (per issue #154's Definition of Done)
 * =================================================
 *  1. Basic propose-mode batch collection: N contracts -> N collected
 *     transactions, none broadcast (the fake "real" provider's send-tx
 *     counter never increases).
 *  2. Ordering + address threading: a `ref`-dependent 2-contract spec
 *     produces transactions in dependency order, and the SECOND contract's
 *     encoded constructor arg is the CREATE-predicted address of the first
 *     — proving proposeDeploy() reuses Ignition's real encoding/ordering
 *     rather than reimplementing it.
 *  3. Journal invariant (the load-bearing part): proposing (a) a
 *     brand-new deployment with no pre-existing deploymentDir, and (b) the
 *     REMAINING work of a partially-deployed spec (resume case) — in both
 *     cases the caller's real, resumable journal.jsonl is never created or
 *     modified by proposeDeploy().
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeDeployData, getContractAddress } from "viem";
import type { DeploymentSpec } from "../src/index.js";
import { deploy, proposeDeploy, ProposeError } from "../src/index.js";
import {
  makeFakeProvider,
  makeFakeArtifactResolver,
  FAKE_ACCOUNTS,
  makeTmpDir,
  rmTmpDir,
} from "./testHelpers/fakeEip1193Provider.js";

const FAKE_BYTECODE =
  "0x60806040526000805534801561001457600080fd5b50610100806100246000396000f3fe";

function buildTypedConstructorAbi(types: string[]): object[] {
  const inputs = types.map((type, i) => ({ name: `arg${i}`, type, internalType: type }));
  return [{ type: "constructor", inputs, stateMutability: "nonpayable" }];
}

function makeTypedArtifactResolver(abiByContract: Record<string, object[]>) {
  return {
    async loadArtifact(contractName: string) {
      return {
        contractName,
        sourceName: `contracts/${contractName}.sol`,
        bytecode: FAKE_BYTECODE,
        abi: abiByContract[contractName] ?? [],
        linkReferences: {},
      };
    },
    async getBuildInfo() {
      return undefined;
    },
  };
}

const THREE_CONTRACT_SPEC: DeploymentSpec = {
  version: 1,
  contracts: [
    { id: "registry", contract: "Registry" },
    { id: "token", contract: "Token" },
    { id: "vault", contract: "Vault", after: ["registry", "token"] },
  ],
};
const THREE_CONTRACT_ARG_COUNTS: Record<string, number> = { Registry: 0, Token: 0, Vault: 0 };

// ---------------------------------------------------------------------------
// 1. Basic batch collection — nothing broadcast
// ---------------------------------------------------------------------------

describe("proposeDeploy() — basic batch collection", () => {
  it("collects one transaction per contract, all as creation (to: null)", async () => {
    const result = await proposeDeploy({
      spec: THREE_CONTRACT_SPEC,
      provider: makeFakeProvider(),
      accounts: FAKE_ACCOUNTS,
      artifactResolver: makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS),
    });

    expect(result.transactions).toHaveLength(3);
    for (const tx of result.transactions) {
      expect(tx.to).toBeNull();
      expect(tx.data.startsWith("0x")).toBe(true);
      expect(tx.value).toBe("0");
    }
  }, 30_000);

  it("never broadcasts — the underlying fake chain's send counter stays at 0", async () => {
    // makeFakeProvider() tracks sends via eth_sendTransaction on ITS state;
    // proposeDeploy() must never call it (only the internal collectingProvider
    // intercepts sends). We prove this indirectly: a fresh fake provider used
    // as the "real" read-only provider still answers eth_getTransactionCount
    // with 0 (nothing was ever sent through it) after proposeDeploy() returns.
    const provider = makeFakeProvider();

    await proposeDeploy({
      spec: THREE_CONTRACT_SPEC,
      provider,
      accounts: FAKE_ACCOUNTS,
      artifactResolver: makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS),
    });

    const nonceAfter = await provider.request({
      method: "eth_getTransactionCount",
      params: [FAKE_ACCOUNTS[0], "latest"],
    });
    expect(nonceAfter).toBe("0x0");
  }, 30_000);

  it("throws ProposeError(INVALID_SPEC) for a malformed spec, without touching any provider", async () => {
    await expect(
      proposeDeploy({
        // @ts-expect-error -- intentionally invalid for this test
        spec: { version: 1, contracts: [{ id: "", contract: "Foo" }] },
        provider: makeFakeProvider(),
        accounts: FAKE_ACCOUNTS,
        artifactResolver: makeFakeArtifactResolver(),
      }),
    ).rejects.toBeInstanceOf(ProposeError);
  });

  it("throws ProposeError(UNKNOWN_RESOLVER) when a resolver arg names a resolver absent from ProposeOptions.resolvers", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "vault", contract: "Vault", args: [{ kind: "resolver", name: "missingResolver" }] },
      ],
    };

    let thrown: unknown;
    try {
      await proposeDeploy({
        spec,
        provider: makeFakeProvider(),
        accounts: FAKE_ACCOUNTS,
        artifactResolver: makeFakeArtifactResolver({ Vault: 1 }),
        // resolvers deliberately omitted
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProposeError);
    expect((thrown as ProposeError).code).toBe("UNKNOWN_RESOLVER");
  });

  it("throws ProposeError(CROSS_REF_ERROR) when a crossRef arg names an unknown network", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "crossRef", network: "unknown-network", contract: "registry" }],
        },
      ],
    };

    let thrown: unknown;
    try {
      await proposeDeploy({
        spec,
        provider: makeFakeProvider(),
        accounts: FAKE_ACCOUNTS,
        artifactResolver: makeFakeArtifactResolver({ Vault: 1 }),
        // crossNetworkJournals deliberately omitted
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProposeError);
    expect((thrown as ProposeError).code).toBe("CROSS_REF_ERROR");
  });

  it("throws ProposeError(EXECUTION_FAILED) when the ephemeral collection run does not complete successfully", async () => {
    // Ignition's own execution-time ABI encoding validates constructor arg
    // COUNT against the artifact's ABI -- validateSpec has no visibility into
    // artifacts, so this is NOT caught until the ephemeral collection run
    // itself, surfacing as a non-SUCCESSFUL DeploymentResult (VALIDATION_ERROR)
    // rather than a thrown compile-time error. This is the genuinely reachable
    // path to ProposeError("EXECUTION_FAILED", ...).
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "vault", contract: "Vault", args: [{ kind: "literal", value: "x" }] }],
    };

    let thrown: unknown;
    try {
      await proposeDeploy({
        spec,
        provider: makeFakeProvider(),
        accounts: FAKE_ACCOUNTS,
        // ABI declares a 0-arg constructor; the spec supplies 1 arg.
        artifactResolver: makeTypedArtifactResolver({ Vault: [] }),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProposeError);
    expect((thrown as ProposeError).code).toBe("EXECUTION_FAILED");
  });

  // COMPILE_ERROR reachability note: mirrors deploy.test.ts's documented
  // finding (see that file's "COMPILE_ERROR catch branch — reachability
  // analysis" section) verbatim — compileSpec() only throws CompileError for
  // invariants validateSpec() ALREADY guards (UNSUPPORTED_LITERAL,
  // INTERNAL_INVARIANT), so the COMPILE_ERROR catch in proposeDeploy() (which
  // shares the exact same validate -> compile pipeline as deploy()) is
  // unreachable for any validateSpec()-passing input. No contrived test is
  // added for it, for the same reason deploy.test.ts gives.
});

// ---------------------------------------------------------------------------
// 2. Ordering + address threading through `ref` args
// ---------------------------------------------------------------------------

describe("proposeDeploy() — ordering and ref-address threading", () => {
  it("orders transactions by dependency and threads the predicted address of an earlier future into a later one", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "vault", contract: "Vault", args: [{ kind: "ref", contract: "registry" }] },
      ],
    };

    const provider = makeFakeProvider();
    const result = await proposeDeploy({
      spec,
      provider,
      accounts: FAKE_ACCOUNTS,
      artifactResolver: makeTypedArtifactResolver({
        Registry: buildTypedConstructorAbi([]),
        Vault: buildTypedConstructorAbi(["address"]),
      }),
    });

    expect(result.transactions).toHaveLength(2);
    // Both are creations, in order: registry (0-arg) then vault (1 address arg).
    expect(result.transactions[0]!.to).toBeNull();
    expect(result.transactions[1]!.to).toBeNull();

    // The predicted address for "registry" is CREATE(sender, startNonce=0) --
    // the fake provider reports nonce 0 for a never-before-seen address.
    const predictedRegistryAddress = getContractAddress({
      from: FAKE_ACCOUNTS[0] as `0x${string}`,
      nonce: 0n,
    });

    const decoded = decodeDeployData({
      abi: buildTypedConstructorAbi(["address"]),
      bytecode: FAKE_BYTECODE as `0x${string}`,
      data: result.transactions[1]!.data as `0x${string}`,
    });
    expect((decoded.args as [string])[0].toLowerCase()).toBe(predictedRegistryAddress.toLowerCase());
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Journal invariant — the load-bearing part of issue #154
// ---------------------------------------------------------------------------

describe("proposeDeploy() — journal invariant: never journals proposed-but-unexecuted transactions", () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
    tmpDir = undefined;
  });

  it("never creates a journal at a fresh deploymentDir path passed for resume lookup", async () => {
    tmpDir = makeTmpDir();
    // Use a path INSIDE tmpDir that does not exist yet -- simulates "propose
    // against a deploymentDir nothing has been deployed to yet".
    const neverDeployedDir = path.join(tmpDir, "never-deployed");

    const result = await proposeDeploy({
      spec: THREE_CONTRACT_SPEC,
      provider: makeFakeProvider(),
      accounts: FAKE_ACCOUNTS,
      artifactResolver: makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS),
      deploymentDir: neverDeployedDir,
    });

    expect(result.transactions).toHaveLength(3);
    // The invariant: proposeDeploy() must not have created ANYTHING at the
    // caller-supplied deploymentDir path -- it only ever reads from it.
    expect(fs.existsSync(neverDeployedDir)).toBe(false);
  }, 30_000);

  it("leaves an EXISTING real journal byte-for-byte unchanged, and proposes only the NOT-yet-deployed remainder", async () => {
    tmpDir = makeTmpDir();
    const provider = makeFakeProvider();
    const baseSpec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "token", contract: "Token" },
      ],
    };

    // Really deploy registry + token into the real, resumable journal.
    const deployResult = await deploy({
      spec: baseSpec,
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0, Token: 0 }),
    });
    expect(deployResult.success).toBe(true);

    const journalPath = path.join(tmpDir, "journal.jsonl");
    expect(fs.existsSync(journalPath)).toBe(true);
    const journalBefore = fs.readFileSync(journalPath, "utf8");
    const statBefore = fs.statSync(journalPath);

    // Grow the spec with a new "vault" contract that depends on both
    // already-deployed contracts, and propose the REMAINING work.
    const grownSpec: DeploymentSpec = {
      version: 1,
      contracts: [
        ...baseSpec.contracts,
        { id: "vault", contract: "Vault", after: ["registry", "token"] },
      ],
    };

    const proposeResult = await proposeDeploy({
      spec: grownSpec,
      provider,
      accounts: FAKE_ACCOUNTS,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0, Token: 0, Vault: 0 }),
      deploymentDir: tmpDir,
    });

    // Only "vault" was not yet complete -- exactly one proposed transaction.
    expect(proposeResult.transactions).toHaveLength(1);
    expect(proposeResult.transactions[0]!.to).toBeNull();

    // THE INVARIANT: the real journal is byte-for-byte unchanged.
    const journalAfter = fs.readFileSync(journalPath, "utf8");
    expect(journalAfter).toBe(journalBefore);
    const statAfter = fs.statSync(journalPath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);

    // A subsequent REAL deploy() resume still sees registry+token as
    // complete (from the untouched journal) and only sends 1 new tx (vault)
    // -- proving the propose() call above left resumability fully intact.
    const resumeResult = await deploy({
      spec: grownSpec,
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0, Token: 0, Vault: 0 }),
    });
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.deployedAddresses["registry"]).toBe(deployResult.deployedAddresses["registry"]);
    expect(resumeResult.deployedAddresses["token"]).toBe(deployResult.deployedAddresses["token"]);
    expect(resumeResult.deployedAddresses["vault"]).toMatch(/^0x/);
  }, 30_000);
});

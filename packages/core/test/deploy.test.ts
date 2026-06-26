/**
 * Tests for the idempotent, resumable deploy() function.
 *
 * ARCHITECTURE
 * ============
 *
 * We run Ignition's actual deploy() (not a mock) against a fake in-memory
 * EIP-1193 provider. The provider:
 *   - Responds to all JSON-RPC methods Ignition uses during a basic-strategy deploy.
 *   - Tracks the number of eth_sendTransaction calls (= contract deploy txs sent).
 *   - Assigns deterministic fake contract addresses per deploy transaction.
 *   - Returns mined receipts with status "0x1" and a contractAddress.
 *   - Simulates a legacy (non-EIP-1559) chain (no baseFeePerGas in block) so
 *     Ignition uses gasPrice, simplifying the provider stub.
 *
 * A configurable ArtifactResolver returns trivial artifacts whose constructor
 * ABI exactly matches the number of args declared in the spec. This is required
 * because Ignition validates constructor arg counts via ethers.Interface.
 *
 * ACCEPTANCE CRITERIA
 * ===================
 *
 * (a) Re-running a COMPLETE deployment is a no-op.
 *     Proof: deploy a 3-contract spec into tmp dir. Assert success. Record
 *     sendTxCount. Deploy AGAIN with the same dir. Assert sendTxCount unchanged
 *     (the journal caused Ignition to skip all already-deployed futures).
 *
 * (b) An INTERRUPTED/partial deployment resumes from where it stopped.
 *     Strategy: deploy a spec where contracts are ordered A → B → C (after
 *     constraints). Run with a provider that allows ONLY the first deploy tx
 *     (for A) to succeed, then throws on the second. This leaves the journal
 *     with one completed future (A). Re-run with a healthy provider against
 *     the same deploymentDir. Assert that only 2 new transactions are sent
 *     (B and C) — A is skipped because its future is already complete in the
 *     journal.
 *
 *     Why this strategy: it directly exercises Ignition's journal-replay path.
 *     The resumed run reads journal.jsonl, sees future A is COMPLETE, and skips
 *     its on-chain transaction — exactly the behavior described in the ticket.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactResolver, Artifact, EIP1193Provider } from "@nomicfoundation/ignition-core";
import { deploy, DeployError } from "../src/index.js";
import type { DeploymentSpec } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers — fake artifacts
// ---------------------------------------------------------------------------

/**
 * Build a trivial constructor ABI fragment with `numInputs` address inputs.
 * Using `address` as param type because ethers encodes it simply and Ignition
 * doesn't validate the *type* against the actual value passed — only the count.
 */
function buildConstructorAbi(numInputs: number): object[] {
  const inputs = Array.from({ length: numInputs }, (_, i) => ({
    name: `arg${i}`,
    type: "address",
    internalType: "address",
  }));
  return [
    {
      type: "constructor",
      inputs,
      stateMutability: "nonpayable",
    },
  ];
}

/**
 * A fake ArtifactResolver backed by a name → argCount map. Returns a trivial
 * non-empty artifact for each contract name, with a constructor ABI that has
 * exactly `argCount` inputs. This is needed because Ignition validates that the
 * number of constructor args in the compiled module matches the ABI.
 */
function makeFakeArtifactResolver(argCounts: Record<string, number> = {}): ArtifactResolver {
  return {
    async loadArtifact(contractName: string): Promise<Artifact> {
      const numArgs = argCounts[contractName] ?? 0;
      return {
        contractName,
        sourceName: `contracts/${contractName}.sol`,
        // Minimal non-zero bytecode (valid hex, starts with 0x)
        bytecode: "0x60806040526000805534801561001457600080fd5b50610100806100246000396000f3fe",
        abi: buildConstructorAbi(numArgs),
        linkReferences: {},
      };
    },
    async getBuildInfo() {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — fake EIP-1193 provider
// ---------------------------------------------------------------------------

/**
 * Shared mutable state for the fake provider, exposed for test assertions.
 */
interface ProviderState {
  /** Total number of eth_sendTransaction calls (= deploy txs sent on-chain). */
  sendTxCount: number;
  /** Current fake block number (incremented per getLatestBlock call). */
  blockNumber: number;
  /** txHash → { blockNumber, contractAddress } for receipt lookups. */
  txReceipts: Map<string, { blockNumber: number; contractAddress: string }>;
  /** sender (lowercased) → nonce */
  nonces: Map<string, number>;
}

function makeProviderState(): ProviderState {
  return {
    sendTxCount: 0,
    blockNumber: 10, // start at block 10 so block-math in nonce sync never underflows
    txReceipts: new Map(),
    nonces: new Map(),
  };
}

/**
 * Build a healthy fake EIP-1193 provider that handles all JSON-RPC calls
 * Ignition makes during a basic-strategy deploy.
 *
 * Design decisions:
 *  - Legacy gas (no baseFeePerGas in block header) → Ignition uses eth_gasPrice,
 *    avoiding the EIP-1559 fee path and eth_maxPriorityFeePerGas.
 *  - Automined simulation: block number increments per getLatestBlock call so
 *    _waitForNextBlock never loops.
 *  - Receipts are available immediately after sendTransaction (no pending state).
 */
function makeFakeProvider(state: ProviderState): EIP1193Provider {
  const CHAIN_ID = "0x7a69"; // 31337

  return {
    async request({
      method,
      params,
    }: {
      method: string;
      params?: readonly unknown[] | object;
    }): Promise<unknown> {
      const p = Array.isArray(params) ? params : [];

      switch (method) {
        // --- automined-network detection (Ignition tries these, we reject) ---
        case "hardhat_getAutomine":
          throw new Error("not supported");
        case "web3_clientVersion":
          throw new Error("not supported");

        case "eth_chainId":
          return CHAIN_ID;

        case "eth_accounts":
          return ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"];

        case "eth_blockNumber":
          return "0x" + state.blockNumber.toString(16);

        case "eth_getBlockByNumber": {
          // Increment block number each call — nonce-sync uses getLatestBlock()
          // and execution engine uses _waitForNextBlock() which polls until
          // block.number increases. Incrementing ensures the engine doesn't loop.
          state.blockNumber += 1;
          return {
            number: "0x" + state.blockNumber.toString(16),
            hash: "0x" + state.blockNumber.toString(16).padStart(64, "0"),
            // NO baseFeePerGas → Ignition picks the legacy gas-price branch
          };
        }

        case "eth_getTransactionCount": {
          const addr = (p[0] as string).toLowerCase();
          return "0x" + (state.nonces.get(addr) ?? 0).toString(16);
        }

        case "eth_gasPrice":
          return "0x3b9aca00"; // 1 gwei

        case "eth_estimateGas":
          return "0x30d40"; // 200_000

        case "eth_sendTransaction": {
          state.sendTxCount += 1;
          const txParams = p[0] as Record<string, unknown>;
          const from = (
            (txParams["from"] as string | undefined) ??
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
          ).toLowerCase();

          const nonce = state.nonces.get(from) ?? 0;
          state.nonces.set(from, nonce + 1);

          // Deterministic tx hash: 0xab…ab + nonce byte
          const txHash = `0x${"ab".repeat(31)}${nonce.toString(16).padStart(2, "0")}`;
          // Deterministic contract address: 0x0000…<sendTxCount * 17>
          const contractAddress = `0x${(state.sendTxCount * 17)
            .toString(16)
            .padStart(40, "0")}`;

          state.blockNumber += 1;
          state.txReceipts.set(txHash, {
            blockNumber: state.blockNumber,
            contractAddress,
          });

          return txHash;
        }

        case "eth_getTransactionByHash": {
          const txHash = p[0] as string;
          const receipt = state.txReceipts.get(txHash);
          if (receipt === undefined) return null;
          // Return a minimal transaction object with `gasPrice` (legacy format)
          // Ignition requires EITHER (maxFeePerGas + maxPriorityFeePerGas) OR gasPrice.
          return {
            hash: txHash,
            blockHash: "0x" + receipt.blockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.blockNumber.toString(16),
            from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            to: null,
            input: "0x",
            value: "0x0",
            chainId: CHAIN_ID,
            nonce: "0x0",
            gasPrice: "0x3b9aca00", // legacy: no maxFeePerGas/maxPriorityFeePerGas
          };
        }

        case "eth_getTransactionReceipt": {
          const txHash = p[0] as string;
          const receipt = state.txReceipts.get(txHash);
          if (receipt === undefined) return null;
          return {
            blockHash: "0x" + receipt.blockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.blockNumber.toString(16),
            status: "0x1",
            contractAddress: receipt.contractAddress,
            logs: [],
          };
        }

        case "eth_getCode":
          // Return non-empty code for any address so Ignition doesn't reject
          return "0x6001";

        case "eth_call":
          return "0x";

        default:
          throw new Error(`FakeProvider: unhandled method "${method}"`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — temp dir
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-test-"));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const ACCOUNTS = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"];

/**
 * A 3-contract spec where:
 *  - Registry and Token have 0 constructor args.
 *  - Vault has 0 constructor args but depends on Token via `after` and
 *    depends on Registry via `after` too.
 *
 * Using `after` rather than `ref` args lets all contracts have empty
 * constructor ABIs (abi: [constructor with 0 inputs]) while still exercising
 * the dependency/ordering logic. This is the correct design: `after` creates
 * ordering without injecting addresses into constructor args.
 *
 * The argCounts map for the resolver: all 3 contracts have 0 constructor params.
 */
const THREE_CONTRACT_SPEC: DeploymentSpec = {
  version: 1,
  contracts: [
    { id: "registry", contract: "Registry" },
    { id: "token", contract: "Token" },
    { id: "vault", contract: "Vault", after: ["registry", "token"] },
  ],
};

const THREE_CONTRACT_ARG_COUNTS: Record<string, number> = {
  Registry: 0,
  Token: 0,
  Vault: 0,
};

// ---------------------------------------------------------------------------
// Basic deployment smoke test
// ---------------------------------------------------------------------------

describe("deploy() — basic deployment", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
  });

  it("returns a successful result with deployed addresses for all contracts", async () => {
    tmpDir = makeTmpDir();
    const state = makeProviderState();

    const result = await deploy({
      spec: THREE_CONTRACT_SPEC,
      provider: makeFakeProvider(state),
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS),
    });

    expect(result.success).toBe(true);
    expect(Object.keys(result.deployedAddresses)).toHaveLength(3);
    expect(result.deployedAddresses["registry"]).toMatch(/^0x/);
    expect(result.deployedAddresses["token"]).toMatch(/^0x/);
    expect(result.deployedAddresses["vault"]).toMatch(/^0x/);
  }, 30_000);

  it("sends exactly 3 deploy transactions for a 3-contract spec", async () => {
    tmpDir = makeTmpDir();
    const state = makeProviderState();

    await deploy({
      spec: THREE_CONTRACT_SPEC,
      provider: makeFakeProvider(state),
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS),
    });

    expect(state.sendTxCount).toBe(3);
  }, 30_000);

  it("exposes the raw ignitionResult for advanced consumers", async () => {
    tmpDir = makeTmpDir();
    const state = makeProviderState();

    const result = await deploy({
      spec: THREE_CONTRACT_SPEC,
      provider: makeFakeProvider(state),
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS),
    });

    expect(result.ignitionResult).toBeDefined();
    expect(result.ignitionResult.type).toBe("SUCCESSFUL_DEPLOYMENT");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Acceptance criterion (a): re-running a COMPLETE deployment is a no-op
// ---------------------------------------------------------------------------

describe("deploy() — acceptance criterion (a): complete re-run is a no-op", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
  });

  it("sends NO new deploy txs on a second run with the same deploymentDir", async () => {
    tmpDir = makeTmpDir();
    const state = makeProviderState();
    const provider = makeFakeProvider(state);
    const artifactResolver = makeFakeArtifactResolver(THREE_CONTRACT_ARG_COUNTS);

    // First run: deploy all 3 contracts
    const firstResult = await deploy({
      spec: THREE_CONTRACT_SPEC,
      provider,
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver,
    });

    expect(firstResult.success).toBe(true);
    const sendCountAfterFirst = state.sendTxCount;
    expect(sendCountAfterFirst).toBe(3);

    // Second run: SAME deploymentDir — journal replays, no new txs
    const secondResult = await deploy({
      spec: THREE_CONTRACT_SPEC,
      provider,
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver,
    });

    // ASSERTION (a): no new on-chain transactions were sent
    expect(secondResult.success).toBe(true);
    expect(state.sendTxCount).toBe(sendCountAfterFirst); // counter MUST NOT increase
    // Addresses must be the same (read from journal, not re-deployed)
    expect(secondResult.deployedAddresses).toEqual(firstResult.deployedAddresses);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Acceptance criterion (b): partial resume deploys only missing contracts
// ---------------------------------------------------------------------------

describe("deploy() — acceptance criterion (b): partial resume deploys only missing contracts", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
  });

  it("resumes a partial deployment and sends transactions only for missing contracts", async () => {
    /**
     * INTERRUPTION STRATEGY
     * =====================
     *
     * We use a linear-dependency spec: registry → token → vault (each `after`
     * its predecessor). This produces 3 sequential batches so each contract is
     * deployed independently. The spec uses `after` constraints, not ref args,
     * so all contracts have 0-arg constructors.
     *
     * Phase 1 (partial): a provider that lets "registry" (batch 1) complete
     * successfully, then throws on `eth_estimateGas` for "token" (the FIRST
     * call into batch 2). Crucially, the throw happens BEFORE Ignition journals
     * the nonce for "token" (TRANSACTION_PREPARE_SEND is written AFTER
     * estimateGas succeeds), so no "missing transaction" (IGN411) state is left.
     * The journal has registry as COMPLETE; token and vault were never started.
     *
     * Phase 2 (resume): a healthy provider + the SAME deploymentDir. Ignition
     * reads the journal, sees registry is COMPLETE, skips its eth_sendTransaction,
     * and deploys only token and vault (2 new transactions).
     *
     * ASSERTION (b): resumeState.sendTxCount === 2
     *   — registry was NOT re-deployed (it was in the journal).
     *   — token and vault WERE deployed (they were missing from the journal).
     */

    tmpDir = makeTmpDir();

    // Linear chain: registry → token → vault
    const linearSpec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "registry", contract: "Registry" },
        { id: "token", contract: "Token", after: ["registry"] },
        { id: "vault", contract: "Vault", after: ["token"] },
      ],
    };

    // Phase 1: partial provider — lets registry succeed, then aborts on
    // estimateGas for token. This avoids the IGN411 "missing transaction" issue
    // because the nonce is only journaled AFTER estimateGas succeeds.
    const partialState = makeProviderState();
    let estimateGasCallCount = 0;

    const partialProvider: EIP1193Provider = {
      async request(args: {
        method: string;
        params?: readonly unknown[] | object;
      }): Promise<unknown> {
        if (args.method === "eth_estimateGas") {
          estimateGasCallCount += 1;
          if (estimateGasCallCount === 1) {
            // First estimateGas (for registry) succeeds
            return makeFakeProvider(partialState).request(args);
          }
          // Second estimateGas (for token) throws — simulates interruption
          // BEFORE any nonce is journaled for token, so no IGN411 on resume.
          throw new Error("Simulated interruption: estimateGas aborted for second contract");
        }
        return makeFakeProvider(partialState).request(args);
      },
    };

    // Phase 1: deploy should fail during batch 2 (token)
    let threwOnPartial = false;
    try {
      await deploy({
        spec: linearSpec,
        provider: partialProvider,
        accounts: ACCOUNTS,
        deploymentDir: tmpDir,
        artifactResolver: makeFakeArtifactResolver({
          Registry: 0,
          Token: 0,
          Vault: 0,
        }),
      });
    } catch {
      threwOnPartial = true;
    }

    expect(threwOnPartial).toBe(true);
    // Registry must have been deployed in Phase 1 (sendTxCount = 1)
    expect(partialState.sendTxCount).toBe(1);

    // Phase 2: resume with a healthy provider + the same deploymentDir.
    // Seed resumeState with the receipts from Phase 1 so the nonce-sync
    // and receipt-lookup code can find the already-deployed registry tx.
    const resumeState = makeProviderState();
    resumeState.blockNumber = partialState.blockNumber;
    for (const [hash, receipt] of partialState.txReceipts) {
      resumeState.txReceipts.set(hash, receipt);
    }
    for (const [addr, nonce] of partialState.nonces) {
      resumeState.nonces.set(addr, nonce);
    }

    const resumeResult = await deploy({
      spec: linearSpec,
      provider: makeFakeProvider(resumeState),
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver({
        Registry: 0,
        Token: 0,
        Vault: 0,
      }),
    });

    // ASSERTION (b): the resume run succeeded
    expect(resumeResult.success).toBe(true);

    // ASSERTION (b): exactly 2 new txs — token and vault. Registry was
    // already complete in the journal and was NOT re-deployed.
    expect(resumeState.sendTxCount).toBe(2);

    // All 3 addresses are available (registry from journal, token+vault from resume)
    expect(Object.keys(resumeResult.deployedAddresses)).toHaveLength(3);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// DeployError — spec validation errors
// ---------------------------------------------------------------------------

describe("deploy() — DeployError on invalid spec", () => {
  it("throws DeployError(INVALID_SPEC) for a spec with a dangling ref", async () => {
    const tmpDir2 = makeTmpDir();
    try {
      const badSpec: DeploymentSpec = {
        version: 1,
        contracts: [
          {
            id: "vault",
            contract: "Vault",
            args: [{ kind: "ref", contract: "nonexistent" }],
          },
        ],
      };

      await expect(
        deploy({
          spec: badSpec,
          provider: makeFakeProvider(makeProviderState()),
          accounts: ACCOUNTS,
          deploymentDir: tmpDir2,
          artifactResolver: makeFakeArtifactResolver(),
        }),
      ).rejects.toThrow(DeployError);

      try {
        await deploy({
          spec: badSpec,
          provider: makeFakeProvider(makeProviderState()),
          accounts: ACCOUNTS,
          deploymentDir: tmpDir2,
          artifactResolver: makeFakeArtifactResolver(),
        });
      } catch (err) {
        expect(err).toBeInstanceOf(DeployError);
        const deployErr = err as DeployError;
        expect(deployErr.code).toBe("INVALID_SPEC");
        expect(deployErr.specErrors).toBeDefined();
        expect(deployErr.specErrors!.length).toBeGreaterThan(0);
      }
    } finally {
      rmTmpDir(tmpDir2);
    }
  });

  it("throws DeployError(INVALID_SPEC) for a spec with a dependency cycle", async () => {
    const tmpDir3 = makeTmpDir();
    try {
      const cyclicSpec: DeploymentSpec = {
        version: 1,
        contracts: [
          { id: "a", contract: "A", args: [{ kind: "ref", contract: "b" }] },
          { id: "b", contract: "B", args: [{ kind: "ref", contract: "a" }] },
        ],
      };

      await expect(
        deploy({
          spec: cyclicSpec,
          provider: makeFakeProvider(makeProviderState()),
          accounts: ACCOUNTS,
          deploymentDir: tmpDir3,
          artifactResolver: makeFakeArtifactResolver(),
        }),
      ).rejects.toThrow(DeployError);
    } finally {
      rmTmpDir(tmpDir3);
    }
  });
});

// ---------------------------------------------------------------------------
// DeployError — constructor and export smoke
// ---------------------------------------------------------------------------

describe("DeployError — class contract", () => {
  it("is exported from the package root", () => {
    expect(typeof DeployError).toBe("function");
  });

  it("INVALID_SPEC instances carry specErrors", () => {
    const err = new DeployError("INVALID_SPEC", "test msg", [
      { path: "contracts[0]", code: "MISSING_REF", message: "missing" },
    ]);
    expect(err.code).toBe("INVALID_SPEC");
    expect(err.specErrors).toHaveLength(1);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DeployError");
  });

  it("COMPILE_ERROR instances have no specErrors", () => {
    const err = new DeployError("COMPILE_ERROR", "compile failed");
    expect(err.code).toBe("COMPILE_ERROR");
    expect(err.specErrors).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Single contract deployment
// ---------------------------------------------------------------------------

describe("deploy() — single contract", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
  });

  it("deploys a single 0-arg contract and returns its address", async () => {
    tmpDir = makeTmpDir();
    const state = makeProviderState();

    const result = await deploy({
      spec: { version: 1, contracts: [{ id: "reg", contract: "Registry" }] },
      provider: makeFakeProvider(state),
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
    });

    expect(result.success).toBe(true);
    expect(result.deployedAddresses["reg"]).toMatch(/^0x/);
    expect(state.sendTxCount).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Empty spec
// ---------------------------------------------------------------------------

describe("deploy() — empty spec", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
  });

  it("succeeds with no on-chain transactions for an empty contracts array", async () => {
    tmpDir = makeTmpDir();
    const state = makeProviderState();

    const result = await deploy({
      spec: { version: 1, contracts: [] },
      provider: makeFakeProvider(state),
      accounts: ACCOUNTS,
      deploymentDir: tmpDir,
      artifactResolver: makeFakeArtifactResolver(),
    });

    expect(result.success).toBe(true);
    expect(Object.keys(result.deployedAddresses)).toHaveLength(0);
    expect(state.sendTxCount).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// On-chain execution failure — success:false return path
// ---------------------------------------------------------------------------

describe("deploy() — on-chain execution failure returns success:false (not thrown)", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
  });

  it("returns success:false with EXECUTION_ERROR ignitionResult when the deploy tx is reverted", async () => {
    /**
     * STRATEGY
     * ========
     * Use a provider variant that returns a FAILED receipt (status "0x0") for
     * the deploy transaction. Ignition's jsonrpc-client maps "0x0" status to
     * TransactionReceiptStatus.FAILURE, which run-strategy.js then surfaces as
     * a REVERTED_TRANSACTION execution result. The execution state becomes FAILED
     * and the Deployer returns DeploymentResultType.EXECUTION_ERROR.
     *
     * The docstring for deploy() promises that on-chain execution errors are
     * RETURNED (result.success === false), not thrown. This test asserts that
     * contract: the call does not throw, result.success is false, and
     * result.ignitionResult.type is not "SUCCESSFUL_DEPLOYMENT".
     *
     * RECEIPT SHAPE
     * =============
     * Ignition's jsonrpc-client validates that the receipt has:
     *   - blockHash: string
     *   - blockNumber: string
     *   - status: string (parsed as hex quantity; "0x0" → FAILURE)
     *   - contractAddress: null | string
     * When status is "0x0" (FAILURE), contractAddress must be null (not a
     * deployed address — the deploy reverted).
     */
    tmpDir = makeTmpDir();
    const state = makeProviderState();

    // Build a provider that delegates everything to the healthy provider
    // except eth_getTransactionReceipt, which returns a failed receipt.
    const failProvider: EIP1193Provider = {
      async request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown> {
        if (args.method === "eth_getTransactionReceipt") {
          const p = Array.isArray(args.params) ? args.params : [];
          const txHash = p[0] as string;
          const receipt = state.txReceipts.get(txHash);
          if (receipt === undefined) return null;
          // Return a FAILED receipt: status "0x0", contractAddress null.
          // Ignition maps this to TransactionReceiptStatus.FAILURE →
          // REVERTED_TRANSACTION → ExecutionStatus.FAILED → EXECUTION_ERROR.
          return {
            blockHash: "0x" + receipt.blockNumber.toString(16).padStart(64, "0"),
            blockNumber: "0x" + receipt.blockNumber.toString(16),
            status: "0x0",
            contractAddress: null,
            logs: [],
          };
        }
        return makeFakeProvider(state).request(args);
      },
    };

    // deploy() must NOT throw — on-chain failures are returned, not thrown.
    let didThrow = false;
    let result;
    try {
      result = await deploy({
        spec: { version: 1, contracts: [{ id: "reg", contract: "Registry" }] },
        provider: failProvider,
        accounts: ACCOUNTS,
        deploymentDir: tmpDir,
        artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
      });
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(false);
    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect(result!.ignitionResult.type).not.toBe("SUCCESSFUL_DEPLOYMENT");
    // On failure, deployedAddresses must be empty (no successful deploys)
    expect(Object.keys(result!.deployedAddresses)).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// COMPILE_ERROR catch branch — reachability analysis
// ---------------------------------------------------------------------------
//
// Finding: the COMPILE_ERROR catch block in deploy.ts (~lines 166-175) is
// UNREACHABLE for any validateSpec-passing input.
//
// Reasoning:
//   1. compileSpec throws CompileError(UNSUPPORTED_LITERAL) only when a literal
//      arg value is not string | number | boolean | null | array. The Zod schema
//      (literalValueSchema) already enforces exactly that set at parse time via
//      literalScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
//      and z.array(literalValueSchemaBase). Any value outside that set fails Zod
//      parsing and is rejected by validateSpec as INVALID_SHAPE — it never reaches
//      compileSpec.
//   2. compileSpec throws CompileError(INTERNAL_INVARIANT) when a ref target is
//      not yet a registered future (forward-reference bug) or when a cycle
//      survives into the topological sort. Both are caught by validateSpec's
//      cross-field phase (MISSING_REF and CYCLE checks) before compileSpec runs.
//   3. No combination of inputs can pass validateSpec and still trigger a
//      CompileError — the invariants that compileSpec guards are a strict subset
//      of those that validateSpec enforces.
//
// Therefore no test is added for the COMPILE_ERROR path through deploy(). Adding
// one would require bypassing validateSpec (e.g. by calling compileSpec directly
// with an invalid spec), which is already covered by compile.test.ts. A test
// that drives deploy() through the COMPILE_ERROR path is impossible without
// casting/mocking, which would not provide meaningful coverage of the real
// code path.

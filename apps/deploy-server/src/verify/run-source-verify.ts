/**
 * Source-verification orchestration for `POST /api/verify/source`.
 *
 * Submits every deployed contract in the persisted deployment to Etherscan
 * (via `@redeploy/verify`'s `verifyDeployment()` + `createEtherscanClient()`),
 * assembling each contract's standard-json-input from its Foundry artifact
 * (see source-input.ts / read-foundry-artifact.ts).
 *
 * GRACEFUL SKIP CONDITIONS (never an error, always a clear `skipped:true`):
 *   - No `ETHERSCAN_API_KEY` configured on the server.
 *   - `chainId === 31337` (local Anvil) — Etherscan verification is
 *     meaningless there.
 *   - No deployed contracts in the persisted deployment.
 *
 * Per-contract, a source-input assembly failure (e.g. the artifact lacks
 * literal source content) degrades that ONE contract to a "skipped" result
 * rather than failing the whole batch — the remaining contracts still get
 * submitted.
 *
 * CONSTRUCTOR ARGUMENTS: not yet ABI-encoded from the deployment's recorded
 * constructor args (out of scope for this wiring pass) — contracts with
 * non-empty constructor args will submit without `constructorArguments`,
 * which may cause Etherscan to reject verification for THOSE contracts
 * specifically (surfaced as a per-contract "failed" result, never a crash).
 *
 * SECRET SAFETY: the Etherscan API key is read once by the caller
 * (env.ts's readEtherscanConfig()) and handed to createEtherscanClient();
 * it is NEVER included in this module's return value.
 */

import { verifyDeployment, createEtherscanClient, VerifyError } from "@redeploy/verify";
import type {
  ContractVerifyEntry,
  ContractVerifyResult,
  EtherscanSubmitRequest,
  FetchLike,
} from "@redeploy/verify";
import type { DeploymentView } from "@redeploy/reader";
import { readFoundryArtifactJson } from "./read-foundry-artifact.js";
import { buildStandardJsonInput } from "./source-input.js";

const ANVIL_CHAIN_ID = 31337;

export type SourceVerifyStatus = "verified" | "already-verified" | "pending" | "failed" | "skipped";

export interface SourceVerifyResultEntry {
  readonly id: string;
  readonly address: string;
  readonly status: SourceVerifyStatus;
  readonly message?: string;
}

export interface SourceVerifyResponse {
  /** True iff every submitted contract reached "verified"/"already-verified". */
  readonly success: boolean;
  /** True iff verification was skipped entirely (see class doc's skip conditions). */
  readonly skipped: boolean;
  /** Present when `skipped` is true, or when the whole batch could not run. */
  readonly reason?: string;
  readonly results: SourceVerifyResultEntry[];
}

export interface RunSourceVerifyOptions {
  readonly deployment: DeploymentView;
  /** Foundry artifacts dir (FOUNDRY_OUT). */
  readonly outDir: string;
  /** Foundry project root (directory containing src/, lib/, out/) for reading literal source files. */
  readonly contractsRoot: string;
  readonly chainId: number;
  /** null => not configured on the server; caller (server.ts) resolves this via env.ts. */
  readonly etherscan: { readonly apiKey: string; readonly apiUrl?: string } | null;
  readonly fetchFn: FetchLike;
}

/**
 * Run source verification for every deployed contract. NEVER throws —
 * setup errors from `@redeploy/verify` (VerifyError) degrade to a
 * `{success:false, skipped:false, reason}` response.
 */
export async function runSourceVerify(options: RunSourceVerifyOptions): Promise<SourceVerifyResponse> {
  const { deployment, outDir, contractsRoot, chainId, etherscan, fetchFn } = options;

  if (etherscan === null) {
    return {
      success: false,
      skipped: true,
      reason: "ETHERSCAN_API_KEY is not configured on the server",
      results: [],
    };
  }

  if (chainId === ANVIL_CHAIN_ID) {
    return {
      success: false,
      skipped: true,
      reason: "Source verification is not meaningful on a local Anvil network (chainId 31337)",
      results: [],
    };
  }

  const deployedContracts = deployment.contracts.filter(
    (c): c is DeploymentView["contracts"][number] & { address: string } => c.address !== null,
  );
  if (deployedContracts.length === 0) {
    return { success: false, skipped: true, reason: "No deployed contracts to verify", results: [] };
  }

  const entries: ContractVerifyEntry[] = [];
  const preResults: SourceVerifyResultEntry[] = [];

  for (const c of deployedContracts) {
    const artifactJson = await readFoundryArtifactJson(outDir, c.contractName);
    const sourceInput = artifactJson !== null ? buildStandardJsonInput(artifactJson, contractsRoot) : null;
    if (sourceInput === null) {
      preResults.push({
        id: c.id,
        address: c.address,
        status: "skipped",
        message: `Could not assemble a compiler input for "${c.contractName}" from its Foundry artifact — source verification skipped for this contract`,
      });
      continue;
    }
    entries.push({
      id: c.id,
      address: c.address,
      contractName: c.contractName,
      compilerVersion: sourceInput.compilerVersion,
      sourceCode: sourceInput.sourceCode,
      codeFormat: sourceInput.codeFormat,
    });
  }

  if (entries.length === 0) {
    return { success: false, skipped: false, results: preResults };
  }

  try {
    // createEtherscanClient() throws VerifyError("MISSING_API_KEY") synchronously
    // for a blank apiKey — kept INSIDE this try so that (defense-in-depth; the
    // `etherscan === null` guard above already covers the normal "unset" case)
    // it degrades to a safe response instead of escaping runSourceVerify().
    const client = createEtherscanClient(
      { apiKey: etherscan.apiKey, ...(etherscan.apiUrl !== undefined ? { apiUrl: etherscan.apiUrl } : {}) },
      fetchFn,
    );

    const result = await verifyDeployment({
      contracts: entries,
      client,
      toSubmitRequest: (entry): EtherscanSubmitRequest => ({
        address: entry.address,
        contractName: entry.contractName,
        sourceCode: entry.sourceCode ?? "",
        compilerVersion: entry.compilerVersion ?? "",
        constructorArguments: entry.constructorArguments,
        codeFormat: entry.codeFormat,
      }),
    });

    const results: SourceVerifyResultEntry[] = [
      ...preResults,
      ...result.results.map(
        (r: ContractVerifyResult): SourceVerifyResultEntry => ({
          id: r.id,
          address: r.address,
          status: r.status,
          message: r.message,
        }),
      ),
    ];

    return { success: result.success && preResults.length === 0, skipped: false, results };
  } catch (err) {
    // Setup errors (VerifyError) must never crash the endpoint.
    const reason = err instanceof VerifyError ? err.message : "Source verification failed unexpectedly";
    return { success: false, skipped: false, reason, results: preResults };
  }
}

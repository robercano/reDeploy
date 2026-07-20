/**
 * `redeploy verify` — thin wrapper over @redeploy/verify.
 *
 * Two targets:
 *   --target deployment (default) -> verifyDeployment(): submit a manifest of
 *     already-deployed contracts to Etherscan or Sourcify for source verification.
 *   --target config -> verifyConfig(): compare live on-chain state against a
 *     ConfigSpec's declared expected values (drift detection). The injectable
 *     ChainReader is built in ../chain.ts, reusing the same address/ABI
 *     resolution `apply-config` uses (readDeployment() + foundryArtifactResolver).
 *
 * Neither mode needs DEPLOYER_PRIVATE_KEY (verification and drift-reading are
 * both read/submit-only operations, no local signing).
 */

import type { ConfigSpec } from "@redeploy/config";
import type { ReadDescriptor } from "@redeploy/verify";
import {
  parseCommandArgs,
  requireString,
  optionalString,
  optionalInt,
  CliUsageError,
  type OptionsSchema,
} from "../args.js";
import { readJsonFile } from "../fsInput.js";
import { buildAddressBook, buildChainReader } from "../chain.js";
import type { CommandContext, CommandOutcome } from "../types.js";

export const SCHEMA: OptionsSchema = {
  target: { type: "string", default: "deployment" },
  // --target deployment
  manifest: { type: "string" },
  provider: { type: "string", default: "etherscan" },
  "api-key": { type: "string" },
  "api-url": { type: "string" },
  "chain-id": { type: "string" },
  // --target config
  "config-spec": { type: "string" },
  reads: { type: "string" },
  "deployment-dir": { type: "string" },
};

export const HELP = `Usage: redeploy verify --target deployment --manifest <manifest.json> [options] [--json]
   or: redeploy verify --target config --config-spec <config-spec.json> --reads <reads.json> [options] [--json]

--target deployment (default): submit already-deployed contracts for source
verification via @redeploy/verify's verifyDeployment().
  --manifest <path>   JSON { chainId?, contracts: ContractVerifyEntry[] } (required)
  --provider <name>   "etherscan" (default) or "sourcify"
  --api-key <key>     Etherscan API key (default: $ETHERSCAN_API_KEY)
  --api-url <url>     Override the provider's default API URL
  --chain-id <n>      Chain id (sourcify only; falls back to the manifest's chainId)

--target config: compare live on-chain state to a ConfigSpec via
@redeploy/verify's verifyConfig().
  --config-spec <path>   ConfigSpec JSON describing expected state (required)
  --reads <path>         JSON map of stepId -> ReadDescriptor (required)
  --deployment-dir <dir> Directory to read deployed addresses from (default: $DEPLOYMENT_DIR)

Common:
  --json          Emit a machine-readable JSON envelope instead of text
  -h, --help      Show this help
`;

/** Manifest entry shape for --target deployment — a superset of ContractVerifyEntry (+ Sourcify's files map). */
interface VerifyManifestEntry {
  readonly id: string;
  readonly address: string;
  readonly contractName: string;
  readonly compilerVersion?: string;
  readonly constructorArguments?: string;
  readonly sourceCode?: string;
  readonly codeFormat?: "solidity-standard-json-input" | "solidity-single-file";
  /** Sourcify only: filename -> content (must include "metadata.json"). */
  readonly files?: Record<string, string>;
}

interface VerifyManifest {
  readonly chainId?: number;
  readonly contracts: VerifyManifestEntry[];
}

function parseManifest(raw: unknown, filePath: string): VerifyManifest {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { contracts?: unknown }).contracts)) {
    throw new CliUsageError(`Manifest at "${filePath}" must be a JSON object with a "contracts" array`);
  }
  return raw as VerifyManifest;
}

async function runDeploymentTarget(
  values: Record<string, string | boolean | undefined>,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  const manifestPath = requireString(values, "manifest", "verify --target deployment");
  const manifest = parseManifest(readJsonFile(manifestPath, "verify manifest"), manifestPath);

  const providerName = optionalString(values, "provider") ?? "etherscan";
  const apiUrl = optionalString(values, "api-url");

  if (providerName === "etherscan") {
    const apiKey = optionalString(values, "api-key") ?? process.env["ETHERSCAN_API_KEY"];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new CliUsageError(
        '"redeploy verify --target deployment --provider etherscan" requires --api-key or ETHERSCAN_API_KEY',
      );
    }
    const client = ctx.deps.createEtherscanClient({ apiKey, apiUrl }, ctx.deps.fetch);
    const result = await ctx.deps.verifyDeployment({
      contracts: manifest.contracts,
      client,
      toSubmitRequest: (entry: VerifyManifestEntry) => ({
        address: entry.address,
        contractName: entry.contractName,
        sourceCode: entry.sourceCode ?? "",
        compilerVersion: entry.compilerVersion ?? "",
        constructorArguments: entry.constructorArguments,
        codeFormat: entry.codeFormat,
      }),
    });
    return { success: result.success, data: result };
  }

  if (providerName === "sourcify") {
    const chainId = manifest.chainId ?? optionalInt(values, "chain-id", "verify");
    if (chainId === undefined) {
      throw new CliUsageError(
        '"redeploy verify --target deployment --provider sourcify" requires --chain-id or a manifest "chainId"',
      );
    }
    const client = ctx.deps.createSourcifyClient({ apiUrl }, ctx.deps.fetch);
    const result = await ctx.deps.verifyDeployment({
      contracts: manifest.contracts,
      client,
      toSubmitRequest: (entry: VerifyManifestEntry) => ({
        address: entry.address,
        contractName: entry.contractName,
        chainId,
        files: entry.files ?? {},
      }),
    });
    return { success: result.success, data: result };
  }

  throw new CliUsageError(`--provider must be "etherscan" or "sourcify", got "${providerName}"`);
}

async function runConfigTarget(
  values: Record<string, string | boolean | undefined>,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  const configSpecPath = requireString(values, "config-spec", "verify --target config");
  const configSpec = readJsonFile(configSpecPath, "ConfigSpec") as ConfigSpec;

  const readsPath = requireString(values, "reads", "verify --target config");
  const reads = readJsonFile(readsPath, "read descriptors") as Record<string, ReadDescriptor>;

  const deploymentDir = optionalString(values, "deployment-dir") ?? ctx.env.deploymentDir;
  if (deploymentDir === undefined) {
    throw new CliUsageError(
      '"redeploy verify --target config" requires --deployment-dir <dir> or DEPLOYMENT_DIR to be set',
    );
  }

  const view = ctx.deps.readDeployment({ deploymentDir });
  const deployedAddresses: Record<string, string> = {};
  for (const contract of view.contracts) {
    if (contract.address !== null) {
      deployedAddresses[contract.id] = contract.address;
    }
  }
  const addressBook = buildAddressBook(view.contracts);
  const artifactResolver = ctx.deps.foundryArtifactResolver(ctx.env.foundryOut);
  const reader = buildChainReader({ rpcUrl: ctx.env.rpcUrl, artifactResolver, addressBook });

  const result = await ctx.deps.verifyConfig({ spec: configSpec, deployedAddresses, reader, reads });
  return { success: result.clean, data: result };
}

export async function run(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
  const { values } = parseCommandArgs(argv, SCHEMA);
  const target = optionalString(values, "target") ?? "deployment";

  if (target === "deployment") return runDeploymentTarget(values, ctx);
  if (target === "config") return runConfigTarget(values, ctx);
  throw new CliUsageError(`--target must be "deployment" or "config", got "${target}"`);
}

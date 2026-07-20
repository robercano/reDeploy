/**
 * `redeploy apply-config` — thin wrapper over @redeploy/config's applyConfig().
 *
 * The deployed-address book (id -> address, address -> contractName) is read
 * from the same journal `status`/`snapshot` use (@redeploy/reader's
 * readDeployment()) rather than re-specified on the command line. The
 * injectable ConfigExecutor is built in ../chain.ts, reusing
 * @redeploy/core's jsonRpcProvider (the same signer deploy() uses) and
 * foundryArtifactResolver (the same ABI source deploy() uses).
 *
 * SECURITY: DEPLOYER_PRIVATE_KEY is read from env only, never echoed.
 */

import {
  parseCommandArgs,
  requireString,
  optionalString,
  CliUsageError,
  type OptionsSchema,
} from "../args.js";
import { readJsonFile } from "../fsInput.js";
import { normalizePrivateKey } from "../env.js";
import { buildAddressBook, buildConfigExecutor } from "../chain.js";
import type { CommandContext, CommandOutcome } from "../types.js";

export const SCHEMA: OptionsSchema = {
  "config-spec": { type: "string" },
  "deployment-dir": { type: "string" },
  "state-dir": { type: "string" },
};

export const HELP = `Usage: redeploy apply-config --config-spec <config-spec.json> [options] [--json]

Resumable, idempotent post-deployment configuration via @redeploy/config's
applyConfig(). Deployed addresses + contract names are read from the
Ignition journal (--deployment-dir) via @redeploy/reader's readDeployment();
steps write to a per-step journal under --state-dir (default: same as
--deployment-dir), so a re-run skips already-completed steps.

Options:
  --config-spec <path>    Path to a ConfigSpec JSON file (required)
  --deployment-dir <dir>  Directory to read deployed addresses from (default: $DEPLOYMENT_DIR)
  --state-dir <dir>       Directory for the config-state journal (default: --deployment-dir)
  --json                  Emit a machine-readable JSON envelope instead of text
  -h, --help              Show this help

Environment (never echoed):
  RPC_URL                JSON-RPC endpoint (default: http://127.0.0.1:8545)
  DEPLOYER_PRIVATE_KEY    Required. Signs transactions locally; never logged.
  FOUNDRY_OUT             Foundry artifacts dir (default: <repo>/contracts/out)
`;

export async function run(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
  const { values } = parseCommandArgs(argv, SCHEMA);
  const configSpecPath = requireString(values, "config-spec", "apply-config");
  const configSpec = readJsonFile(configSpecPath, "ConfigSpec");

  const deploymentDir = optionalString(values, "deployment-dir") ?? ctx.env.deploymentDir;
  if (deploymentDir === undefined) {
    throw new CliUsageError(
      '"redeploy apply-config" requires --deployment-dir <dir> or DEPLOYMENT_DIR to be set',
    );
  }
  const stateDir = optionalString(values, "state-dir") ?? deploymentDir;

  const rawPrivateKey = ctx.env.rawPrivateKey;
  if (rawPrivateKey === undefined || rawPrivateKey.trim() === "") {
    throw new CliUsageError("DEPLOYER_PRIVATE_KEY is not configured");
  }
  const privateKey = normalizePrivateKey(rawPrivateKey);

  const view = ctx.deps.readDeployment({ deploymentDir });

  const deployedAddresses: Record<string, string> = {};
  for (const contract of view.contracts) {
    if (contract.address !== null) {
      deployedAddresses[contract.id] = contract.address;
    }
  }
  const addressBook = buildAddressBook(view.contracts);

  const provider = ctx.deps.jsonRpcProvider({ rpcUrl: ctx.env.rpcUrl, privateKey });
  const artifactResolver = ctx.deps.foundryArtifactResolver(ctx.env.foundryOut);
  const executor = buildConfigExecutor({ provider, artifactResolver, addressBook });

  const result = await ctx.deps.applyConfig({
    spec: configSpec,
    deployedAddresses,
    executor,
    stateDir,
  });

  return { success: result.success, data: result };
}

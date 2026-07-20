/**
 * `redeploy deploy` — thin wrapper over @redeploy/core's deploy().
 *
 * Mirrors apps/deploy-server/src/server.ts's handleDeploy() wiring
 * (jsonRpcProvider + foundryArtifactResolver + accounts derivation), minus
 * the SSE/HTTP transport — this is a synchronous, single-shot CLI call.
 *
 * SECURITY: DEPLOYER_PRIVATE_KEY is read from env only (never a flag, so it
 * never appears in shell history / process argv) and is never included in
 * the returned data or any error message. Only the derived deployer address
 * (accounts[0]) is ever reported.
 */

import * as fs from "node:fs";
import {
  parseCommandArgs,
  requireString,
  optionalString,
  CliUsageError,
  type OptionsSchema,
} from "../args.js";
import { readJsonFile } from "../fsInput.js";
import { normalizePrivateKey } from "../env.js";
import type { CommandContext, CommandOutcome } from "../types.js";

export const SCHEMA: OptionsSchema = {
  spec: { type: "string" },
  "deployment-dir": { type: "string" },
  "module-id": { type: "string" },
};

export const HELP = `Usage: redeploy deploy --spec <deployment-spec.json> [options] [--json]

Idempotent, resumable deployment of a DeploymentSpec via @redeploy/core's
deploy(). Re-running with the same --deployment-dir never re-deploys an
already-completed contract (Ignition journal resume).

Options:
  --spec <path>            Path to a DeploymentSpec JSON file (required)
  --deployment-dir <dir>   Ignition journal directory (default: $DEPLOYMENT_DIR)
  --module-id <id>         Ignition module id (default: "Deployment")
  --json                   Emit a machine-readable JSON envelope instead of text
  -h, --help               Show this help

Environment (never echoed):
  RPC_URL                JSON-RPC endpoint (default: http://127.0.0.1:8545)
  DEPLOYER_PRIVATE_KEY    Required. Signs transactions locally; never logged.
  FOUNDRY_OUT             Foundry artifacts dir (default: <repo>/contracts/out)
`;

export async function run(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
  const { values } = parseCommandArgs(argv, SCHEMA);
  const specPath = requireString(values, "spec", "deploy");
  const spec = readJsonFile(specPath, "DeploymentSpec");

  const deploymentDir = optionalString(values, "deployment-dir") ?? ctx.env.deploymentDir;
  if (deploymentDir === undefined) {
    throw new CliUsageError(
      '"redeploy deploy" requires --deployment-dir <dir> or DEPLOYMENT_DIR to be set',
    );
  }
  const moduleId = optionalString(values, "module-id");

  // SECURITY: validate presence before building anything; never echo the value.
  const rawPrivateKey = ctx.env.rawPrivateKey;
  if (rawPrivateKey === undefined || rawPrivateKey.trim() === "") {
    throw new CliUsageError("DEPLOYER_PRIVATE_KEY is not configured");
  }
  const privateKey = normalizePrivateKey(rawPrivateKey);

  fs.mkdirSync(deploymentDir, { recursive: true });

  const provider = ctx.deps.jsonRpcProvider({ rpcUrl: ctx.env.rpcUrl, privateKey });
  const artifactResolver = ctx.deps.foundryArtifactResolver(ctx.env.foundryOut);
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];

  const result = await ctx.deps.deploy({
    spec: spec as Parameters<typeof ctx.deps.deploy>[0]["spec"],
    provider,
    accounts,
    deploymentDir,
    artifactResolver,
    moduleId,
  });

  return {
    success: result.success,
    data: {
      success: result.success,
      deployer: accounts[0] ?? null,
      deployedAddresses: result.deployedAddresses,
    },
  };
}

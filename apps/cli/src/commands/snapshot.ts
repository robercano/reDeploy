/** `redeploy snapshot` — thin wrapper over @redeploy/reader's buildSnapshot(). */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCommandArgs,
  optionalString,
  optionalInt,
  requireString,
  CliUsageError,
  type OptionsSchema,
} from "../args.js";
import { readJsonFile } from "../fsInput.js";
import type { CommandContext, CommandOutcome } from "../types.js";

export const SCHEMA: OptionsSchema = {
  spec: { type: "string" },
  "deployment-dir": { type: "string" },
  "chain-id": { type: "string" },
  network: { type: "string" },
  "tool-version": { type: "string" },
};

export const HELP = `Usage: redeploy snapshot --spec <deployment-spec.json> --chain-id <n> [options] [--json]

Build a point-in-time DeploymentSnapshot via @redeploy/reader's buildSnapshot(),
reading current state with readDeployment() under the hood.

Options:
  --spec <path>            Path to the DeploymentSpec JSON used for this deployment (required)
  --chain-id <n>           Chain id the deployment targets (required)
  --deployment-dir <dir>   Directory with journal.jsonl (default: $DEPLOYMENT_DIR)
  --network <name>         Optional human-readable network label (e.g. "sepolia")
  --tool-version <ver>     Override the recorded tool version (default: this package's version)
  --json                   Emit a machine-readable JSON envelope instead of text
  -h, --help               Show this help
`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/cli/dist/commands/ -> ../../package.json -> apps/cli/package.json */
const PACKAGE_JSON_PATH = path.resolve(__dirname, "../../package.json");
const FALLBACK_TOOL_VERSION = "0.0.0";

/** Read this package's own `version`. Never throws — falls back on any read/parse error. */
function readToolVersion(): string {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : FALLBACK_TOOL_VERSION;
  } catch {
    return FALLBACK_TOOL_VERSION;
  }
}

export async function run(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
  const { values } = parseCommandArgs(argv, SCHEMA);
  const specPath = requireString(values, "spec", "snapshot");
  const spec = readJsonFile(specPath, "DeploymentSpec");

  const chainId = optionalInt(values, "chain-id", "snapshot");
  if (chainId === undefined) {
    throw new CliUsageError('"redeploy snapshot" requires --chain-id <n>');
  }

  const deploymentDir = optionalString(values, "deployment-dir") ?? ctx.env.deploymentDir;
  if (deploymentDir === undefined) {
    throw new CliUsageError(
      '"redeploy snapshot" requires --deployment-dir <dir> or DEPLOYMENT_DIR to be set',
    );
  }

  const network = optionalString(values, "network");
  const toolVersion = optionalString(values, "tool-version") ?? readToolVersion();

  const snapshot = ctx.deps.buildSnapshot({
    read: { deploymentDir },
    chainId,
    network,
    toolVersion,
    spec: { spec },
  });

  return { success: true, data: snapshot };
}

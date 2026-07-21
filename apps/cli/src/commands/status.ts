/** `redeploy status` — thin wrapper over @redeploy/reader's readDeployment(). */

import { parseCommandArgs, optionalString, CliUsageError, type OptionsSchema } from "../args.js";
import type { CommandContext, CommandOutcome } from "../types.js";

export const SCHEMA: OptionsSchema = {
  "deployment-dir": { type: "string" },
};

export const HELP = `Usage: redeploy status [--deployment-dir <dir>] [--json]

Read the current deployment + config-step state from an Ignition journal via
@redeploy/reader's readDeployment().

Options:
  --deployment-dir <dir>  Directory with journal.jsonl / deployed_addresses.json
                           (default: $DEPLOYMENT_DIR)
  --json                   Emit a machine-readable JSON envelope instead of text
  -h, --help               Show this help
`;

export async function run(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
  const { values } = parseCommandArgs(argv, SCHEMA);
  const deploymentDir = optionalString(values, "deployment-dir") ?? ctx.env.deploymentDir;
  if (deploymentDir === undefined) {
    throw new CliUsageError(
      '"redeploy status" requires --deployment-dir <dir> or DEPLOYMENT_DIR to be set',
    );
  }

  const view = ctx.deps.readDeployment({ deploymentDir });
  return { success: true, data: view };
}

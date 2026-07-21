/** `redeploy simulate` — thin wrapper over @redeploy/core's simulate(). */

import { parseCommandArgs, requireString, type OptionsSchema } from "../args.js";
import { readJsonFile } from "../fsInput.js";
import type { CommandContext, CommandOutcome } from "../types.js";

export const SCHEMA: OptionsSchema = {
  spec: { type: "string" },
};

export const HELP = `Usage: redeploy simulate --spec <deployment-spec.json> [--json]

Dry-run / plan-only simulation of a DeploymentSpec via @redeploy/core's
simulate(). Touches no chain, provider, or filesystem journal.

Options:
  --spec <path>   Path to a DeploymentSpec JSON file (required)
  --json          Emit a machine-readable JSON envelope instead of text
  -h, --help      Show this help
`;

export async function run(argv: string[], ctx: CommandContext): Promise<CommandOutcome> {
  const { values } = parseCommandArgs(argv, SCHEMA);
  const specPath = requireString(values, "spec", "simulate");
  const spec = readJsonFile(specPath, "DeploymentSpec");

  const result = ctx.deps.simulate(spec);
  return { success: result.ok, data: result };
}

/**
 * Command dispatcher for @redeploy/cli.
 *
 * Pure (no direct stdout/stderr writes, no process.exit) so it is fully unit
 * testable: `runCli()` returns `{ exitCode, stdout, stderr }` and the actual
 * writing/exiting happens once, in index.ts (the bin entry point).
 */

import { CliUsageError, parseCommandArgs, flag, type OptionsSchema } from "./args.js";
import { resolveEnv } from "./env.js";
import { defaultDeps, type CliDeps } from "./deps.js";
import { renderResult } from "./output.js";
import type { CommandContext, CommandFn } from "./types.js";

import * as deployCommand from "./commands/deploy.js";
import * as simulateCommand from "./commands/simulate.js";
import * as applyConfigCommand from "./commands/applyConfig.js";
import * as verifyCommand from "./commands/verify.js";
import * as statusCommand from "./commands/status.js";
import * as snapshotCommand from "./commands/snapshot.js";

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandEntry {
  readonly run: CommandFn;
  readonly help: string;
  readonly schema: OptionsSchema;
}

const COMMANDS: Record<string, CommandEntry> = {
  deploy: { run: deployCommand.run, help: deployCommand.HELP, schema: deployCommand.SCHEMA },
  simulate: { run: simulateCommand.run, help: simulateCommand.HELP, schema: simulateCommand.SCHEMA },
  "apply-config": {
    run: applyConfigCommand.run,
    help: applyConfigCommand.HELP,
    schema: applyConfigCommand.SCHEMA,
  },
  verify: { run: verifyCommand.run, help: verifyCommand.HELP, schema: verifyCommand.SCHEMA },
  status: { run: statusCommand.run, help: statusCommand.HELP, schema: statusCommand.SCHEMA },
  snapshot: { run: snapshotCommand.run, help: snapshotCommand.HELP, schema: snapshotCommand.SCHEMA },
};

export const TOP_LEVEL_HELP = `Usage: redeploy <command> [options]

reDeploy — a thin CLI over @redeploy/core, @redeploy/config, @redeploy/verify,
and @redeploy/reader.

Commands:
  deploy         Deploy a DeploymentSpec (idempotent, resumable)
  simulate       Dry-run a DeploymentSpec (no chain access)
  apply-config   Apply a ConfigSpec to already-deployed contracts
  verify         Verify deployed source code, or check on-chain config drift
  status         Read current deployment state
  snapshot       Build a point-in-time deployment snapshot

Global options:
  --json         Emit machine-readable JSON instead of human-readable text
  -h, --help     Show help (global, or "redeploy <command> --help" for a command)

Run "redeploy <command> --help" for command-specific options.
`;

/** Best-effort extraction of a stable `.code` from any of this repo's typed library errors. */
function extractErrorCode(err: unknown): string | undefined {
  if (err instanceof CliUsageError) return "USAGE_ERROR";
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Run the CLI against a raw argv slice (excluding `node`/the script path).
 *
 * Never throws and never touches process.std{out,err}/process.exit — the
 * caller (index.ts) is responsible for writing `stdout`/`stderr` and calling
 * `process.exit(exitCode)`.
 */
export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<RunResult> {
  const [maybeCommand, ...rest] = argv;

  if (maybeCommand === undefined) {
    return { exitCode: 1, stdout: "", stderr: `Missing command.\n\n${TOP_LEVEL_HELP}` };
  }
  if (maybeCommand === "--help" || maybeCommand === "-h") {
    return { exitCode: 0, stdout: TOP_LEVEL_HELP, stderr: "" };
  }

  const entry = COMMANDS[maybeCommand];
  if (entry === undefined) {
    return { exitCode: 1, stdout: "", stderr: `Unknown command "${maybeCommand}".\n\n${TOP_LEVEL_HELP}` };
  }

  // Best-effort pre-parse just to detect --json / --help without duplicating
  // each command's own validation. A parse failure here (e.g. an unknown
  // flag) is swallowed — the command's own run() will re-parse the same argv
  // and throw the authoritative CliUsageError below.
  let json = false;
  try {
    const preParsed = parseCommandArgs(rest, entry.schema);
    json = flag(preParsed.values, "json");
    if (flag(preParsed.values, "help")) {
      return { exitCode: 0, stdout: entry.help, stderr: "" };
    }
  } catch {
    // Fall through — command execution below surfaces the real error.
  }

  const env = resolveEnv();
  const ctx: CommandContext = { env, deps };

  try {
    const outcome = await entry.run(rest, ctx);
    const { text, stream } = renderResult(
      maybeCommand,
      { ok: outcome.success, data: outcome.data },
      json,
      env.rawPrivateKey,
    );
    return stream === "stdout"
      ? { exitCode: outcome.success ? 0 : 1, stdout: text, stderr: "" }
      : { exitCode: 1, stdout: "", stderr: text };
  } catch (err) {
    const code = extractErrorCode(err);
    const message = err instanceof Error ? err.message : String(err);
    const { text } = renderResult(maybeCommand, { ok: false, error: { message, code } }, json, env.rawPrivateKey);
    return { exitCode: 1, stdout: "", stderr: text };
  }
}

/** Shared types passed between cli.ts (the dispatcher) and each commands/*.ts module. */

import type { ResolvedEnv } from "./env.js";
import type { CliDeps } from "./deps.js";

/** Everything a subcommand needs besides its own argv slice. */
export interface CommandContext {
  readonly env: ResolvedEnv;
  readonly deps: CliDeps;
}

/** The result every subcommand's `run()` resolves to (never throws for domain-level failures). */
export interface CommandOutcome {
  readonly success: boolean;
  readonly data: unknown;
}

/** A subcommand entry point. `argv` is the command's own args (command name already stripped). */
export type CommandFn = (argv: string[], ctx: CommandContext) => Promise<CommandOutcome>;

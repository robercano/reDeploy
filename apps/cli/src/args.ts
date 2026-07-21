/**
 * Dependency-free CLI argument parsing for @redeploy/cli.
 *
 * Built entirely on node:util's `parseArgs` (stdlib) — no CLI framework, per
 * the "genuinely thin CLI" requirement.
 */

import { parseArgs as nodeParseArgs, type ParseArgsConfig } from "node:util";

/** Thrown for any bad-input condition: unknown flag, missing required flag, unknown command. */
export class CliUsageError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** A single option's parseArgs-compatible spec, restricted to what this CLI needs. */
export interface OptionSpec {
  readonly type: "string" | "boolean";
  readonly short?: string;
  readonly default?: string | boolean;
}

export type OptionsSchema = Record<string, OptionSpec>;

/** Options every subcommand accepts in addition to its own schema. */
export const COMMON_OPTIONS: OptionsSchema = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

export interface ParsedArgs {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: string[];
}

/**
 * Parse `args` against `schema` (merged with COMMON_OPTIONS).
 *
 * @throws CliUsageError on an unknown flag or a flag used with the wrong
 *   arity (e.g. a string flag with no value). `strict: true` (parseArgs'
 *   default) is what makes it throw for unknown flags.
 */
export function parseCommandArgs(args: string[], schema: OptionsSchema): ParsedArgs {
  const mergedSchema = { ...COMMON_OPTIONS, ...schema };
  try {
    const { values, positionals } = nodeParseArgs({
      args,
      // node:util's parseArgs option type is broader than our OptionsSchema;
      // the runtime shape matches exactly, so this cast is safe.
      options: mergedSchema as NonNullable<ParseArgsConfig["options"]>,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Read a required string flag; throws CliUsageError with a helpful message if absent/empty. */
export function requireString(
  values: Record<string, string | boolean | undefined>,
  key: string,
  commandName: string,
): string {
  const raw = values[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CliUsageError(`"redeploy ${commandName}" requires --${key} <value>`);
  }
  return raw;
}

/** Read an optional string flag. */
export function optionalString(
  values: Record<string, string | boolean | undefined>,
  key: string,
): string | undefined {
  const raw = values[key];
  return typeof raw === "string" ? raw : undefined;
}

/** Read an optional integer flag (base-10). Throws CliUsageError if present but not a valid integer. */
export function optionalInt(
  values: Record<string, string | boolean | undefined>,
  key: string,
  commandName: string,
): number | undefined {
  const raw = optionalString(values, key);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new CliUsageError(`"redeploy ${commandName}" --${key} must be an integer, got "${raw}"`);
  }
  return parsed;
}

/** Read a boolean flag (defaults false). */
export function flag(values: Record<string, string | boolean | undefined>, key: string): boolean {
  return values[key] === true;
}

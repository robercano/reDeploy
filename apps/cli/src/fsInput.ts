/** Small fs-read + JSON.parse helper shared by every subcommand's `--*-file`-style flags. */

import * as fs from "node:fs";
import { CliUsageError } from "./args.js";

/**
 * Read and JSON.parse a file, wrapping any failure (missing file, unreadable,
 * invalid JSON) in a CliUsageError with a description of what was being read.
 */
export function readJsonFile(filePath: string, description: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new CliUsageError(
      `Could not read ${description} at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliUsageError(
      `Could not parse ${description} at "${filePath}" as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

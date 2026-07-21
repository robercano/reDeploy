#!/usr/bin/env node
/**
 * `redeploy` bin entry point.
 *
 * Loads the repo-root `.env` (real env vars always win — see env.ts), runs
 * the CLI against real argv, writes the result to stdout/stderr, and exits
 * with the returned code. All actual logic lives in cli.ts (unit-testable);
 * this file is intentionally excluded from coverage (see vitest.config.ts).
 */

import { loadRepoEnv } from "./env.js";
import { runCli } from "./cli.js";

loadRepoEnv();

const result = await runCli(process.argv.slice(2));

if (result.stdout !== "") {
  process.stdout.write(`${result.stdout}\n`);
}
if (result.stderr !== "") {
  process.stderr.write(`${result.stderr}\n`);
}

process.exit(result.exitCode);

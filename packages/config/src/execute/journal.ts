/**
 * Append-only, crash-safe per-step journal for config execution state.
 *
 * DESIGN
 * ======
 *
 * The journal lives at `<stateDir>/config-state.jsonl` — one JSON object per
 * line (newline-delimited JSON, NDJSON). Each record describes a completed
 * configuration step:
 *
 *   { "id": "<stepId>", "kind": "<stepKind>", "completedAt": "<ISO-8601>" }
 *
 * CRASH SAFETY
 * ============
 *
 * A completion record is appended to the journal ONLY AFTER the on-chain call
 * for that step has succeeded (i.e. the ConfigExecutor.execute() Promise has
 * resolved without throwing). If the process crashes between the on-chain call
 * returning and the append completing, the step is absent from the journal on
 * the next run and will be re-executed. This gives **at-least-once** execution
 * semantics for each step.
 *
 * On-chain idempotency of re-execution is the responsibility of the deployed
 * contracts and is out of scope for this library.
 *
 * APPEND-ONLY DURABILITY
 * ======================
 *
 * Records are written with `fs.appendFileSync` (synchronous, so the OS buffer
 * is flushed before control returns). The file is never truncated or rewritten
 * — only appended. This means a partial write at the end of the file (e.g.
 * from a mid-write crash) leaves a malformed trailing line. The reader skips
 * blank lines and silently drops any line it cannot parse as valid JSON with a
 * recognisable `id` field, so partial writes do not corrupt previously complete
 * records.
 *
 * A missing journal file is treated as an empty set (no steps completed),
 * which is correct for a fresh state directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigExecError } from "./errors.js";
import type { ConfigStep } from "../steps/types.js";

/** The file name for the config-state journal within a stateDir. */
export const JOURNAL_FILE_NAME = "config-state.jsonl";

/** A single record in the journal. */
export interface JournalRecord {
  /** The step id that was completed. */
  readonly id: string;
  /** The step kind at the time of completion. */
  readonly kind: ConfigStep["kind"];
  /** ISO-8601 timestamp of when the step was marked complete. */
  readonly completedAt: string;
}

/**
 * Return the absolute path to the journal file for the given stateDir.
 */
export function journalPath(stateDir: string): string {
  return path.join(stateDir, JOURNAL_FILE_NAME);
}

/**
 * Read the set of completed step ids from the journal at `stateDir`.
 *
 * - Returns an empty Set if the journal file does not exist (fresh run).
 * - Skips blank lines and lines that cannot be parsed as a JSON object with
 *   a non-empty `id` string field (tolerates partial/trailing writes).
 * - Throws `ConfigExecError("JOURNAL_ERROR", ...)` if the file exists but
 *   cannot be opened for reading (e.g. permission denied).
 *
 * @param stateDir - Directory that contains (or will contain) the journal.
 * @returns A `Set<string>` of completed step ids.
 */
export function readCompletedStepIds(stateDir: string): Set<string> {
  const filePath = journalPath(stateDir);

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // No journal yet — this is a fresh run.
      return new Set<string>();
    }
    throw new ConfigExecError(
      "JOURNAL_ERROR",
      `Failed to read config-state journal at "${filePath}": ${nodeErr.message}`,
    );
  }

  const completedIds = new Set<string>();
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      // Skip blank/trailing lines — normal at end-of-file.
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines (e.g. from a partial write at crash time).
      continue;
    }

    // Validate minimal shape: must have a non-empty string `id`.
    if (
      typeof record === "object" &&
      record !== null &&
      "id" in record &&
      typeof (record as Record<string, unknown>).id === "string" &&
      (record as Record<string, unknown>).id !== ""
    ) {
      completedIds.add((record as JournalRecord).id);
    }
  }

  return completedIds;
}

/**
 * Append a "step completed" record to the journal at `stateDir`.
 *
 * Uses `fs.appendFileSync` for durability — the OS write buffer is flushed
 * before this function returns. The stateDir must already exist.
 *
 * IMPORTANT: call this function ONLY after the on-chain call has succeeded.
 * Calling it before (or on failure) would incorrectly mark a step complete
 * and cause it to be skipped on the next run.
 *
 * @param stateDir - Directory that contains the journal.
 * @param record   - The completion record to append.
 */
export function appendCompletedStep(stateDir: string, record: JournalRecord): void {
  const filePath = journalPath(stateDir);
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

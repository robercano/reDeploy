/**
 * Small helper for inspecting Ignition's `journal.jsonl` in e2e resume tests.
 *
 * We deliberately do NOT reimplement any journal semantics here — Ignition
 * owns the journal entirely (see src/deploy/deploy.ts's design note). This
 * module only reads the file for TEST ASSERTIONS: proving that a resume run
 * appended no new execution/transaction entries for futures that were already
 * complete before the resume.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A single parsed line of journal.jsonl. Shape is Ignition-internal and only
 * the fields we assert on are typed here. */
export interface JournalEntry {
  readonly type: string;
  readonly futureId?: string;
  readonly [key: string]: unknown;
}

/** Reads and parses every non-empty line of `<deploymentDir>/journal.jsonl`. */
export function readJournal(deploymentDir: string): JournalEntry[] {
  const journalPath = join(deploymentDir, "journal.jsonl");
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

/** Number of journal.jsonl lines (0 if the file does not exist yet). */
export function journalLineCount(deploymentDir: string): number {
  return readJournal(deploymentDir).length;
}

/**
 * Ignition prefixes every future id with `<moduleId>#` (default moduleId is
 * "Deployment", matching deploy()'s default — see src/deploy/deploy.ts).
 * Use this to translate a spec entry `id` into the futureId that appears in
 * journal.jsonl entries.
 */
export function futureIdFor(entryId: string, moduleId = "Deployment"): string {
  return `${moduleId}#${entryId}`;
}

/**
 * Returns true iff any journal entry AFTER `fromIndex` (exclusive) references
 * `futureId`. Used to assert that a resume run appended NO new execution
 * activity (transaction sends, execution-state re-initialization, etc.) for a
 * future that was already complete before the resume — the strongest
 * available proof, alongside unchanged addresses, that idempotency held.
 */
export function hasActivityForFutureAfter(
  deploymentDir: string,
  futureId: string,
  fromIndex: number,
): boolean {
  const entries = readJournal(deploymentDir);
  return entries.slice(fromIndex).some((entry) => entry.futureId === futureId);
}

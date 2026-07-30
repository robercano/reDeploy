/**
 * Reusable in-core primitive: read the deployed contract addresses recorded
 * in a Hardhat Ignition journal (`<deploymentDir>/journal.jsonl`).
 *
 * This is a pure extraction of the journal-read logic that previously lived
 * only in `deploy/deploy.ts` (as `loadResolvedAddressesFromJournal`, used to
 * populate `ResolverContext.resolvedAddresses` for the SAME network's
 * previous run). It is now a standalone, exported helper so it can ALSO back
 * `resolve/crossRef.ts`'s cross-NETWORK journal reads — the same primitive,
 * applied to a DIFFERENT network's `deploymentDir` rather than the current
 * one.
 *
 * We do NOT reimplement any journal semantics here — Ignition's own
 * `status()` (from `@nomicfoundation/ignition-core`) owns parsing
 * `journal.jsonl` and computing each future's on-chain status; this module
 * only shapes the result into a plain `Record<contractId, address>` keyed by
 * spec entry id (stripping Ignition's `<moduleId>#` future-id prefix).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { status as ignitionStatus } from "@nomicfoundation/ignition-core";

/**
 * Strips Ignition's "<moduleId>#" future-id prefix so callers can index by
 * their spec entry id (e.g. "Deployment#registry" -> "registry").
 */
export function stripModulePrefix(key: string, moduleId: string): string {
  const prefix = `${moduleId}#`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Best-effort read of the contract addresses recorded in a deployment
 * journal at `<deploymentDir>/journal.jsonl`, keyed by spec entry id (the
 * Ignition `<moduleId>#` prefix is stripped).
 *
 * Returns an empty object if no journal exists yet at `deploymentDir` (a
 * fresh/never-deployed directory) — this is expected, documented behavior,
 * not an error. We check `journal.jsonl`'s existence before calling
 * Ignition's `status()` because `status()` throws an `IgnitionError` for a
 * `deploymentDir` with no journal, and callers of this helper (the
 * same-network resolver pre-pass in deploy/deploy.ts, and the cross-network
 * pre-pass in resolve/crossRef.ts) should not need to parse/match that error
 * shape just to handle "nothing deployed there yet".
 *
 * @param deploymentDir The directory containing `journal.jsonl` for the
 *   target network/deployment.
 * @param moduleId      The Ignition module id used when that deployment was
 *   run. Defaults to `"Deployment"` (deploy()'s own default — see
 *   `deploy/deploy.ts`'s `DeployOptions.moduleId`).
 */
export async function loadAddressesFromJournal(
  deploymentDir: string,
  moduleId = "Deployment",
): Promise<Record<string, string>> {
  const journalPath = join(deploymentDir, "journal.jsonl");
  if (!existsSync(journalPath)) {
    return {};
  }
  const statusResult = await ignitionStatus(deploymentDir);
  const addresses: Record<string, string> = {};
  for (const [key, contract] of Object.entries(statusResult.contracts)) {
    addresses[stripModulePrefix(key, moduleId)] = contract.address;
  }
  return addresses;
}

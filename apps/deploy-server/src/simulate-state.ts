/**
 * Persisted "has this spec been simulated?" state, per network — backs the
 * simulate-first interlock for networks configured with
 * `NetworkConfig.requireSimulate === true` (see `networks.ts` and
 * `server.ts`'s `handleSimulate`/`handleDeploy`).
 *
 * DESIGN
 * ======
 *
 * A successful `POST /api/simulate` for a given network records the
 * requested spec's stable hash (see `spec-hash.ts`) into a small JSON file
 * living alongside that network's Ignition journal:
 * `<deploymentDir>/.redeploy-simulated.json`. `deploymentDir` is already a
 * per-network, server-controlled directory (see `networks.ts`'s module
 * doc), so this file is deliberately co-located there rather than in some
 * new, separately-configured path — no new server-side path input, no new
 * attack surface.
 *
 * The file holds a bounded, most-recently-used array of hex hash strings
 * (capped at `MAX_RECORDED_HASHES`) so a long-running server with many
 * distinct simulated specs never grows this file unboundedly. `recordSimulated`
 * evicts the oldest entries first when the cap is exceeded.
 *
 * FAILURE POSTURE
 * ================
 *
 * `hasSimulated` is used by `handleDeploy`'s pre-broadcast interlock CHECK:
 * it must fail CLOSED — any inability to positively confirm a prior
 * simulate (file missing, corrupt, unreadable) is treated as "not
 * simulated", so `requireSimulate` still refuses the deploy. This is why
 * `hasSimulated` swallows all errors and returns `false` rather than
 * throwing.
 *
 * `recordSimulated`, by contrast, is invoked on the SUCCESS path of
 * `POST /api/simulate` and is explicitly best-effort: a write failure here
 * must never turn a successful simulate into an error response (see
 * `handleSimulate`'s doc comment). Failures are logged as a single generic
 * stderr line (no path/error detail — consistent with this codebase's
 * existing "never leak server-side paths" discipline) and otherwise
 * swallowed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Filename of the per-network simulated-spec-hash record, under `deploymentDir`. */
const SIMULATED_STATE_FILENAME = ".redeploy-simulated.json";

/** Maximum number of distinct spec hashes retained per network (most-recent-first). */
const MAX_RECORDED_HASHES = 50;

interface SimulatedStateFile {
  hashes?: unknown;
}

function stateFilePath(deploymentDir: string): string {
  return path.join(deploymentDir, SIMULATED_STATE_FILENAME);
}

/**
 * Read the recorded hash list from `deploymentDir`'s state file.
 *
 * Never throws: a missing file, unreadable file, malformed JSON, or a JSON
 * shape that isn't `{ hashes: string[] }` all resolve to an empty array —
 * "no record" is always a safe, fail-closed default for the interlock check
 * this backs (see this module's doc comment).
 */
function readRecordedHashes(deploymentDir: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFilePath(deploymentDir), "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const hashes = (parsed as SimulatedStateFile).hashes;
  if (!Array.isArray(hashes)) {
    return [];
  }
  return hashes.filter((h): h is string => typeof h === "string");
}

/**
 * Record that `hash` has been successfully simulated for the network whose
 * Ignition journal lives at `deploymentDir`.
 *
 * Best-effort: `deploymentDir` is created if missing (`mkdir -p`), and any
 * read/parse/write failure is caught, logged as a single generic stderr
 * line, and otherwise swallowed — this function must never throw in a way
 * that turns a successful simulate into an error response.
 *
 * Bounded: retains at most `MAX_RECORDED_HASHES` entries, most-recent-first
 * (an existing entry being re-recorded is moved to the front rather than
 * duplicated).
 */
export function recordSimulated(deploymentDir: string, hash: string): void {
  try {
    fs.mkdirSync(deploymentDir, { recursive: true });
    const existing = readRecordedHashes(deploymentDir);
    const withoutHash = existing.filter((h) => h !== hash);
    const updated = [hash, ...withoutHash].slice(0, MAX_RECORDED_HASHES);
    const payload: SimulatedStateFile = { hashes: updated };
    fs.writeFileSync(stateFilePath(deploymentDir), JSON.stringify(payload), "utf8");
  } catch {
    process.stderr.write("[deploy-server] failed to persist simulated-spec state\n");
  }
}

/**
 * Whether `hash` has previously been recorded as simulated for the network
 * whose Ignition journal lives at `deploymentDir`.
 *
 * Fails CLOSED: any error reading/parsing the state file resolves to
 * `false` ("not simulated") — see this module's doc comment. Never throws.
 */
export function hasSimulated(deploymentDir: string, hash: string): boolean {
  return readRecordedHashes(deploymentDir).includes(hash);
}

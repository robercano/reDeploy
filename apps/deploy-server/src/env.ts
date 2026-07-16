import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory of this compiled module (apps/deploy-server/dist/).
 * Used to compute the repo root from a relative offset, mirroring the
 * DEFAULT_FOUNDRY_OUT resolution in server.ts.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo root, resolved relative to the compiled dist/ dir:
 *   apps/deploy-server/dist/ -> ../../.. -> repo root
 */
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

/** Default path to the repo-root `.env` file. */
const DEFAULT_ENV_PATH = path.join(DEFAULT_REPO_ROOT, ".env");

/**
 * Parse the raw contents of a `.env`-style file into a plain key/value map.
 *
 * Rules:
 *   - Blank lines and lines starting with `#` (after trimming) are skipped.
 *   - A line without an `=` is skipped.
 *   - Keys and values are trimmed.
 *   - A value wrapped in matching single or double quotes has the quotes
 *     stripped (after trimming).
 *   - Later duplicate keys in the same file overwrite earlier ones.
 *
 * This is intentionally minimal (no multi-line values, no `export` prefix,
 * no variable interpolation) — it only needs to support simple
 * `KEY=VALUE` `.env` files like this repo's `.env.example`.
 */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    if (key === "") continue;

    let value = line.slice(eqIdx + 1).trim();
    const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load the repo-root `.env` file (if present) into `process.env`.
 *
 * Precedence: a variable that is already set in `process.env` is NEVER
 * overridden by a value from the file — real environment variables (e.g.
 * set by the shell, a process manager, or CI) always win.
 *
 * A missing (or unreadable) `.env` file is a silent no-op: this function
 * never throws.
 *
 * @param options.envPath - Override the `.env` path (used by tests). Defaults
 *   to `<repo-root>/.env`, resolved relative to this compiled module so it
 *   does not depend on the current working directory.
 */
export function loadRepoEnv(options?: { envPath?: string }): void {
  const envPath = options?.envPath ?? DEFAULT_ENV_PATH;

  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    // Missing file (or any other read error) is a silent no-op.
    return;
  }

  const parsed = parseEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Normalize a raw private key string for use with viem's
 * `privateKeyToAccount`, which requires a `0x`-prefixed hex string.
 *
 * - Trims surrounding whitespace.
 * - Prepends `0x` when the (trimmed) value does not already start with
 *   `0x` or `0X`.
 *
 * SECURITY: this function must never log or throw on its input — it is on
 * the private-key path.
 */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return trimmed;
  }
  return `0x${trimmed}`;
}

/**
 * Server-side Etherscan verification config, read from `process.env`.
 *
 * `apiUrl` lets a non-mainnet (or Etherscan-compatible) API base be used —
 * see `.env.example`'s `ETHERSCAN_API_URL` comment. Omitted entirely when not
 * set, so `createEtherscanClient()`'s own default
 * (`https://api.etherscan.io/api`) applies.
 */
export interface EtherscanEnvConfig {
  readonly apiKey: string;
  readonly apiUrl?: string;
}

/**
 * Read the server-side Etherscan verification config from `process.env`.
 *
 * Returns `null` when `ETHERSCAN_API_KEY` is unset or blank — callers MUST
 * treat this as "source verification is not configured" and skip cleanly
 * (never throw, never attempt a request). The key is read directly here and
 * handed to `@redeploy/verify`'s `createEtherscanClient()`; it is NEVER
 * logged, and NEVER included in any HTTP response body.
 */
export function readEtherscanConfig(): EtherscanEnvConfig | null {
  const apiKey = process.env["ETHERSCAN_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    return null;
  }
  const apiUrl = process.env["ETHERSCAN_API_URL"];
  return apiUrl !== undefined && apiUrl.trim() !== "" ? { apiKey, apiUrl } : { apiKey };
}

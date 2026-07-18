/**
 * Server-side network registry for @redeploy/deploy-server.
 *
 * DESIGN
 * ======
 *
 * The server can be configured with one or more named "networks" — each a
 * bundle of chain-specific connection details (RPC endpoint, deployer key,
 * journal directory, Ignition deployment parameters). Clients (the studio)
 * select a network BY NAME ONLY: the name is an opaque lookup key validated
 * against this server-defined registry (an allowlist). RPC URLs, private
 * keys, chain ids, and filesystem paths NEVER come from client input — only
 * the string used to look them up does. This mirrors the security posture of
 * the pre-existing `resolveDeploymentDir()` boundary in `server.ts`: a
 * client-controlled path/URL/credential would open path-traversal, SSRF, or
 * credential-injection holes, so those values are resolved strictly from
 * server-side configuration.
 *
 * BACKWARD COMPATIBILITY
 * =======================
 *
 * A network named `"default"` (see `DEFAULT_NETWORK_NAME`) is ALWAYS present
 * in the registry, synthesized from the same legacy env vars the server used
 * before multi-network support existed:
 *   - `RPC_URL`              (default: `http://127.0.0.1:8545`)
 *   - `DEPLOYER_PRIVATE_KEY` (default: unset)
 *   - `DEPLOYMENT_DIR`       (default: `<tmp>/redeploy-deployments/default`)
 *
 * When no `NETWORKS_CONFIG` file is configured, the registry contains only
 * this one network, and it is the default — so a server with no networks
 * config behaves EXACTLY as before. A request that does not specify
 * `?network=` also resolves to the default network, so existing callers (the
 * studio, prior to its own network-selection UI) keep working unmodified.
 *
 * CONFIGURATION SCHEMA
 * =====================
 *
 * Additional named networks are loaded from a JSON file, when the
 * `NETWORKS_CONFIG` env var is set to its (absolute or CWD-relative) path:
 *
 *   {
 *     "defaultNetwork": "sepolia",              // optional; else "default"
 *     "networks": {
 *       "local": {
 *         "rpcUrl": "http://127.0.0.1:8545"
 *       },
 *       "sepolia": {
 *         "rpcUrl": "https://sepolia.example.com/v3/KEY",
 *         "chainId": 11155111,                  // optional, informational
 *         "deployerPrivateKeyEnv": "SEPOLIA_DEPLOYER_KEY", // preferred: read from env
 *         "deployerPrivateKey": "0x...",         // alternative: literal (avoid committing secrets)
 *         "deploymentDir": "/var/redeploy/sepolia", // optional; else derived
 *         "moduleId": "Deployment",              // optional; else "Deployment"
 *         "deploymentParameters": {               // optional; flat paramName -> value,
 *           "someParam": 123                      // wrapped under `moduleId` before
 *         }                                        // being passed to core.deploy()
 *       }
 *     }
 *   }
 *
 * PRECEDENCE: a network's `deploymentParameters` OVERRIDE any value the
 * request body's `spec.parameters` carries for the same parameter name —
 * including values the studio baked in from its client-side per-network
 * `networkOverrides` (the studio emits those as spec.parameters DEFAULTS,
 * not as deploymentParameters, when it generates the spec — see
 * `server.ts`'s `handleDeploy` doc block for the wire-level detail). This is
 * Ignition's own parameter precedence (a module's `m.getParameter(name,
 * defaultValue)` default loses to a `deploymentParameters` entry for the
 * same name) — reDeploy does not reimplement it, it only wires this
 * registry's `deploymentParameters` through to `core.deploy()`. Verified
 * end-to-end (real two-Anvil chains, no mocks) in
 * test/e2e/multi-network.e2e.test.ts. Rationale: server config here is
 * trusted infrastructure (same boundary as `rpcUrl` / `deployerPrivateKey`)
 * and must not be silently overridable by a client-supplied spec value.
 *
 * Notes:
 *   - `rpcUrl` is required for every entry.
 *   - `deployerPrivateKeyEnv` (an env var NAME) is preferred over the literal
 *     `deployerPrivateKey` field so the JSON config file itself never needs to
 *     contain secret material — only names of env vars the real secrets live
 *     in. If both are present, `deployerPrivateKeyEnv` wins.
 *   - `deploymentDir`, when omitted, defaults to
 *     `<tmp>/redeploy-deployments/<networkName>` — a stable, per-network
 *     directory so Ignition journals (and therefore resume state) for
 *     different networks never collide.
 *   - A network named `"default"` in the config file OVERRIDES the
 *     synthesized legacy default described above.
 *   - `defaultNetwork` (top-level) selects which registry entry is used when
 *     a request omits `?network=`. It can also be overridden by the
 *     `DEFAULT_NETWORK` env var (checked after the file is loaded).
 *   - Network names are restricted to `[A-Za-z0-9_-]+` (validated at load
 *     time) — defense in depth for the derived-deploymentDir path segment,
 *     even though names only ever originate from trusted server config, never
 *     from client input.
 *
 * WIRE SHAPE
 * ==========
 *
 * All three HTTP endpoints (`POST /api/simulate`, `POST /api/deploy`,
 * `GET /api/deployment`) accept an OPTIONAL `?network=<name>` query param.
 * The POST body remains the bare `DeploymentSpec` (no envelope) for full
 * backward compatibility with existing callers. Omitting `?network=` selects
 * the registry's default network.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeployOptions } from "@redeploy/core";

// ---------------------------------------------------------------------------
// Types derived from @redeploy/core's public surface (avoids a direct
// dependency on @nomicfoundation/ignition-core just for these type shapes).
// ---------------------------------------------------------------------------

type DeploymentParameters = NonNullable<DeployOptions["deploymentParameters"]>;

/** Flat `paramName -> value` map for a single Ignition module. */
export type ModuleParameters = DeploymentParameters[string];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Resolved, runtime configuration for a single named network. This is the
 * shape stored in `NetworksRegistry.networks` — always fully resolved (e.g.
 * `deploymentDir` is always populated, defaulted when not explicit).
 */
export interface NetworkConfig {
  /** JSON-RPC endpoint URL for this network. */
  readonly rpcUrl: string;
  /** Optional expected chain id — informational only today. */
  readonly chainId?: number;
  /** Deployer account private key for this network, if configured. */
  readonly deployerPrivateKey?: string;
  /**
   * Directory where Ignition persists the deployment journal for this
   * network. Always populated: explicit config value, or
   * `<tmp>/redeploy-deployments/<networkName>` when omitted.
   */
  readonly deploymentDir: string;
  /**
   * Ignition deployment parameters for this network, as a flat
   * `paramName -> value` map (NOT pre-keyed by module id — the caller wraps
   * this under the resolved `moduleId` before passing it to `core.deploy()`).
   */
  readonly deploymentParameters?: ModuleParameters;
  /** Ignition module id override for this network. Defaults to `"Deployment"`. */
  readonly moduleId?: string;
}

/** The full set of configured networks plus which one is the default. */
export interface NetworksRegistry {
  /**
   * Networks keyed by name. A `Map` (not a plain object) is used
   * deliberately so that `resolveNetwork()`'s lookup can never be
   * influenced by prototype properties (`__proto__`, `constructor`, ...)
   * on a plain-object registry — defense in depth even though the lookup
   * key here is validated against this allowlist, not used to index
   * anything else.
   */
  readonly networks: ReadonlyMap<string, NetworkConfig>;
  /** The network name used when a request does not specify `?network=`. */
  readonly defaultNetworkName: string;
}

/** Thrown for a malformed/unreadable `NETWORKS_CONFIG` file or default-network reference. */
export class NetworksConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworksConfigError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The always-present network name synthesized from legacy env vars. */
export const DEFAULT_NETWORK_NAME = "default";

/** Default RPC URL for the legacy `"default"` network — matches pre-multi-network behavior. */
const DEFAULT_RPC_URL = "http://127.0.0.1:8545";

/** Default Ignition module id, mirroring `@redeploy/core`'s own default. */
export const DEFAULT_MODULE_ID = "Deployment";

/** Allowed characters for a network name — defense in depth for path derivation. */
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultDeploymentDirFor(networkName: string): string {
  return path.join(os.tmpdir(), "redeploy-deployments", networkName);
}

interface RawNetworkConfig {
  rpcUrl?: unknown;
  chainId?: unknown;
  deployerPrivateKey?: unknown;
  deployerPrivateKeyEnv?: unknown;
  deploymentDir?: unknown;
  deploymentParameters?: unknown;
  moduleId?: unknown;
}

interface RawNetworksConfigFile {
  defaultNetwork?: unknown;
  networks?: unknown;
}

/**
 * Read, parse, and validate the `NETWORKS_CONFIG` JSON file.
 *
 * @throws NetworksConfigError on any read/parse/schema failure. The thrown
 *   message may include the (server-configured, trusted) file path — this is
 *   never sent to a client; callers must catch it and respond with a generic
 *   error (see `server.ts`'s `resolveNetworkForRequest`).
 */
function readNetworksConfigFile(
  rawPath: string,
  env: NodeJS.ProcessEnv,
): { networks: Record<string, NetworkConfig>; defaultNetwork?: string } {
  const resolvedPath = path.resolve(rawPath);

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new NetworksConfigError(
      `Failed to read NETWORKS_CONFIG file at "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new NetworksConfigError(
      `Failed to parse NETWORKS_CONFIG file at "${resolvedPath}" as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NetworksConfigError(`NETWORKS_CONFIG file at "${resolvedPath}" must contain a JSON object`);
  }
  const raw = parsed as RawNetworksConfigFile;

  const rawNetworks = raw.networks;
  if (typeof rawNetworks !== "object" || rawNetworks === null || Array.isArray(rawNetworks)) {
    throw new NetworksConfigError(`NETWORKS_CONFIG file at "${resolvedPath}": "networks" must be an object`);
  }

  const networks: Record<string, NetworkConfig> = {};
  for (const [name, rawEntry] of Object.entries(rawNetworks as Record<string, unknown>)) {
    if (!NETWORK_NAME_PATTERN.test(name)) {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": network name "${name}" is invalid — only letters, digits, "_" and "-" are allowed`,
      );
    }
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      throw new NetworksConfigError(`NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" must be an object`);
    }
    const entry = rawEntry as RawNetworkConfig;

    if (typeof entry.rpcUrl !== "string" || entry.rpcUrl.trim() === "") {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" is missing a string "rpcUrl"`,
      );
    }

    let deployerPrivateKey: string | undefined;
    if (entry.deployerPrivateKeyEnv !== undefined) {
      if (typeof entry.deployerPrivateKeyEnv !== "string" || entry.deployerPrivateKeyEnv.trim() === "") {
        throw new NetworksConfigError(
          `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" has an invalid "deployerPrivateKeyEnv"`,
        );
      }
      deployerPrivateKey = env[entry.deployerPrivateKeyEnv];
    } else if (entry.deployerPrivateKey !== undefined) {
      if (typeof entry.deployerPrivateKey !== "string") {
        throw new NetworksConfigError(
          `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" has an invalid "deployerPrivateKey"`,
        );
      }
      deployerPrivateKey = entry.deployerPrivateKey;
    }

    if (entry.chainId !== undefined && typeof entry.chainId !== "number") {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" has a non-numeric "chainId"`,
      );
    }
    if (entry.deploymentDir !== undefined && typeof entry.deploymentDir !== "string") {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" has a non-string "deploymentDir"`,
      );
    }
    if (entry.moduleId !== undefined && typeof entry.moduleId !== "string") {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" has a non-string "moduleId"`,
      );
    }
    if (
      entry.deploymentParameters !== undefined &&
      (typeof entry.deploymentParameters !== "object" ||
        entry.deploymentParameters === null ||
        Array.isArray(entry.deploymentParameters))
    ) {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": network "${name}" has an invalid "deploymentParameters" (must be an object)`,
      );
    }

    networks[name] = {
      rpcUrl: entry.rpcUrl,
      ...(entry.chainId !== undefined ? { chainId: entry.chainId as number } : {}),
      ...(deployerPrivateKey !== undefined ? { deployerPrivateKey } : {}),
      deploymentDir: (entry.deploymentDir as string | undefined) ?? defaultDeploymentDirFor(name),
      ...(entry.deploymentParameters !== undefined
        ? { deploymentParameters: entry.deploymentParameters as ModuleParameters }
        : {}),
      ...(entry.moduleId !== undefined ? { moduleId: entry.moduleId as string } : {}),
    };
  }

  let defaultNetwork: string | undefined;
  if (raw.defaultNetwork !== undefined) {
    if (typeof raw.defaultNetwork !== "string" || raw.defaultNetwork.trim() === "") {
      throw new NetworksConfigError(
        `NETWORKS_CONFIG file at "${resolvedPath}": "defaultNetwork" must be a non-empty string`,
      );
    }
    defaultNetwork = raw.defaultNetwork;
  }

  return { networks, defaultNetwork };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the server's network registry, STRICTLY from server-side
 * configuration (env vars and, optionally, the `NETWORKS_CONFIG` JSON file
 * it points to) — never from any client-supplied input. See this module's
 * doc comment for the full schema and backward-compatibility guarantees.
 *
 * This is intentionally cheap to call repeatedly (once per request, mirroring
 * how `RPC_URL`/`DEPLOYMENT_DIR`/`DEPLOYER_PRIVATE_KEY` were already read
 * fresh per-request before multi-network support): it re-reads `process.env`
 * (and, when configured, re-reads/re-parses the `NETWORKS_CONFIG` file) every
 * call rather than caching at module load, so tests (and real deployments)
 * that change env vars between requests are respected without a server
 * restart.
 *
 * @throws NetworksConfigError if `NETWORKS_CONFIG` is set but the file is
 *   missing/unreadable/malformed, or if the resolved default network name
 *   (from the file or `DEFAULT_NETWORK`) does not name a network actually
 *   present in the registry. Callers MUST catch this and respond with a
 *   generic, non-leaking error — see `server.ts`'s `resolveNetworkForRequest`.
 */
export function loadNetworksRegistry(options?: { env?: NodeJS.ProcessEnv }): NetworksRegistry {
  const env = options?.env ?? process.env;

  const rawDeployerPrivateKey = env["DEPLOYER_PRIVATE_KEY"];
  const legacyDefault: NetworkConfig = {
    rpcUrl: env["RPC_URL"] ?? DEFAULT_RPC_URL,
    ...(rawDeployerPrivateKey !== undefined && rawDeployerPrivateKey !== ""
      ? { deployerPrivateKey: rawDeployerPrivateKey }
      : {}),
    deploymentDir: env["DEPLOYMENT_DIR"] ?? defaultDeploymentDirFor(DEFAULT_NETWORK_NAME),
  };

  const networks = new Map<string, NetworkConfig>();
  networks.set(DEFAULT_NETWORK_NAME, legacyDefault);

  let defaultNetworkName: string = DEFAULT_NETWORK_NAME;

  const configPath = env["NETWORKS_CONFIG"];
  if (configPath !== undefined && configPath.trim() !== "") {
    const parsedConfig = readNetworksConfigFile(configPath, env);
    for (const [name, cfg] of Object.entries(parsedConfig.networks)) {
      networks.set(name, cfg);
    }
    if (parsedConfig.defaultNetwork !== undefined) {
      defaultNetworkName = parsedConfig.defaultNetwork;
    }
  }

  const envDefaultNetwork = env["DEFAULT_NETWORK"];
  if (envDefaultNetwork !== undefined && envDefaultNetwork.trim() !== "") {
    defaultNetworkName = envDefaultNetwork;
  }

  if (!networks.has(defaultNetworkName)) {
    throw new NetworksConfigError(
      `Configured default network "${defaultNetworkName}" is not defined in the networks registry`,
    );
  }

  return { networks, defaultNetworkName };
}

/** The outcome of `resolveNetwork()`: either the resolved network, or nothing (unknown name). */
export type NetworkResolution =
  | { readonly ok: true; readonly name: string; readonly config: NetworkConfig }
  | { readonly ok: false };

/**
 * Resolve a client-supplied network name against the registry (an allowlist
 * lookup — see the module doc comment's SECURITY note). `requestedName` of
 * `undefined` or `""` selects `registry.defaultNetworkName`.
 *
 * Returns `{ ok: false }` for any name not present in the registry — callers
 * must turn this into a clean, generic 400 response (never echoing secrets,
 * and deliberately not echoing the raw client-supplied string either).
 */
export function resolveNetwork(
  registry: NetworksRegistry,
  requestedName: string | undefined,
): NetworkResolution {
  const name =
    requestedName === undefined || requestedName === "" ? registry.defaultNetworkName : requestedName;
  const config = registry.networks.get(name);
  if (config === undefined) {
    return { ok: false };
  }
  return { ok: true, name, config };
}

/** A single entry in `listNetworks()`'s output — public/non-secret fields only. */
export interface NetworkSummary {
  readonly name: string;
  readonly chainId?: number;
}

/** The shape returned by `listNetworks()` — the wire body of `GET /api/networks`. */
export interface NetworksListing {
  readonly networks: NetworkSummary[];
  readonly defaultNetwork: string;
}

/**
 * Produce the client-safe listing of every registered network, for
 * `GET /api/networks` (see `server.ts`'s `handleListNetworks`).
 *
 * SECURITY: this is the ONLY place a `NetworkConfig` is projected for a
 * client response. It MUST expose the network `name` and (when configured)
 * `chainId` ONLY — never `rpcUrl`, `deployerPrivateKey`, `deploymentDir`,
 * `deploymentParameters`, or `moduleId`, all of which are secret- or
 * filesystem-path-shaped. Any future `NetworkConfig` field must be reviewed
 * before being added here.
 */
export function listNetworks(registry: NetworksRegistry): NetworksListing {
  const networks: NetworkSummary[] = [];
  for (const [name, config] of registry.networks) {
    networks.push(config.chainId !== undefined ? { name, chainId: config.chainId } : { name });
  }
  return { networks, defaultNetwork: registry.defaultNetworkName };
}

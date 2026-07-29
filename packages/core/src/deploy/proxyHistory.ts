/**
 * Data model for tracking an upgradeable proxy's implementation history.
 *
 * SCOPE (v1, issue #155): this module provides TYPES + PURE HELPERS only.
 * It does NOT read chain state, does NOT persist anything, and is NOT wired
 * into `@redeploy/reader` — that is explicit follow-up work. It exists so a
 * future reader-side "implementation history" feature can be built on a
 * stable, typed shape without redesigning the data model later.
 *
 * The helpers here consume the SAME address-book shape `deploy()` already
 * produces — `DeployResult.deployedAddresses` (deploy/deploy.ts): a
 * `Record<string, string>` mapping a spec entry id (and, for upgradeable
 * entries, its internal `${id}_impl` future id) to a deployed address. That
 * is deliberate: callers can pass `deploy()`'s own output straight into
 * `deriveProxyHistoriesFromSpec()` with no extra plumbing.
 *
 * STORAGE-LAYOUT SAFETY IS OUT OF SCOPE (v1) — see spec/types.ts's
 * `UpgradeableConfig` doc comment. This module tracks WHICH implementation
 * is/was active; it does not validate that a new implementation's storage
 * layout is compatible with the previous one. Run your own storage-layout
 * check (e.g. the `@openzeppelin/upgrades-core` / `hardhat-upgrades`
 * plugin's validator) before upgrading.
 */

import type { ContractEntry, DeploymentSpec } from "../spec/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single implementation that was (or is) set for a proxy, and what
 * deployment/upgrade run set it.
 */
export interface ProxyImplementationRecord {
  /** The address of the implementation contract. */
  readonly implementationAddress: string;
  /** The Solidity contract/artifact name of that implementation. */
  readonly implementationContract: string;
  /**
   * The Ignition future/module id that produced this implementation
   * deployment — e.g. `"${proxyId}_impl"` for the entry's initial deploy
   * (see compile/compile.ts), or an upgrade module's
   * `UpgradeOptions.id` for a subsequent upgrade (see
   * `compile/compile.ts`'s `compileUpgrade()`).
   */
  readonly setBy: string;
}

/**
 * The full implementation history of a single upgradeable proxy.
 */
export interface ProxyImplementationHistory {
  /** The spec entry id of the proxy (`ContractEntry.id` — refs resolve here). */
  readonly proxyId: string;
  /** The proxy pattern — see `UpgradeableConfig.kind`'s doc comment. */
  readonly kind: "uups" | "transparent";
  /** The deployed proxy contract's (stable, never-changing) address. */
  readonly proxyAddress: string;
  /**
   * The currently active implementation. Always equal to
   * `history[history.length - 1]`.
   */
  readonly currentImplementation: ProxyImplementationRecord;
  /** Ordered oldest → newest implementation records for this proxy. */
  readonly history: readonly ProxyImplementationRecord[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derive the INITIAL `ProxyImplementationHistory` for a single upgradeable
 * entry, from its spec definition and a resolved address book (as produced
 * by `DeployResult.deployedAddresses`, or an equivalent map from any other
 * source — e.g. a reader snapshot).
 *
 * The address book must contain:
 *   - `entry.id`         → the proxy address (compile.ts always registers
 *     the proxy-as-implementation `contractAt` handle under the entry's own
 *     id — see compile/compile.ts's module doc, "Upgradeable proxies").
 *   - `${entry.id}_impl` → the implementation address.
 *
 * Returns `undefined` if `entry.upgradeable` is absent, or if either address
 * is missing from the address book (e.g. the deployment failed, or this
 * particular entry wasn't part of the run that produced `addresses`).
 */
export function deriveInitialProxyHistory(
  entry: ContractEntry,
  addresses: Readonly<Record<string, string>>,
): ProxyImplementationHistory | undefined {
  if (entry.upgradeable === undefined) {
    return undefined;
  }

  const proxyAddress = addresses[entry.id];
  const implementationAddress = addresses[`${entry.id}_impl`];
  if (proxyAddress === undefined || implementationAddress === undefined) {
    return undefined;
  }

  const initialRecord: ProxyImplementationRecord = {
    implementationAddress,
    implementationContract: entry.contract,
    setBy: `${entry.id}_impl`,
  };

  return {
    proxyId: entry.id,
    kind: entry.upgradeable.kind,
    proxyAddress,
    currentImplementation: initialRecord,
    history: [initialRecord],
  };
}

/**
 * Derive the initial `ProxyImplementationHistory` for every upgradeable
 * entry in a spec, given a resolved address book (e.g.
 * `DeployResult.deployedAddresses`). Non-upgradeable entries and entries
 * missing from the address book are silently skipped — mirroring how
 * `DeployResult.deployedAddresses` itself is simply absent/incomplete for a
 * failed or partial deployment, rather than an error condition here.
 */
export function deriveProxyHistoriesFromSpec(
  spec: DeploymentSpec,
  addresses: Readonly<Record<string, string>>,
): ProxyImplementationHistory[] {
  const histories: ProxyImplementationHistory[] = [];
  for (const entry of spec.contracts) {
    const history = deriveInitialProxyHistory(entry, addresses);
    if (history !== undefined) {
      histories.push(history);
    }
  }
  return histories;
}

/**
 * Append a new implementation record to an existing history — the pure,
 * composable primitive an upgrade flow (e.g. after running
 * `compile/compile.ts`'s `compileUpgrade()` and a successful on-chain
 * upgrade call) or a future reader integration uses to extend history across
 * multiple deploy/upgrade runs.
 *
 * Never mutates `existing` — returns a new object. The proxy's address and
 * `kind` never change across an upgrade (only `currentImplementation` and
 * `history` do), so this deliberately does not accept a `proxyAddress`/`kind`
 * override.
 */
export function appendProxyImplementationRecord(
  existing: ProxyImplementationHistory,
  next: ProxyImplementationRecord,
): ProxyImplementationHistory {
  return {
    ...existing,
    currentImplementation: next,
    history: [...existing.history, next],
  };
}

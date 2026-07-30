/**
 * Async pre-resolution pass for `{ kind: "crossRef" }` args (cross-chain
 * dependency refs — issue #159).
 *
 * `resolveCrossRefArgs` walks a validated DeploymentSpec, and for every
 * crossRef arg it finds, reads the referenced NETWORK's Ignition journal
 * (via `resolve/journal.ts`'s `loadAddressesFromJournal` — the SAME
 * primitive `deploy()` uses to read its own network's journal for
 * `ResolverContext.resolvedAddresses`) and returns a NEW DeploymentSpec where
 * every crossRef arg has been replaced by a concrete `{ kind: "literal",
 * value: <address> }` arg.
 *
 * This is deliberately a pure, standalone transform over DeploymentSpec —
 * exactly like `resolve/resolveSpec.ts`'s `resolveSpecResolverArgs` — so it
 * can run to completion BEFORE compileSpec() ever constructs Ignition
 * futures. See deploy/deploy.ts for where this pass sits in the overall
 * deploy() pipeline (BEFORE the resolver pre-resolution pass — both are
 * pre-compile literal substitutions, ordered crossRef -> resolver so a
 * resolver could, in principle, observe an already-resolved crossRef address
 * via `ctx.resolvedAddresses` in a future extension, though v1 does not wire
 * that through).
 *
 * compile/compile.ts's compileSpec() throws
 * CompileError("UNRESOLVED_CROSS_REF_ARG") if it ever encounters a
 * `{ kind: "crossRef" }` arg — by design, a spec fed to compileSpec() must
 * never contain crossRef args; they are pre-resolved here (or, for direct
 * compileSpec() callers who don't go through deploy(), must be
 * pre-substituted by the caller using this same function).
 *
 * CORE HAS NO NETWORK REGISTRY (v1 scope boundary — see CrossRefArg's doc
 * comment in spec/types.ts): `ResolveCrossRefOptions.journals` is injected by
 * the CALLER, mapping an opaque network name to a `CrossNetworkJournal`
 * (deploymentDir + optional moduleId). Multi-network orchestration (e.g.
 * resolving `journals` from a project's own network config, such as
 * `@redeploy/deploy-server`'s `NetworksRegistry`) is explicitly OUT OF SCOPE
 * for this package — core only knows how to read a journal it's handed a
 * path to.
 */

import type { ContractArg, ContractEntry, DeploymentSpec, LiteralArg } from "../spec/types.js";
import { loadAddressesFromJournal } from "./journal.js";
import { CrossRefError } from "./crossRefErrors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Location of another network's Ignition deployment, for reading its journal.
 */
export interface CrossNetworkJournal {
  /** Directory containing that network's `journal.jsonl`. */
  readonly deploymentDir: string;
  /**
   * The Ignition module id that network's deployment was run under.
   * Defaults to `"Deployment"` (deploy()'s own default) if omitted.
   */
  readonly moduleId?: string;
}

/** Options for resolveCrossRefArgs(). */
export interface ResolveCrossRefOptions {
  /**
   * Injected map of network name -> journal location. Every `network` named
   * by a `{ kind: "crossRef" }` arg anywhere in the spec must appear as an
   * OWN key here, or resolveCrossRefArgs() throws
   * `CrossRefError("CROSS_REF_UNKNOWN_NETWORK")`. Core does not own or
   * discover this mapping itself — see this file's module doc.
   */
  readonly journals: Record<string, CrossNetworkJournal>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True iff `spec` contains at least one `{ kind: "crossRef" }` arg anywhere
 * in its contracts (constructor `args`, `upgradeable.initializer.args`, or
 * `upgradeable.proxyAdminOwner`). Used by deploy() to skip this pass's setup
 * work entirely for specs that don't use cross-chain refs — the common case
 * — while keeping resolveCrossRefArgs() itself safe to call unconditionally
 * (it also short-circuits internally).
 */
export function specHasCrossRefArgs(spec: DeploymentSpec): boolean {
  return spec.contracts.some((entry) => entryHasCrossRefArg(entry));
}

function entryHasCrossRefArg(entry: ContractEntry): boolean {
  if ((entry.args ?? []).some((arg) => arg.kind === "crossRef")) return true;
  if ((entry.upgradeable?.initializer?.args ?? []).some((arg) => arg.kind === "crossRef")) return true;
  if (entry.upgradeable?.proxyAdminOwner?.kind === "crossRef") return true;
  return false;
}

/**
 * Resolves every `{ kind: "crossRef" }` arg in `spec` against
 * `options.journals` and returns a NEW DeploymentSpec with those args
 * replaced by `{ kind: "literal", value: <address> }`.
 *
 * Contracts/args that contain no crossRef arg are returned unchanged (same
 * object references) — only entries that actually needed resolution are
 * rebuilt. If `spec` contains no crossRef args at all, `spec` itself is
 * returned unchanged.
 *
 * Applies uniformly to constructor `args`, `upgradeable.initializer.args`,
 * and `upgradeable.proxyAdminOwner` — the same three locations
 * `spec/validate.ts`'s `checkArgRefAndParam` and `compile/compile.ts`'s
 * `mapContractArg` treat identically for ref/param/expr/resolver args.
 *
 * @throws CrossRefError with code "CROSS_REF_UNKNOWN_NETWORK" if a crossRef
 *   arg names a network absent from `options.journals`.
 * @throws CrossRefError with code "CROSS_REF_NOT_DEPLOYED" if the referenced
 *   network's journal has no recorded address for the requested contract id
 *   (including when the journal doesn't exist at all — nothing deployed
 *   there yet). The referenced network's deployment must be COMPLETE first
 *   — see CrossRefArg's v1 scope boundary (spec/types.ts).
 */
export async function resolveCrossRefArgs(
  spec: DeploymentSpec,
  options: ResolveCrossRefOptions,
): Promise<DeploymentSpec> {
  if (!specHasCrossRefArgs(spec)) {
    return spec;
  }

  // Cache journal reads per network — multiple crossRef args (even across
  // entries) referencing the same network should only read that network's
  // journal.jsonl once.
  const journalCache = new Map<string, Record<string, string>>();

  async function resolveAddress(
    entryId: string,
    locationDescription: string,
    network: string,
    contract: string,
  ): Promise<string> {
    // Guard against prototype pollution: only OWN, enumerable keys of the
    // injected journals map may be looked up. Mirrors resolve/resolveSpec.ts's
    // Object.hasOwn guard for the ResolverRegistry lookup.
    if (!Object.hasOwn(options.journals, network)) {
      throw new CrossRefError(
        "CROSS_REF_UNKNOWN_NETWORK",
        `Contract "${entryId}" ${locationDescription} references network "${network}", which is ` +
          `not present in the injected journals map — no CrossNetworkJournal is registered for it`,
      );
    }

    let addresses = journalCache.get(network);
    if (addresses === undefined) {
      const journal = options.journals[network];
      addresses = await loadAddressesFromJournal(journal.deploymentDir, journal.moduleId ?? "Deployment");
      journalCache.set(network, addresses);
    }

    const address = addresses[contract];
    if (address === undefined) {
      throw new CrossRefError(
        "CROSS_REF_NOT_DEPLOYED",
        `Contract "${entryId}" ${locationDescription} references contract "${contract}" on network ` +
          `"${network}", but it is not present in that network's journal — deploy network "${network}" ` +
          `first before this one`,
      );
    }
    return address;
  }

  async function resolveArgList(
    entryId: string,
    args: readonly ContractArg[] | undefined,
    locationPrefix: string,
  ): Promise<{ changed: boolean; args: ContractArg[] | undefined }> {
    if (args === undefined) {
      return { changed: false, args: undefined };
    }
    let changed = false;
    const resolved: ContractArg[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.kind !== "crossRef") {
        resolved.push(arg);
        continue;
      }
      changed = true;
      const address = await resolveAddress(entryId, `${locationPrefix}[${i}]`, arg.network, arg.contract);
      const literalArg: LiteralArg = { kind: "literal", value: address };
      resolved.push(literalArg);
    }
    return { changed, args: resolved };
  }

  const contracts: ContractEntry[] = [];
  for (const entry of spec.contracts) {
    if (!entryHasCrossRefArg(entry)) {
      contracts.push(entry);
      continue;
    }

    const { changed: argsChanged, args: resolvedArgs } = await resolveArgList(
      entry.id,
      entry.args,
      "args",
    );

    let upgradeable = entry.upgradeable;
    if (upgradeable !== undefined) {
      let upgradeableChanged = false;

      const { changed: initChanged, args: resolvedInitArgs } = await resolveArgList(
        entry.id,
        upgradeable.initializer?.args,
        "upgradeable.initializer.args",
      );
      if (initChanged) {
        upgradeableChanged = true;
      }

      let proxyAdminOwner = upgradeable.proxyAdminOwner;
      if (proxyAdminOwner?.kind === "crossRef") {
        upgradeableChanged = true;
        const address = await resolveAddress(
          entry.id,
          "upgradeable.proxyAdminOwner",
          proxyAdminOwner.network,
          proxyAdminOwner.contract,
        );
        proxyAdminOwner = { kind: "literal", value: address };
      }

      if (upgradeableChanged) {
        upgradeable = {
          ...upgradeable,
          ...(upgradeable.initializer !== undefined
            ? { initializer: { ...upgradeable.initializer, args: resolvedInitArgs } }
            : {}),
          ...(proxyAdminOwner !== undefined ? { proxyAdminOwner } : {}),
        };
      }
    }

    contracts.push({
      ...entry,
      ...(argsChanged ? { args: resolvedArgs } : {}),
      ...(upgradeable !== entry.upgradeable ? { upgradeable } : {}),
    });
  }

  return { ...spec, contracts };
}

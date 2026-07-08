/**
 * Async pre-resolution pass for `{ kind: "resolver" }` args (Layer 2).
 *
 * `resolveSpecResolverArgs` walks a validated DeploymentSpec, invokes the
 * named resolver (from the injected ResolverRegistry) for every resolver arg
 * it finds, and returns a NEW DeploymentSpec where every resolver arg has
 * been replaced by a concrete `{ kind: "literal", value: ... }` arg holding
 * the resolver's return value.
 *
 * This is deliberately a pure, standalone transform over DeploymentSpec —
 * NOT wired into compileSpec() or Ignition's buildModule() — so it can run
 * to completion (including all of its `await`s) BEFORE compileSpec() ever
 * constructs Ignition futures. See deploy/deploy.ts for where this pass sits
 * in the overall deploy() pipeline (between validateSpec() and compileSpec())
 * and resolve/registry.ts for the full Resolver/ResolverContext contract,
 * the v1 scope boundary, and the security/trust-boundary notes.
 *
 * compile/compile.ts's compileSpec() throws CompileError("UNRESOLVED_RESOLVER_ARG")
 * if it ever encounters a `{ kind: "resolver" }` arg — by design, a spec fed
 * to compileSpec() must never contain resolver args; they are pre-resolved
 * here (or, for direct compileSpec() callers who don't go through deploy(),
 * must be pre-substituted by the caller using this same function).
 */

import type {
  ContractArg,
  ContractEntry,
  DeploymentSpec,
  LiteralArg,
  LiteralValue,
} from "../spec/types.js";
import type { ResolverContext, ResolverRegistry } from "./registry.js";
import { ResolveError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for resolveSpecResolverArgs(). */
export interface ResolveSpecOptions {
  /** Injected resolver implementations, keyed by ResolverArg.name. */
  readonly registry: ResolverRegistry;
  /** Effective parameter values for this deploy run (bigint-typed). */
  readonly params: Record<string, bigint>;
  /** Addresses already known before this run started (journal / external). */
  readonly resolvedAddresses: Record<string, string>;
  /** Live EIP-1193 provider for arbitrary on-chain reads. */
  readonly provider: ResolverContext["provider"];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True iff `spec` contains at least one `{ kind: "resolver" }` arg anywhere
 * in its contracts. Used by deploy() to skip the (journal-reading,
 * param-building) setup work entirely for specs that don't use resolvers —
 * the common case — while keeping resolveSpecResolverArgs() itself safe to
 * call unconditionally (it also short-circuits internally).
 */
export function specHasResolverArgs(spec: DeploymentSpec): boolean {
  return spec.contracts.some((entry) =>
    (entry.args ?? []).some((arg) => arg.kind === "resolver"),
  );
}

/**
 * Resolves every `{ kind: "resolver" }` arg in `spec` against `options.registry`
 * and returns a NEW DeploymentSpec with those args replaced by
 * `{ kind: "literal", value: <resolver return value> }`.
 *
 * Contracts/args that contain no resolver arg are returned unchanged
 * (same object references) — only entries that actually needed resolution
 * are rebuilt. If `spec` contains no resolver args at all, `spec` itself is
 * returned unchanged.
 *
 * Resolvers for a given entry are invoked SEQUENTIALLY in arg order (not
 * Promise.all'd) — this keeps resolver side effects (if any; e.g. logging)
 * deterministic and matches the general "no surprise concurrency" posture of
 * the rest of the deploy pipeline. Cross-entry resolution order does not
 * matter (v1 resolvers cannot depend on each other's results — see
 * resolve/registry.ts's scope boundary), so entries are still processed in
 * spec declaration order for simplicity/determinism, not for correctness.
 *
 * @throws ResolveError with code "UNKNOWN_RESOLVER" if a resolver arg names a
 *   resolver absent from `options.registry`.
 * @throws ResolveError with code "RESOLVER_ERROR" if a resolver function
 *   throws (or its returned Promise rejects) during invocation.
 */
export async function resolveSpecResolverArgs(
  spec: DeploymentSpec,
  options: ResolveSpecOptions,
): Promise<DeploymentSpec> {
  if (!specHasResolverArgs(spec)) {
    return spec;
  }

  const context: ResolverContext = {
    params: options.params,
    resolvedAddresses: options.resolvedAddresses,
    provider: options.provider,
  };

  const contracts: ContractEntry[] = [];
  for (const entry of spec.contracts) {
    const args = entry.args;
    if (args === undefined || !args.some((arg) => arg.kind === "resolver")) {
      contracts.push(entry);
      continue;
    }

    const resolvedArgs: ContractArg[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.kind !== "resolver") {
        resolvedArgs.push(arg);
        continue;
      }

      // Guard against prototype pollution: only OWN, enumerable keys of the
      // injected registry may be looked up. A bare `options.registry[name]`
      // would fall through to inherited Object.prototype members (e.g.
      // "toString", "constructor", "hasOwnProperty", "valueOf") for names
      // that are not actually registered, silently substituting a built-in
      // function/behavior instead of failing closed on unknown resolver
      // names. Mirrors the Map-based prototype-pollution guard already used
      // in compile/compile.ts for future-id lookups.
      if (!Object.hasOwn(options.registry, arg.name)) {
        throw new ResolveError(
          "UNKNOWN_RESOLVER",
          `Contract "${entry.id}" args[${i}] references unknown resolver "${arg.name}" — ` +
            `no resolver with this name is registered in DeployOptions.resolvers`,
        );
      }
      const resolver = options.registry[arg.name];

      let value: LiteralValue;
      try {
        value = await resolver(context, arg.args ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ResolveError(
          "RESOLVER_ERROR",
          `Resolver "${arg.name}" (contract "${entry.id}" args[${i}]) threw: ${msg}`,
        );
      }

      const literalArg: LiteralArg = { kind: "literal", value };
      resolvedArgs.push(literalArg);
    }

    contracts.push({ ...entry, args: resolvedArgs });
  }

  return { ...spec, contracts };
}

// ---------------------------------------------------------------------------
// Parameter coercion — mirrors compile.ts's expr-arg param conversion
// ---------------------------------------------------------------------------

/**
 * Builds the bigint-typed parameter map for ResolverContext.params: starts
 * from the spec's declared `parameters` defaults and applies
 * `deploymentParameters[moduleId]` overrides (Ignition's own per-network
 * parameter-precedence mechanism — see spec/types.ts's ParamArg docs), then
 * coerces every final value to bigint.
 *
 * Coercion rules (mirrors compile.ts's expr-arg param handling for
 * consistency): number/string/bigint values convert via `BigInt(value)`;
 * `null` converts to `0n`; any other type (boolean, array, object,
 * AccountRuntimeValue) is NOT representable as a single bigint and throws —
 * a resolver needing such a value should read `DeploymentSpec.parameters`
 * directly via closure instead of relying on `ResolverContext.params`.
 *
 * @throws ResolveError with code "RESOLVER_ERROR" if a parameter value
 *   cannot be coerced to bigint.
 */
export function buildResolverParams(
  spec: DeploymentSpec,
  moduleId: string,
  deploymentParameters: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Record<string, bigint> {
  const merged: Record<string, unknown> = { ...(spec.parameters ?? {}) };
  const overrides = deploymentParameters?.[moduleId];
  if (overrides) {
    for (const [name, value] of Object.entries(overrides)) {
      merged[name] = value;
    }
  }

  const params: Record<string, bigint> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value === "bigint") {
      params[name] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "string") {
      try {
        params[name] = BigInt(value);
      } catch {
        throw new ResolveError(
          "RESOLVER_ERROR",
          `Parameter "${name}" value is not convertible to BigInt for resolver context`,
        );
      }
      continue;
    }
    if (value === null) {
      params[name] = 0n;
      continue;
    }
    throw new ResolveError(
      "RESOLVER_ERROR",
      `Parameter "${name}" has unsupported type for resolver context ` +
        `(expected number, string, bigint, or null)`,
    );
  }
  return params;
}

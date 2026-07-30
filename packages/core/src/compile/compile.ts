/**
 * Spec compiler — converts a pre-validated DeploymentSpec into a Hardhat
 * Ignition module.
 *
 * DESIGN NOTES
 * ============
 *
 * Build-time ordering vs. deploy-time ordering
 * ---------------------------------------------
 * Ignition owns deploy-time ordering (the on-chain execution sequence) and
 * derives it from the dependency edges we declare (constructor-arg futures
 * and `after` options). We do NOT implement a custom deploy-time sort — that
 * would violate the CLAUDE.md "don't reinvent what Ignition provides" rule.
 *
 * However, `m.contract(name, args, opts)` requires that any future passed in
 * `args` (as a ContractFuture) or `opts.after` already exist in the module's
 * future set at the time of the call. Forward references are NOT supported by
 * the builder API. Therefore we must CREATE futures in an order where every
 * dependency comes before the dependent. This is a BUILD-TIME necessity only,
 * not a deploy-time concern.
 *
 * We use a minimal Kahn's BFS over the combined ref+after edges to produce
 * this creation order. The spec validator has already guaranteed no cycles and
 * no dangling refs, so the sort always succeeds. Complexity: O(V+E).
 *
 * Map vs. plain object for id→future lookup
 * ------------------------------------------
 * We use Map<string, ContractFuture<string>> rather than a plain object for
 * the id→future index. Spec-derived strings must never index a plain object
 * (prototype-pollution risk). `ContractFuture<string>` (rather than the
 * narrower `NamedArtifactContractDeploymentFuture<string>`) is the value type
 * because upgradeable entries store a `contractAt` future (the proxy exposed
 * with the implementation's ABI) here instead of a plain deployment future —
 * see "Upgradeable proxies" below.
 *
 * Literal mapping
 * ---------------
 * mapLiteralValue handles string, number, boolean, null, and nested arrays.
 * BigInt is explicitly NOT supported in v1: LiteralValue's type is
 * scalar-or-array only and the approved spec scope excludes bigint. The
 * `{ __bigint: "..." }` encoding mentioned in some doc comments is a future
 * extension. If a runtime value falls outside these shapes, CompileError
 * UNSUPPORTED_LITERAL is thrown.
 *
 * Upgradeable proxies (UUPS / Transparent)
 * -----------------------------------------
 * ignition-core 0.15.15 has NO built-in `m.proxy` helper, so an
 * `entry.upgradeable` entry is compiled by hand-composing the standard
 * OpenZeppelin proxy pattern from Ignition primitives:
 *
 *   1. `impl   = m.contract(entry.contract, ctorArgs, { id: "<id>_impl" })`
 *   2. `data   = m.encodeFunctionCall(impl, initializer.function, initArgs)`
 *      (or `"0x"` if no initializer is declared)
 *   3. `proxy  = m.contract("ERC1967Proxy", [impl, data], { id: "<id>_proxy" })`
 *      (uups) or
 *      `m.contract("TransparentUpgradeableProxy", [impl, proxyAdminOwner, data], { id: "<id>_proxy" })`
 *      (transparent — OZ v5's TransparentUpgradeableProxy deploys its own
 *      ProxyAdmin internally, owned by `proxyAdminOwner`)
 *   4. `handle = m.contractAt(entry.contract, proxy, { id: entry.id })`
 *
 * `handle` (NOT `impl` or `proxy` directly) is what gets stored in
 * `futureByEntryId` under `entry.id` — so every downstream `ref` to this
 * entry, and the final `IgnitionModuleResult`, resolve to the PROXY's
 * address with the IMPLEMENTATION's ABI. That is the entire point of a
 * proxy: callers always talk to the stable proxy address.
 *
 * The proxy artifact names (`"ERC1967Proxy"` / `"TransparentUpgradeableProxy"`)
 * are overridable via `CompileOptions.proxyArtifacts` for consumers whose
 * Foundry/Hardhat project vendors OpenZeppelin under different artifact
 * names; both must be resolvable by the `ArtifactResolver` passed to
 * `deploy()` (they exist in `openzeppelin-contracts` v5 and must be
 * compiled/available in the consuming project — reDeploy does not vendor
 * OZ's Solidity sources itself).
 *
 * STORAGE-LAYOUT SAFETY IS OUT OF SCOPE (v1) — see `UpgradeableConfig`'s
 * doc comment in spec/types.ts. `compileUpgrade()` (below) documents the
 * same caveat for the upgrade-call path.
 */

import { buildModule } from "@nomicfoundation/ignition-core";
import type {
  ArgumentType,
  ContractFuture,
  IgnitionModule,
  IgnitionModuleBuilder,
  IgnitionModuleResult,
  ModuleParameterType,
} from "@nomicfoundation/ignition-core";
import type {
  ContractArg,
  ContractEntry,
  DeploymentSpec,
  LiteralValue,
} from "../spec/types.js";
import {
  evaluateExpression,
  EvaluationError,
  type EvaluationContext,
} from "../spec/evaluator.js";
import { CompileError } from "./errors.js";

// Re-export for public API surface
export type { CompileErrorCode } from "./errors.js";
export { CompileError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for compileSpec. */
export interface CompileOptions {
  /**
   * The Ignition module id. Defaults to "Deployment".
   * Must be a non-empty string (Ignition constraint).
   */
  moduleId?: string;
  /**
   * Override the default artifact names used for the proxy contracts
   * deployed for `upgradeable` entries. Both artifacts must be
   * compiled/available to the `ArtifactResolver` passed to `deploy()` — they
   * ship as part of `openzeppelin-contracts` v5
   * (`@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol` and
   * `@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol`).
   * reDeploy does not vendor these sources itself — the consuming
   * Foundry/Hardhat project must have them available.
   */
  proxyArtifacts?: {
    /** Defaults to `"ERC1967Proxy"`. */
    uups?: string;
    /** Defaults to `"TransparentUpgradeableProxy"`. */
    transparent?: string;
  };
}

/**
 * The return type of compileSpec.
 * IgnitionModuleResult<string> is the standard result type for modules that
 * export named artifact contract deployment futures.
 */
export type CompiledModule = IgnitionModule<
  string,
  string,
  IgnitionModuleResult<string>
>;

// ---------------------------------------------------------------------------
// Build-time topological sort (Kahn's BFS, O(V+E))
// ---------------------------------------------------------------------------

/**
 * Returns ContractEntry objects from spec.contracts in an order where every
 * ref and after dependency of an entry appears BEFORE that entry. This is
 * required because Ignition's IgnitionModuleBuilder.contract() does not
 * support forward references — the future for a dependency must already exist
 * at the time the dependent future is created.
 *
 * The spec validator guarantees: no cycles, no dangling refs, no
 * self-references. Therefore Kahn's algorithm will always drain the queue
 * fully (all entries will appear in the output).
 *
 * NOTE: This function handles BUILD-TIME creation order only. DEPLOY-TIME
 * ordering (on-chain execution sequence) is derived by Ignition from the
 * dependency edges we embed in the futures (constructor-arg ContractFutures
 * and the `after` option) — we never override or duplicate that logic.
 */
export function buildCreationOrder(entries: readonly ContractEntry[]): ContractEntry[] {
  // Build id→entry index and id→dependsOn (set of ids this entry depends on)
  const idToEntry = new Map<string, ContractEntry>();
  // inDegree[id] = number of dependencies of entry[id] not yet placed
  const inDegree = new Map<string, number>();
  // dependents[id] = list of entry ids that depend on id
  const dependents = new Map<string, string[]>();

  for (const entry of entries) {
    idToEntry.set(entry.id, entry);
    dependents.set(entry.id, []);
    inDegree.set(entry.id, 0);
  }

  // Build edges: entry depends on every ref-target, every after-id, and
  // every contract referenced in expressions.
  //
  // NOTE: `resolver` args (ResolverArg, Layer 2) intentionally contribute NO
  // dependency edges here. v1 resolvers run in a single async pass BEFORE any
  // future in this deployment run is created (see deploy/deploy.ts and
  // resolve/resolveSpec.ts) and cannot reference a sibling contract deploying
  // in this same run — that is an explicit v1 scope boundary documented in
  // resolve/registry.ts. By the time buildCreationOrder() runs (inside
  // compileSpec(), called from deploy() AFTER the resolver pre-pass),
  // resolver args have already been replaced by literal args, so this falls
  // through to the same "no edge" behavior as `param` args below without any
  // special-casing needed.
  for (const entry of entries) {
    const deps = new Set<string>();
    // Ref args — from constructor `args` AND (identically) from
    // `upgradeable.initializer.args` / `upgradeable.proxyAdminOwner`, since
    // both flow into real Ignition future dependencies once compiled (see
    // the impl/proxy/contractAt futures built in compileSpec below).
    const argSources: ContractArg[] = [
      ...(entry.args ?? []),
      ...(entry.upgradeable?.initializer?.args ?? []),
      ...(entry.upgradeable?.proxyAdminOwner !== undefined ? [entry.upgradeable.proxyAdminOwner] : []),
    ];
    for (const arg of argSources) {
      if (arg.kind === "ref") {
        deps.add(arg.contract);
      } else if (arg.kind === "expr") {
        // Extract contract references from expressions: ${contractId}
        const contractRefRegex = /\$\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/g;
        let match;
        while ((match = contractRefRegex.exec(arg.expression)) !== null) {
          const contractId = match[1];
          // Only add if this contract id exists in the entry set
          if (idToEntry.has(contractId)) {
            deps.add(contractId);
          }
          // Otherwise, the validator will catch it as a missing reference
        }
      }
      // `param` and `resolver` args add no edges (see NOTE above). `crossRef`
      // args likewise add no edge here — the referenced contract lives on a
      // DIFFERENT network entirely, outside this spec's own dependency
      // graph, so a build-order edge would be meaningless. See CrossRefArg's
      // doc comment (spec/types.ts) for the full v1 scope boundary.
    }
    // After constraints
    for (const afterId of entry.after ?? []) {
      deps.add(afterId);
    }
    inDegree.set(entry.id, deps.size);
    for (const dep of deps) {
      const list = dependents.get(dep);
      // dep is a valid id (validator guarantees no dangling refs)
      if (list !== undefined) {
        list.push(entry.id);
      }
    }
  }

  // Kahn's BFS: start with entries that have no dependencies
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // head is an O(1) cursor into queue — avoids O(N) Array.shift() per dequeue,
  // keeping the overall sort at O(V+E) as documented above.
  let head = 0;
  const result: ContractEntry[] = [];
  while (head < queue.length) {
    // Non-null assertion safe: head is always < queue.length in this loop
    const id = queue[head++]!;
    const entry = idToEntry.get(id);
    if (entry === undefined) {
      // Validator guarantees all ids exist; this path should never be reached
      throw new CompileError(
        "INTERNAL_INVARIANT",
        `build-time sort encountered unknown id: ${id}`,
      );
    }
    result.push(entry);
    for (const dependentId of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dependentId) ?? 1) - 1;
      inDegree.set(dependentId, newDeg);
      if (newDeg === 0) queue.push(dependentId);
    }
  }

  // If the sort didn't consume every entry there's a cycle — the validator
  // should have caught this already.
  if (result.length !== entries.length) {
    throw new CompileError(
      "INTERNAL_INVARIANT",
      "build-time sort detected a cycle that validateSpec should have rejected",
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Literal value mapping
// ---------------------------------------------------------------------------

/**
 * Maps a LiteralValue from the spec into a value Ignition's ArgumentType
 * accepts. Supports: string, number, boolean, null, and nested arrays.
 *
 * LIMITATION (v1): bigint is NOT supported. The LiteralValue type is
 * scalar-or-array only and the spec schema does not include a bigint encoding.
 * If bigint support is needed in a future version, extend LiteralValue with a
 * `{ __bigint: string }` tagged type and handle it here.
 *
 * @throws CompileError(UNSUPPORTED_LITERAL) if the value is not one of the
 *   above shapes. This should never happen for specs produced by the Zod
 *   schema (which enforces LiteralValue), but guards against direct callers
 *   passing unvalidated data.
 */
function mapLiteralValue(value: LiteralValue, path: string): ArgumentType {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) {
    // null is a valid LiteralScalar in the spec (e.g. for address(0) / zero
    // values). Ignition's ArgumentType does not include null in its TypeScript
    // union, but null passes through at runtime. We assert the type here.
    // TODO: revisit if Ignition adds null to ArgumentType in a future release.
    return null as unknown as ArgumentType;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => mapLiteralValue(item, `${path}[${i}]`));
  }
  // Should be unreachable for valid LiteralValue; guards runtime surprises.
  // Use a bigint-safe replacer: a resolver (resolve/resolveSpec.ts) or other
  // direct caller could hand us a runtime value (e.g. a bigint) outside the
  // LiteralValue shape, and plain JSON.stringify throws a raw TypeError on
  // bigint ("Do not know how to serialize a BigInt") instead of letting this
  // function fail closed with a typed CompileError.
  throw new CompileError(
    "UNSUPPORTED_LITERAL",
    `Unsupported literal value at ${path}: ${JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    )}`,
    path,
  );
}

// ---------------------------------------------------------------------------
// Contract argument mapping (ref/literal/param/expr/resolver)
// ---------------------------------------------------------------------------

/**
 * Maps a single `ContractArg` to an Ignition `ArgumentType`, handling every
 * arg kind (ref/literal/param/expr/resolver) identically to how constructor
 * `args` have always been mapped. Shared by constructor `args`,
 * `upgradeable.initializer.args`, and `upgradeable.proxyAdminOwner` so all
 * three go through the SAME validated arg-mapping — no bespoke handling, no
 * string interpolation into calldata.
 *
 * @param m               The Ignition module builder (for `m.getParameter`).
 * @param arg             The arg to map.
 * @param argPath         JSON-pointer-ish path for error messages.
 * @param spec            The full spec (for `spec.parameters` defaults/expr context).
 * @param futureByEntryId Build-time id→future index (for `ref` resolution).
 */
function mapContractArg(
  m: IgnitionModuleBuilder,
  arg: ContractArg,
  argPath: string,
  spec: DeploymentSpec,
  futureByEntryId: ReadonlyMap<string, ContractFuture<string>>,
): ArgumentType {
  if (arg.kind === "ref") {
    // Resolve the referenced future. Build-time ordering guarantees the
    // target was already created. If not, validateSpec was bypassed.
    const refFuture = futureByEntryId.get(arg.contract);
    if (refFuture === undefined) {
      throw new CompileError(
        "INTERNAL_INVARIANT",
        `ref target "${arg.contract}" has not been registered as a future — was validateSpec called?`,
        argPath,
      );
    }
    // ContractFuture<string> is assignable to ArgumentType, so passing
    // the future here creates a real Ignition dependency edge.
    return refFuture;
  }
  if (arg.kind === "param") {
    // Resolve via Ignition's m.getParameter(). This is the seam that
    // lets the SAME compiled module receive different values per
    // network/environment: the caller supplies the actual value at
    // deploy time via DeployOptions.deploymentParameters (keyed by this
    // module's id and this parameter's name; see deploy/deploy.ts). We
    // do NOT bake a fixed value into the module here — that would
    // defeat the whole point of per-network overrides.
    //
    // If the spec declares a value for this parameter under
    // `spec.parameters[arg.name]`, we pass it as Ignition's
    // `defaultValue` — used only when deploymentParameters does NOT
    // supply an override for this name. validateSpec guarantees
    // `arg.name` is a declared key of `spec.parameters` before compile
    // is ever reached (SpecErrorCode "UNKNOWN_PARAM").
    const declaredDefault = spec.parameters?.[arg.name];
    const defaultValue =
      declaredDefault !== undefined
        ? // Ignition's ModuleParameterType (like ArgumentType) does not
          // include `null` in its TypeScript union, but null passes
          // through at runtime — same rationale as mapLiteralValue's
          // null handling above.
          (mapLiteralValue(declaredDefault, argPath) as unknown as ModuleParameterType)
        : undefined;
    return m.getParameter(arg.name, defaultValue);
  }
  if (arg.kind === "expr") {
    // Evaluate the expression with parameter values and contract references
    try {
      const context: EvaluationContext = {
        params: {},
        contractAddresses: {},
      };

      // Populate parameter values (convert LiteralValue to bigint for parameters)
      if (spec.parameters) {
        for (const [paramName, paramValue] of Object.entries(spec.parameters)) {
          // For now, we only support bigint parameters in expressions
          // Parse literal values as bigint if possible
          if (typeof paramValue === "number" || typeof paramValue === "string") {
            try {
              context.params[paramName] = BigInt(paramValue);
            } catch {
              throw new CompileError(
                "EXPRESSION_EVAL_ERROR",
                `Parameter "${paramName}" value is not convertible to BigInt for expressions`,
                argPath,
              );
            }
          } else if (paramValue === null) {
            context.params[paramName] = 0n;
          } else {
            throw new CompileError(
              "EXPRESSION_EVAL_ERROR",
              `Parameter "${paramName}" has unsupported type for expressions: ${typeof paramValue}`,
              argPath,
            );
          }
        }
      }

      // Populate contract addresses/futures for ${contractId} references
      for (const [contractId, future] of futureByEntryId) {
        context.contractAddresses[contractId] = future;
      }

      const result = evaluateExpression(arg.expression, context);

      // If the result is a Future (from a contract reference), return it directly
      if (typeof result === "object" && result !== null && "address" in result) {
        // This is a Future-like object from Ignition
        return result as ArgumentType;
      }

      // Otherwise, map the result as a literal value
      // BigInt results are mapped as numbers (or strings for large values)
      if (typeof result === "bigint") {
        return result as unknown as ArgumentType;
      }

      // String results (hex hashes, addresses, etc.)
      return result as ArgumentType;
    } catch (err) {
      if (err instanceof EvaluationError) {
        throw new CompileError(
          "EXPRESSION_EVAL_ERROR",
          `Expression evaluation failed: ${err.message}`,
          argPath,
        );
      }
      throw err;
    }
  }
  if (arg.kind === "resolver") {
    // compileSpec() never invokes resolvers itself — see
    // resolve/registry.ts and this error code's doc comment
    // (compile/errors.ts). deploy() always pre-resolves resolver args
    // via resolve/resolveSpec.ts BEFORE calling compileSpec(), so this
    // should be unreachable through the normal deploy() pipeline. It
    // fires only if compileSpec() is called directly with a spec that
    // still contains unresolved resolver args.
    throw new CompileError(
      "UNRESOLVED_RESOLVER_ARG",
      `Resolver arg "${arg.name}" was not pre-resolved before compileSpec() was called. ` +
        `Resolver args must be resolved to concrete literals first — deploy() does this ` +
        `automatically via its pre-resolution pass (resolve/resolveSpec.ts). If you are ` +
        `calling compileSpec() directly, call resolveSpecResolverArgs() on the spec first.`,
      argPath,
    );
  }
  if (arg.kind === "crossRef") {
    // compileSpec() never reads another network's journal itself — see
    // resolve/crossRef.ts and this error code's doc comment
    // (compile/errors.ts). deploy() always pre-resolves crossRef args via
    // resolve/crossRef.ts's resolveCrossRefArgs() BEFORE calling
    // compileSpec(), so this should be unreachable through the normal
    // deploy() pipeline. It fires only if compileSpec() is called directly
    // with a spec that still contains unresolved crossRef args.
    throw new CompileError(
      "UNRESOLVED_CROSS_REF_ARG",
      `Cross-chain ref to contract "${arg.contract}" on network "${arg.network}" was not ` +
        `pre-resolved before compileSpec() was called. crossRef args must be resolved to ` +
        `concrete literals first — deploy() does this automatically via its pre-resolution ` +
        `pass (resolve/crossRef.ts). If you are calling compileSpec() directly, call ` +
        `resolveCrossRefArgs() on the spec first.`,
      argPath,
    );
  }
  // arg.kind === "literal"
  return mapLiteralValue(arg.value, argPath);
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

/**
 * Compiles a pre-validated DeploymentSpec into a Hardhat Ignition module.
 *
 * IMPORTANT: This function does NOT call validateSpec internally — the caller
 * is responsible for passing a valid spec. For invalid specs, behaviour is
 * undefined (a CompileError may be thrown as a last resort, but not all
 * validation errors will be caught here).
 *
 * @param spec    A valid DeploymentSpec (output of a successful validateSpec).
 * @param options Optional compilation options.
 * @returns       A Hardhat Ignition module ready for deployment.
 *
 * @throws CompileError with code UNSUPPORTED_LITERAL if a literal arg value
 *   falls outside the supported shape (string | number | boolean | null | array).
 * @throws CompileError with code INTERNAL_INVARIANT if an internal invariant
 *   is violated (indicates the spec was not properly validated before calling).
 */
export function compileSpec(
  spec: DeploymentSpec,
  options?: CompileOptions,
): CompiledModule {
  const moduleId = options?.moduleId ?? "Deployment";

  // Determine build-time creation order so that every future is created
  // before any future that depends on it. See "Build-time ordering" note above.
  const orderedEntries = buildCreationOrder(spec.contracts);

  // Map from spec entry id to the Ignition future created for it.
  // We use Map (not a plain object) for prototype-pollution safety.
  // ContractFuture<string> (not the narrower NamedArtifactContractDeploymentFuture)
  // because upgradeable entries store a contractAt future here — see this
  // file's module doc, "Upgradeable proxies".
  const futureByEntryId = new Map<string, ContractFuture<string>>();

  const uupsProxyArtifact = options?.proxyArtifacts?.uups ?? "ERC1967Proxy";
  const transparentProxyArtifact =
    options?.proxyArtifacts?.transparent ?? "TransparentUpgradeableProxy";

  // IgnitionModuleResult<string> is the correct result type when we return a
  // record of contract futures.
  const module = buildModule(moduleId, (m) => {
    for (const entry of orderedEntries) {
      const entryPath = `contracts[id=${entry.id}]`;

      // Map constructor arguments — shared helper so ctorArgs, initializer
      // args, and proxyAdminOwner (below) all go through identical
      // ref/literal/param/expr/resolver handling.
      const mappedArgs: ArgumentType[] = (entry.args ?? []).map((arg, argIdx) =>
        mapContractArg(m, arg, `${entryPath}.args[${argIdx}]`, spec, futureByEntryId),
      );

      // Map `after` constraints to futures
      const afterFutures = (entry.after ?? []).map((afterId, afterIdx) => {
        const afterPath = `${entryPath}.after[${afterIdx}]`;
        const afterFuture = futureByEntryId.get(afterId);
        if (afterFuture === undefined) {
          throw new CompileError(
            "INTERNAL_INVARIANT",
            `after target "${afterId}" has not been registered as a future — was validateSpec called?`,
            afterPath,
          );
        }
        return afterFuture;
      });

      if (entry.upgradeable === undefined) {
        // Non-upgradeable path — unchanged from pre-#155 behavior.
        // Create the future. We use the overload:
        //   m.contract(contractName, args?, options?)
        // where contractName is the Solidity artifact name (entry.contract) and
        // the `id` option lets us use entry.id as the Ignition future id (to
        // avoid clashes when the same artifact is deployed multiple times).
        const future = m.contract(entry.contract, mappedArgs, {
          id: entry.id,
          ...(afterFutures.length > 0 ? { after: afterFutures } : {}),
        });

        futureByEntryId.set(entry.id, future);
        continue;
      }

      // Upgradeable path (UUPS / Transparent) — see this file's module doc,
      // "Upgradeable proxies", for the full design rationale.
      const { kind, initializer, proxyAdminOwner } = entry.upgradeable;
      const upgradeablePath = `${entryPath}.upgradeable`;

      // 1. Deploy the implementation contract. `after` applies here — every
      // future built below (proxy, contractAt) transitively depends on this
      // one, so the after-ordering constraint holds for the whole entry.
      const implFuture = m.contract(entry.contract, mappedArgs, {
        id: `${entry.id}_impl`,
        ...(afterFutures.length > 0 ? { after: afterFutures } : {}),
      });

      // 2. Encode the initializer call (or "0x" — no call) for the proxy's
      // constructor `_data` argument. Executed via delegatecall through the
      // proxy, so it initializes PROXY storage, not the implementation's.
      let initData: ArgumentType = "0x";
      if (initializer !== undefined) {
        const initArgs = (initializer.args ?? []).map((arg, argIdx) =>
          mapContractArg(
            m,
            arg,
            `${upgradeablePath}.initializer.args[${argIdx}]`,
            spec,
            futureByEntryId,
          ),
        );
        initData = m.encodeFunctionCall(implFuture, initializer.function, initArgs, {
          id: `${entry.id}_initData`,
        });
      }

      // 3. Deploy the proxy itself.
      let proxyFuture;
      if (kind === "uups") {
        proxyFuture = m.contract(uupsProxyArtifact, [implFuture, initData], {
          id: `${entry.id}_proxy`,
        });
      } else {
        // kind === "transparent"
        if (proxyAdminOwner === undefined) {
          // validateSpec's "MISSING_PROXY_ADMIN_OWNER" rejects this before
          // compileSpec() is ever reached in the normal pipeline — this is a
          // defensive last resort for direct callers who bypass validateSpec.
          throw new CompileError(
            "INTERNAL_INVARIANT",
            `transparent proxy entry "${entry.id}" has no proxyAdminOwner — was validateSpec called?`,
            `${upgradeablePath}.proxyAdminOwner`,
          );
        }
        const ownerArg = mapContractArg(
          m,
          proxyAdminOwner,
          `${upgradeablePath}.proxyAdminOwner`,
          spec,
          futureByEntryId,
        );
        proxyFuture = m.contract(transparentProxyArtifact, [implFuture, ownerArg, initData], {
          id: `${entry.id}_proxy`,
        });
      }

      // 4. Expose the entry at the proxy address, using the IMPLEMENTATION's
      // ABI. This — not implFuture or proxyFuture — is what downstream refs
      // (and the final IgnitionModuleResult) resolve to under entry.id.
      const handle = m.contractAt(entry.contract, proxyFuture, { id: entry.id });

      futureByEntryId.set(entry.id, handle);
    }

    // Return all futures keyed by entry.id for Ignition's result tracking.
    // Using Object.fromEntries is safe here: the keys come from spec entry
    // ids which have already been validated as non-empty, non-duplicate strings.
    return Object.fromEntries(futureByEntryId) as IgnitionModuleResult<string>;
  });

  return module;
}

// ---------------------------------------------------------------------------
// Upgrade flow — compiling an upgrade call for an already-deployed proxy
// ---------------------------------------------------------------------------
//
// DESIGN (issue #155, v1 scope)
// ==============================
//
// Automatic bytecode-diff-driven upgrade detection is EXPLICITLY out of
// scope (it would require the compiler to fetch on-chain bytecode and diff
// artifacts — heavy, and orthogonal to the declarative-spec model). v1
// upgrades are represented as an EXPLICIT, separate compile step:
// `compileUpgrade()` builds a standalone Ignition module — run against the
// SAME `deploymentDir`/journal as the original deployment, but under its OWN
// module id — that deploys a NEW implementation and calls the appropriate
// on-chain upgrade function:
//
//   - UUPS:        `proxy.upgradeToAndCall(newImpl, initData)` — the
//     implementation contract's own ABI (inherited from OZ's
//     `UUPSUpgradeable`) already exposes this, so we simply `m.contractAt`
//     the existing proxy address using the (new) implementation's contract
//     name and `m.call` it directly.
//   - Transparent: `ProxyAdmin.upgradeAndCall(proxy, newImpl, initData)` —
//     OZ v5's `TransparentUpgradeableProxy` deploys its OWN `ProxyAdmin`
//     internally, so its address is NOT derivable from the proxy address
//     alone. The caller MUST supply `proxyAdminAddress` explicitly (e.g.
//     read from chain state, or — once built — a `@redeploy/reader`
//     integration on top of `ProxyImplementationHistory`, see
//     `deploy/proxyHistory.ts`). `compileUpgrade()` refuses to guess.
//
// Reusing the SAME implementation future id as the original deploy (e.g.
// `${id}_impl`) would NOT trigger a redeploy on a subsequent run against the
// same journal — Ignition's journal keys futures by id, not by bytecode
// content, so an unchanged id is replayed from the journal and skipped
// regardless of source changes. `compileUpgrade()` therefore requires the
// CALLER to supply a fresh, distinct `id` for the new implementation (e.g.
// include a version suffix: "token_impl_v2") — this is how "a changed
// implementation artifact naturally produces a new impl future/deployment"
// in practice: a NEW id, not a mutated old one.
//
// `compileUpgrade()`'s constructor/initializer args are intentionally typed
// as `LiteralValue[]` (not the full `ContractArg` union) — there is no
// sibling multi-contract spec in this standalone context, so `ref` args
// (which resolve against a spec's other entries) don't make sense here.
// Args still go through `mapLiteralValue` — the SAME validated literal
// mapping used everywhere else, never raw string interpolation.
//
// STORAGE-LAYOUT SAFETY IS OUT OF SCOPE (v1) — see spec/types.ts's
// `UpgradeableConfig` doc comment. Run your own storage-layout check (e.g.
// the `@openzeppelin/upgrades-core` / `hardhat-upgrades` plugin's validator)
// before compiling an upgrade for a new implementation.

/** An initializer/reinitializer call to run atomically with an upgrade. */
export interface UpgradeInitializer {
  /** The function name (e.g. "reinitialize"). Should be a plain Solidity identifier. */
  readonly function: string;
  /** Positional arguments — literal values only (see module doc above). */
  readonly args?: LiteralValue[];
}

/** Options for `compileUpgrade()`. */
export interface UpgradeOptions {
  /**
   * The future id to use for the NEW implementation deployment. MUST be
   * different from any future id already recorded in the target
   * `deploymentDir`'s journal (e.g. append a version suffix) — reusing an
   * existing id causes Ignition to treat it as already-complete and skip
   * deploying it. See this section's module doc for the full rationale.
   */
  readonly id: string;
  /** The Solidity artifact/contract name of the NEW implementation. */
  readonly contract: string;
  /** Constructor arguments for the new implementation (literal values only). */
  readonly args?: LiteralValue[];
  /**
   * The address of the ALREADY-DEPLOYED proxy being upgraded (e.g. from a
   * previous `DeployResult.deployedAddresses[proxyId]`, or
   * `ProxyImplementationHistory.proxyAddress` — see `deploy/proxyHistory.ts`).
   */
  readonly proxyAddress: string;
  /**
   * Must match how the proxy was originally deployed (`UpgradeableConfig.kind`).
   * A mismatch will fail on-chain (wrong function selector / wrong caller).
   */
  readonly kind: "uups" | "transparent";
  /** Optional re-initializer call, executed atomically with the upgrade. */
  readonly initializer?: UpgradeInitializer;
  /**
   * REQUIRED for `kind: "transparent"` — the address of the `ProxyAdmin`
   * contract that owns upgrade rights over the proxy. `compileUpgrade()`
   * throws `CompileError("MISSING_PROXY_ADMIN_ADDRESS")` if this is absent;
   * there is deliberately no fallback (see this section's module doc).
   */
  readonly proxyAdminAddress?: string;
  /**
   * The artifact name for the `ProxyAdmin` contract (transparent only).
   * Defaults to `"ProxyAdmin"` (OpenZeppelin v5's artifact name).
   */
  readonly proxyAdminArtifact?: string;
  /**
   * The Ignition module id for this upgrade run. Defaults to `${id}Upgrade`.
   * Must be consistent across repeated runs of the SAME upgrade (for
   * idempotency/resume, exactly like `DeployOptions.moduleId`).
   */
  readonly moduleId?: string;
}

/**
 * Compiles a standalone Ignition module that upgrades an already-deployed
 * proxy to a new implementation. Intended to be run (via `deploy()` or
 * directly via Ignition's own `deploy()`) against the SAME `deploymentDir`
 * as the original deployment, but as a SEPARATE module/run — see this
 * section's module doc for the full v1 upgrade-flow design and its
 * scope boundary (no automatic bytecode-diff detection, no storage-layout
 * validation).
 *
 * @throws CompileError with code MISSING_PROXY_ADMIN_ADDRESS if
 *   `kind: "transparent"` and `proxyAdminAddress` is not supplied.
 * @throws CompileError with code UNSUPPORTED_LITERAL if an arg value falls
 *   outside the supported LiteralValue shape.
 */
export function compileUpgrade(options: UpgradeOptions): CompiledModule {
  const moduleId = options.moduleId ?? `${options.id}Upgrade`;
  const upgradePath = `upgrade[id=${options.id}]`;

  if (options.kind === "transparent" && options.proxyAdminAddress === undefined) {
    throw new CompileError(
      "MISSING_PROXY_ADMIN_ADDRESS",
      `Upgrade for transparent proxy "${options.id}" requires proxyAdminAddress ` +
        `(the ProxyAdmin contract that owns upgrade rights) — refusing to guess an owner.`,
      `${upgradePath}.proxyAdminAddress`,
    );
  }

  const module = buildModule(moduleId, (m) => {
    const mappedArgs: ArgumentType[] = (options.args ?? []).map((value, i) =>
      mapLiteralValue(value, `${upgradePath}.args[${i}]`),
    );

    const newImpl = m.contract(options.contract, mappedArgs, { id: options.id });

    let initData: ArgumentType = "0x";
    if (options.initializer !== undefined) {
      const initArgs = (options.initializer.args ?? []).map((value, i) =>
        mapLiteralValue(value, `${upgradePath}.initializer.args[${i}]`),
      );
      initData = m.encodeFunctionCall(newImpl, options.initializer.function, initArgs, {
        id: `${options.id}_initData`,
      });
    }

    if (options.kind === "uups") {
      // UUPSUpgradeable exposes upgradeToAndCall(address,bytes) — the new
      // implementation contract's own ABI (inherited from UUPSUpgradeable)
      // must include it for this call to succeed on-chain.
      const proxyAsImpl = m.contractAt(options.contract, options.proxyAddress, {
        id: `${options.id}_proxyAt`,
      });
      m.call(proxyAsImpl, "upgradeToAndCall", [newImpl, initData], {
        id: `${options.id}_upgrade`,
      });
    } else {
      // kind === "transparent" — must go through the ProxyAdmin; the proxy
      // itself rejects admin-only calls from anything but its linked
      // ProxyAdmin (OZ's TransparentUpgradeableProxy access-control design).
      const proxyAdminArtifactName = options.proxyAdminArtifact ?? "ProxyAdmin";
      // options.proxyAdminAddress is guaranteed defined here (checked above).
      const proxyAdmin = m.contractAt(proxyAdminArtifactName, options.proxyAdminAddress as string, {
        id: `${options.id}_admin`,
      });
      m.call(proxyAdmin, "upgradeAndCall", [options.proxyAddress, newImpl, initData], {
        id: `${options.id}_upgrade`,
      });
    }

    return { [options.id]: newImpl };
  });

  return module as CompiledModule;
}

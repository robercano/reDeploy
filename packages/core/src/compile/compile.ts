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
 * We use Map<string, NamedArtifactContractDeploymentFuture<string>> rather
 * than a plain object for the id→future index. Spec-derived strings must
 * never index a plain object (prototype-pollution risk).
 *
 * Literal mapping
 * ---------------
 * mapLiteralValue handles string, number, boolean, null, and nested arrays.
 * BigInt is explicitly NOT supported in v1: LiteralValue's type is
 * scalar-or-array only and the approved spec scope excludes bigint. The
 * `{ __bigint: "..." }` encoding mentioned in some doc comments is a future
 * extension. If a runtime value falls outside these shapes, CompileError
 * UNSUPPORTED_LITERAL is thrown.
 */

import { buildModule } from "@nomicfoundation/ignition-core";
import type {
  ArgumentType,
  IgnitionModule,
  IgnitionModuleResult,
  ModuleParameterType,
  NamedArtifactContractDeploymentFuture,
} from "@nomicfoundation/ignition-core";
import type { DeploymentSpec, LiteralValue, ContractEntry } from "../spec/types.js";
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
    // Ref args
    for (const arg of entry.args ?? []) {
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
      // `param` and `resolver` args add no edges (see NOTE above).
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
  const futureByEntryId = new Map<
    string,
    NamedArtifactContractDeploymentFuture<string>
  >();

  // IgnitionModuleResult<string> is the correct result type when we return a
  // record of named-artifact contract deployment futures.
  const module = buildModule(moduleId, (m) => {
    for (const entry of orderedEntries) {
      const entryPath = `contracts[id=${entry.id}]`;

      // Map constructor arguments
      const mappedArgs: ArgumentType[] = ((entry.args ?? []).map((arg, argIdx) => {
        const argPath = `${entryPath}.args[${argIdx}]`;
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
            if (
              typeof result === "object" &&
              result !== null &&
              "address" in result
            ) {
              // This is a Future-like object from Ignition
              return result as ArgumentType;
            }

            // Otherwise, map the result as a literal value
            // BigInt results are mapped as numbers (or strings for large values)
            if (typeof result === "bigint") {
              return result as unknown as ArgumentType;
            }

            // String results (hex hashes, addresses, etc.)
            return result;
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
        // arg.kind === "literal"
        return mapLiteralValue(arg.value, argPath);
      }) as unknown[]) as ArgumentType[];

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
    }

    // Return all futures keyed by entry.id for Ignition's result tracking.
    // Using Object.fromEntries is safe here: the keys come from spec entry
    // ids which have already been validated as non-empty, non-duplicate strings.
    return Object.fromEntries(futureByEntryId) as IgnitionModuleResult<string>;
  });

  return module;
}

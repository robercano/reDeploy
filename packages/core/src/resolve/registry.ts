/**
 * Typed resolver escape-hatch for computed/on-chain argument values (Layer 2).
 *
 * WHAT THIS IS
 * ============
 * Layer 1 (spec/evaluator.ts, `{ kind: "expr" }`) is a SAFE, deterministic,
 * side-effect-free expression language: no I/O, no chain access. Some
 * constructor argument values genuinely need more than that — e.g. reading a
 * value from an already-deployed EXTERNAL contract, calling a library
 * function, or hitting an oracle. For those cases a spec author can name a
 * `{ kind: "resolver", name: "..." }` arg (see spec/types.ts's ResolverArg)
 * and supply the actual implementation as an injected `Resolver` function via
 * `DeployOptions.resolvers` (deploy/deploy.ts).
 *
 * `deploy()` runs every declared resolver in an ASYNC PRE-RESOLUTION PASS
 * before `compileSpec()` ever sees the spec: the resolver's return value is
 * substituted in as a concrete `{ kind: "literal" }` arg. By the time
 * `compileSpec()` runs, resolver args no longer exist in the spec it
 * compiles — see resolve/resolveSpec.ts and deploy/deploy.ts for the pass
 * itself, and compile/compile.ts for the (should-be-unreachable-in-practice)
 * error compileSpec throws if it ever encounters an unresolved resolver arg.
 *
 * INJECTABLE, MIRRORS ConfigExecutor
 * ===================================
 * Just like `@redeploy/config`'s `ConfigExecutor` (packages/config/src/execute/types.ts)
 * is injected into `applyConfig()` rather than baked into the engine, a
 * `ResolverRegistry` is injected into `deploy()` rather than the engine
 * shipping any built-in resolvers. The engine only knows how to invoke
 * whatever function the project author registered under a given name.
 *
 * V1 SCOPE BOUNDARY (READ THIS BEFORE WRITING A RESOLVER)
 * =========================================================
 * Resolvers run in a single async pass BEFORE any contract in this deployment
 * run is deployed. At that point:
 *   - `ctx.params`            — the effective parameter values for this run
 *                                (bigint-typed, same convention as the
 *                                expression evaluator's EvaluationContext).
 *   - `ctx.resolvedAddresses` — ONLY addresses already known before this run
 *                                started: contracts deployed in a PREVIOUS
 *                                run of the same spec (read from Ignition's
 *                                journal) or externally-declared addresses.
 *                                For a fresh deployment this is commonly an
 *                                EMPTY object — that is expected, not a bug.
 *   - `ctx.provider`          — a live EIP-1193 provider for arbitrary reads
 *                                (eth_call, eth_getBalance, etc.) or invoking
 *                                a library/oracle contract that already
 *                                exists on-chain.
 *
 * Reading the address of a SIBLING CONTRACT THAT IS DEPLOYING IN THIS SAME
 * RUN IS OUT OF SCOPE FOR V1. Resolvers do not run interleaved with
 * Ignition's deployment engine — doing so would mean re-implementing
 * Ignition's own dependency/ordering engine, which CLAUDE.md explicitly
 * forbids ("don't reinvent what Hardhat Ignition already provides"). If you
 * need a sibling contract's deployed address as a constructor argument, use:
 *   - `{ kind: "ref", contract: "<id>" }` (spec/types.ts) for a plain address
 *     reference — the normal, recommended mechanism, or
 *   - Ignition's own `m.staticCall(...)` / `m.readEventArgument(...)` builder
 *     helpers (via a custom compile step) if you need a computed value that
 *     depends on a future still being deployed in this run.
 * Consequently, `resolver` args contribute NO build-order dependency edges in
 * `compile/compile.ts`'s `buildCreationOrder()` — see the comment there.
 *
 * SECURITY / TRUST BOUNDARY
 * ==========================
 * Resolver functions are ordinary TypeScript code that runs IN-PROCESS,
 * inside the same Node process that runs `deploy()`. They can read the chain
 * (via `ctx.provider`), the environment (`process.env`), and the filesystem —
 * exactly like any other code in this repo. This is intentional: resolvers
 * are meant to be TRUSTED, REVIEWED, UNIT-TESTED, IN-REPO code, authored by
 * the same project author who writes the deployment spec.
 *
 * The registry is an explicit, in-memory object INJECTED by the caller of
 * `deploy()` (`DeployOptions.resolvers`). There is NO mechanism here for
 * loading a resolver dynamically from spec data, a remote URL, or any other
 * untrusted source — and there must never be one. A `{ kind: "resolver",
 * name: "..." }` arg can only ever invoke a function the deploy() caller
 * chose to register under that exact name at call time.
 */

import type { EIP1193Provider } from "@nomicfoundation/ignition-core";
import type { LiteralValue } from "../spec/types.js";

/**
 * Context passed to every resolver invocation.
 *
 * `params` is bigint-typed for the same reason as the expression evaluator's
 * `EvaluationContext.params` (spec/evaluator.ts): constructor argument values
 * are ultimately Solidity-typed numeric values, and bigint is the only JS
 * numeric type that can represent the full uint256 range without precision
 * loss. Resolvers needing string/boolean/array parameter values declared in
 * `DeploymentSpec.parameters` should read them via a closure over the spec
 * instead of `ctx.params` (see resolve/resolveSpec.ts's `buildResolverParams`
 * for the exact bigint-coercion rules applied when building this map).
 */
export interface ResolverContext {
  /** Parameter name → bigint value, after DeployOptions.deploymentParameters overrides. */
  readonly params: Record<string, bigint>;
  /**
   * Contract id → deployed address, for addresses known BEFORE this deploy
   * run started (previous-run journal entries / externally-declared
   * addresses). Does NOT include contracts deploying in this same run — see
   * the v1 scope boundary in this file's top-level doc comment.
   */
  readonly resolvedAddresses: Record<string, string>;
  /** Live EIP-1193 provider for arbitrary on-chain reads. */
  readonly provider: EIP1193Provider;
}

/**
 * A resolver function: computes a single constructor argument value.
 *
 * SIGNATURE CHOICE: `args` is a second positional parameter rather than
 * folded into `ctx`. This keeps `ResolverContext` purely about the
 * ambient deploy-time environment (params/addresses/provider) that is the
 * SAME for every resolver invocation in a given run, while `args` are the
 * PER-CALL-SITE literal values declared on the specific `ResolverArg` that
 * triggered this invocation (`ResolverArg.args` in spec/types.ts). This
 * mirrors `spec/evaluator.ts`'s `evaluateCall(name, args, context)` shape,
 * and lets a resolver implementation be unit-tested as a plain function
 * `(ctx, args) => value` without needing to thread call-site args through the
 * context object.
 *
 * May return synchronously or asynchronously — `deploy()`'s pre-resolution
 * pass always `await`s the result, so a resolver that never performs I/O can
 * simply `return` a plain value.
 */
export type Resolver = (
  ctx: ResolverContext,
  args: readonly LiteralValue[],
) => Promise<LiteralValue> | LiteralValue;

/**
 * Injectable map of resolver name → implementation, supplied via
 * `DeployOptions.resolvers`. Mirrors `@redeploy/config`'s `ConfigExecutor`
 * injection idiom: the engine (deploy/deploy.ts) only knows how to look up
 * and invoke whatever the project author registered here — see the
 * SECURITY / TRUST BOUNDARY note above.
 */
export type ResolverRegistry = Record<string, Resolver>;

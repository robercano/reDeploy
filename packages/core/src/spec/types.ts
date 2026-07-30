/**
 * TypeScript types for the declarative deployment spec.
 *
 * A deployment spec describes a set of contracts to deploy, their constructor
 * arguments, and their ordering constraints. The spec is consumed by the
 * deployment engine to produce an ordered, idempotent deployment plan.
 */

/**
 * A reference to another deployed contract by its `id`.
 * At runtime the value will be substituted with the deployed address.
 */
export interface RefArg {
  readonly kind: "ref";
  /** The `id` of the contract being referenced. */
  readonly contract: string;
}

/**
 * A literal JSON-serializable value (string, number, boolean, null, array, or
 * bigint-as-string encoded as `{ __bigint: "123" }`).
 */
export interface LiteralArg {
  readonly kind: "literal";
  /** The actual value to pass as a constructor argument. */
  readonly value: LiteralValue;
}

/**
 * JSON-serializable scalar types supported as literal constructor arguments.
 * BigInt is encoded as a string and tagged with the discriminator in LiteralArg.
 */
export type LiteralScalar = string | number | boolean | null;

/**
 * Recursive JSON-serializable value (scalar or array of scalars/arrays).
 * Objects are intentionally excluded to avoid ambiguity with RefArg/LiteralArg.
 */
export type LiteralValue = LiteralScalar | LiteralValue[];

/**
 * A reference to a named parameter declared in the top-level
 * `DeploymentSpec.parameters` block.
 *
 * Parameters let the same spec be reused across environments/networks: the
 * spec author writes `{ kind: "param", name: "owner" }` instead of a
 * hard-coded literal. At compile time (compile/compile.ts) this is resolved
 * via Ignition's `m.getParameter(name, defaultValue)`, using the spec's
 * declared `parameters[name]` value (if any) as the default. This means the
 * VALUE actually used at deploy time can still be overridden per network via
 * `DeployOptions.deploymentParameters` (deploy/deploy.ts) without recompiling
 * the module — Ignition's own parameter-precedence rules apply.
 *
 * @example
 * ```ts
 * { kind: "param", name: "initialOwner" }
 * ```
 */
export interface ParamArg {
  readonly kind: "param";
  /** The parameter name, as declared as a key in `DeploymentSpec.parameters`. */
  readonly name: string;
}

/**
 * A computed expression that is evaluated at compile time to produce a
 * constructor argument value.
 *
 * Expressions support:
 * - BigInt arithmetic: +, -, *, /
 * - Comparison operators: <, >, <=, >=, ==, !=
 * - Functions: min(), max(), keccak256(), abi.encode(), concat(), CREATE2()
 * - References: params.<name> for parameter values, ${<contractId>} for deployed addresses
 * - Conditionals: if(condition, thenValue, elseValue)
 *
 * The expression is safe and deterministic — no arbitrary code execution,
 * no external I/O, no chain access.
 *
 * @example
 * ```ts
 * { kind: "expr", expression: "params.initialSupply * 2n" }
 * { kind: "expr", expression: "if(params.useMaxCap > 0n, params.maxCap, params.defaultCap)" }
 * { kind: "expr", expression: "keccak256(concat(abi.encode(params.data), ${otherContract}))" }
 * ```
 */
export interface ExprArg {
  readonly kind: "expr";
  /** The expression text to be evaluated at compile time. */
  readonly expression: string;
}

/**
 * A typed resolver escape-hatch: a constructor argument value computed at
 * deploy time by an injected TypeScript function (a "resolver") rather than
 * evaluated by the safe expression language (ExprArg, Layer 1).
 *
 * Resolvers exist for values that Layer 1's expression language cannot
 * produce because they require actual on-chain reads or arbitrary
 * computation (e.g. reading a value from an already-deployed external
 * contract, calling a library, hitting an oracle). A `ResolverArg` names a
 * resolver function that must be present in the `ResolverRegistry` injected
 * via `DeployOptions.resolvers` (see `resolve/registry.ts`); `deploy()` runs
 * an async pre-resolution pass BEFORE compiling the spec that invokes the
 * named resolver and substitutes its return value as a concrete literal.
 *
 * See `resolve/registry.ts` for the full `Resolver`/`ResolverContext`
 * contract, the v1 scope boundary (no sibling-contract address reads), and
 * the security/trust-boundary notes (resolvers are trusted, in-repo code —
 * never loaded dynamically from untrusted input).
 *
 * @example
 * ```ts
 * { kind: "resolver", name: "readOracleDecimals" }
 * { kind: "resolver", name: "computeSalt", args: ["v1", 42] }
 * ```
 */
export interface ResolverArg {
  readonly kind: "resolver";
  /** The resolver name — must be a key in the injected ResolverRegistry. */
  readonly name: string;
  /** Optional literal arguments passed positionally to the resolver function. */
  readonly args?: readonly LiteralValue[];
}

/**
 * A reference to a contract deployed on a DIFFERENT network than the one this
 * spec is being deployed to.
 *
 * Unlike `RefArg` (which references a sibling entry in THIS spec/run and is
 * resolved by Ignition into a real build-time future dependency), a
 * `CrossRefArg` names a `network` (an opaque string — core has no network
 * registry; see `resolve/crossRef.ts`'s `ResolveCrossRefOptions.journals`,
 * which the CALLER injects, typically backed by a project's own
 * network-to-deployment-directory mapping such as
 * `@redeploy/deploy-server`'s `NetworksRegistry`) and a `contract` id that
 * must already be deployed and journaled on THAT network.
 *
 * Resolution happens at deploy time, BEFORE compilation, via
 * `resolveCrossRefArgs()` (`resolve/crossRef.ts`): the target network's
 * Ignition journal is read (using the SAME journal primitive `deploy()` uses
 * for its own deploymentDir — see `resolve/journal.ts`) and the arg is
 * replaced with a concrete `{ kind: "literal", value: <address> }`. A
 * compiled spec must NEVER contain a `crossRef` arg — `compileSpec()` throws
 * `CompileError("UNRESOLVED_CROSS_REF_ARG")` if it ever sees one (mirrors the
 * `ResolverArg` guard).
 *
 * SCOPE BOUNDARY (v1): the referenced network's deployment must already be
 * COMPLETE before this spec is deployed. There is no cross-chain
 * orchestrator, no automatic ordering across networks, and no attempt to
 * "wait" for the other network — sequencing multi-network deployments is
 * entirely the operator's responsibility. `crossRef` args also contribute NO
 * build-order/cycle-detection edges (`validate.ts`'s `detectCycles` and
 * `compile.ts`'s `buildCreationOrder`) since the target lives outside this
 * spec's own dependency graph entirely — checking it here would be
 * meaningless (and cross-spec cycles are not a concept this library models).
 *
 * @example
 * ```ts
 * { kind: "crossRef", network: "mainnet", contract: "registry" }
 * ```
 */
export interface CrossRefArg {
  readonly kind: "crossRef";
  /**
   * The name of the OTHER network the referenced contract was deployed to.
   * Opaque to core — resolved against `ResolveCrossRefOptions.journals`
   * (resolve/crossRef.ts), which the caller injects.
   */
  readonly network: string;
  /** The `id` of the contract, as deployed on `network`. */
  readonly contract: string;
}

/**
 * A constructor argument for a contract: a ref to another contract, a literal
 * value, a named parameter, a computed expression, a typed resolver
 * escape-hatch, or a cross-chain reference to a contract deployed on a
 * different network.
 */
export type ContractArg =
  | RefArg
  | LiteralArg
  | ParamArg
  | ExprArg
  | ResolverArg
  | CrossRefArg;

/**
 * Configuration for an upgrade-time "initializer" call — the function invoked
 * atomically with proxy deployment (UUPS: as `ERC1967Proxy`'s constructor
 * `_data` argument; Transparent: as `TransparentUpgradeableProxy`'s
 * constructor `_data` argument). This is typically an OZ `Initializable`
 * contract's `initialize(...)` function, called via `delegatecall` through
 * the proxy so storage is set on the PROXY, not the implementation.
 *
 * SECURITY: `function` and `args` flow directly into on-chain calldata
 * (`compile/compile.ts` uses Ignition's `m.encodeFunctionCall`). `function`
 * is validated as a plain Solidity identifier (`validateSpec` — see
 * `SpecErrorCode` "INVALID_IDENTIFIER") and `args` go through the SAME
 * validated arg-mapping as constructor `args` (ref/literal/param/expr/
 * resolver) — never raw string interpolation.
 */
export interface UpgradeableInitializer {
  /** The initializer function name (e.g. "initialize"). Must be a plain Solidity identifier. */
  readonly function: string;
  /** Arguments to the initializer function, in order. */
  readonly args?: ContractArg[];
}

/**
 * Marks a `ContractEntry` as deployed behind an upgradeable proxy instead of
 * directly. See `compile/compile.ts`'s module doc for the exact Ignition
 * primitives used to build the proxy (ignition-core 0.15.15 has no built-in
 * `m.proxy` helper, so we compose `m.contract` + `m.encodeFunctionCall` +
 * `m.contractAt` by hand, following the standard OpenZeppelin proxy pattern).
 *
 * Regardless of `kind`, the entry's `id` always resolves (for downstream
 * `ref`s AND in `DeployResult.deployedAddresses`) to the PROXY's address,
 * never the implementation's — that's the whole point of a proxy: callers
 * interact with the stable proxy address across upgrades. The implementation
 * is deployed under future id `${id}_impl` and the proxy under `${id}_proxy`.
 *
 * STORAGE-LAYOUT SAFETY IS OUT OF SCOPE (v1): this library does NOT validate
 * that a new implementation's storage layout is compatible with the previous
 * one. Run your own storage-layout check before deploying a new
 * implementation for an existing proxy (e.g. the `@openzeppelin/upgrades-core`
 * / `hardhat-upgrades` plugin's validator, or `forge inspect --pretty
 * storage-layout`). Deploying an incompatible implementation WILL corrupt
 * proxy storage — reDeploy does not (and cannot, without a storage-layout
 * database) protect you from this.
 */
export interface UpgradeableConfig {
  /**
   * The proxy pattern to use.
   *   - `"uups"`: the implementation itself controls upgrades (must inherit
   *     OZ's `UUPSUpgradeable` and implement `_authorizeUpgrade`). Proxy
   *     artifact: `ERC1967Proxy`.
   *   - `"transparent"`: a separate `ProxyAdmin` contract (deployed
   *     internally by OZ v5's `TransparentUpgradeableProxy`) controls
   *     upgrades. Proxy artifact: `TransparentUpgradeableProxy`.
   */
  readonly kind: "uups" | "transparent";
  /**
   * Optional initializer call, executed atomically with proxy deployment.
   * If omitted, the proxy's constructor `_data` argument is `"0x"` (no call)
   * — the implementation must then be initialized separately (e.g. via a
   * later `config` step) or not require initialization at all.
   */
  readonly initializer?: UpgradeableInitializer;
  /**
   * The INITIAL owner of the proxy's `ProxyAdmin` (transparent proxies
   * only — OZ v5's `TransparentUpgradeableProxy` deploys its own
   * `ProxyAdmin`, owned by this address; only that owner may later call
   * `ProxyAdmin.upgradeAndCall`). NOT used for `"uups"` (uups proxies have
   * no separate ProxyAdmin — upgrade rights live in the implementation's
   * `_authorizeUpgrade` override).
   *
   * SECURITY: REQUIRED for `kind: "transparent"` — `validateSpec` reports a
   * `MISSING_PROXY_ADMIN_OWNER` error if it is absent. There is deliberately
   * NO fallback default (e.g. `address(0)` or the deployer account) — an
   * unset proxy-admin owner is an access-control footgun, not a convenience
   * default. Declaring `proxyAdminOwner` on a `"uups"` entry is flagged as
   * `UNUSED_PROXY_ADMIN_OWNER` (rejected, not silently ignored) since it
   * signals likely author confusion about which proxy pattern is in use.
   */
  readonly proxyAdminOwner?: ContractArg;
}

/**
 * A single contract entry in a deployment spec.
 */
export interface ContractEntry {
  /**
   * Unique deployment identifier. Two entries with the same `contract`
   * (artifact) but different `id`s are permitted (deploy the same contract
   * twice under different names). Duplicate `id` is an error.
   */
  readonly id: string;
  /**
   * The Solidity artifact / contract name (e.g. "Token", "Vault").
   * Does NOT need to be unique — the same artifact may be deployed multiple
   * times.
   */
  readonly contract: string;
  /**
   * Constructor arguments in order. Each element is either a literal value or
   * a reference to another contract's deployed address.
   */
  readonly args?: ContractArg[];
  /**
   * Explicit ordering constraints: this contract will be deployed after all
   * contracts listed by their `id` here. This supplements the ordering implied
   * by `args` refs.
   */
  readonly after?: string[];
  /**
   * Deploy this entry behind an upgradeable proxy (UUPS or Transparent)
   * instead of directly. Optional — omitting it is fully backward compatible
   * with pre-upgradeable specs (the entry deploys exactly as before). See
   * `UpgradeableConfig`'s docs for the full behavior, including which
   * address `id` resolves to and the storage-layout-safety scope boundary.
   */
  readonly upgradeable?: UpgradeableConfig;
}

/**
 * The top-level declarative deployment spec.
 *
 * @example
 * ```ts
 * const spec: DeploymentSpec = {
 *   version: 1,
 *   contracts: [
 *     { id: "registry", contract: "Registry" },
 *     { id: "token", contract: "Token", args: [
 *       { kind: "literal", value: "My Token" },
 *       { kind: "literal", value: "MTK" },
 *     ]},
 *     { id: "vault", contract: "Vault", args: [
 *       { kind: "ref", contract: "token" },
 *     ], after: ["registry"] },
 *   ],
 * };
 * ```
 */
export interface DeploymentSpec {
  /** Schema version — always `1` for this generation of the spec. */
  readonly version: 1;
  /** Ordered list of contract deployment entries. */
  readonly contracts: ContractEntry[];
  /**
   * Named parameter default values, keyed by parameter name, referenced from
   * `ContractArg`s of kind `"param"`. Optional — specs with no `ParamArg`
   * usage do not need this field (backward compatible with pre-parameter
   * specs).
   *
   * Every parameter NAME referenced by a `{ kind: "param" }` arg anywhere in
   * `contracts` must appear as a key here — `validateSpec` reports an
   * `UNKNOWN_PARAM` error otherwise.
   *
   * These are DEFAULT values only. The effective value used for a given
   * deployment can still be overridden per network/environment via
   * `DeployOptions.deploymentParameters` (deploy/deploy.ts), without needing
   * a different spec — see ParamArg's docs for the full resolution story.
   */
  readonly parameters?: Record<string, LiteralValue>;
  /**
   * Declarative PREFLIGHT policy: pre-broadcast safety checks that run
   * BEFORE any transaction is sent (see `deploy/preflight.ts` and
   * `deploy/deploy.ts`'s phase ordering). Optional — specs without it are
   * unchanged and fully backward compatible (no preflight checks run, zero
   * extra RPC calls).
   *
   * This is the DECLARATIVE base policy, checked in against the spec. The
   * EFFECTIVE policy used by a given `deploy()` call is a per-field merge of
   * this value and `DeployOptions.preflight` (the per-call override wins per
   * field) — see `deploy/preflight.ts`'s `mergePreflightPolicies`. This lets
   * a spec declare a sane default (e.g. `expectedChainId` for the network it
   * targets) while callers such as `@redeploy/deploy-server` still apply
   * per-network overrides (e.g. a stricter `maxGasPriceWei`) without editing
   * the spec.
   */
  readonly preflight?: PreflightPolicy;
}

/**
 * A declarative pre-broadcast safety policy: up to three independent,
 * optional checks (`expectedChainId`, `minBalanceWei`, `maxGasPriceWei`) run
 * BEFORE any transaction is broadcast. Declared here (a spec-level shape used
 * by both the schema/validate layer and `DeploymentSpec.preflight`) and
 * re-exported as the canonical public type from `deploy/preflight.ts`, which
 * owns the actual `runPreflight` check logic and the merge-with-DeployOptions
 * semantics — see that module's docs for the full design.
 */
export interface PreflightPolicy {
  /**
   * The chain id the RPC endpoint is expected to report via `eth_chainId`.
   * Must be a positive integer. A mismatch is a `"chainId"` failure — the
   * classic "pointed the deploy at the wrong network" mistake.
   */
  readonly expectedChainId?: number;
  /**
   * Minimum required balance (in wei) for the deployer account, as a decimal
   * bigint-encoded string (e.g. `"1000000000000000000"` for 1 ETH). The
   * deployer account is `DeployOptions.defaultSender ?? accounts[0]`.
   */
  readonly minBalanceWei?: string;
  /**
   * Maximum acceptable current network gas price (in wei), as a decimal
   * bigint-encoded string. Guards against deploying during a gas spike.
   */
  readonly maxGasPriceWei?: string;
}

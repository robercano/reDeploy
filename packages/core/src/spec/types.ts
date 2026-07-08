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
 * A constructor argument for a contract: a ref to another contract, a literal
 * value, a named parameter, or a computed expression.
 */
export type ContractArg = RefArg | LiteralArg | ParamArg | ExprArg;

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
}

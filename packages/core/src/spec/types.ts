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
 * A constructor argument for a contract: either a ref to another contract or a
 * literal value.
 */
export type ContractArg = RefArg | LiteralArg;

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
}

/**
 * TypeScript types for declarative post-deployment configuration steps.
 *
 * A configuration spec describes a sequence of steps to run against already-
 * deployed contracts (setters, role grants, wiring). Steps are identified by a
 * unique `id` so the engine can resume partial configuration idempotently.
 *
 * Argument types: this module reuses `RefArg`, `LiteralArg`, and `LiteralValue`
 * directly from `@redeploy/core` to avoid duplication and honour the declared
 * dependency direction (core → config). The only config-local alias is
 * `ConfigArg`, which is the same discriminated union but named to make step
 * signatures self-documenting.
 */

// Re-export the argument types from core so consumers of @redeploy/config do
// not need to import from @redeploy/core just to construct steps.
export type { RefArg, LiteralArg, LiteralValue } from "@redeploy/core";
import type { RefArg, LiteralArg } from "@redeploy/core";

/**
 * A step argument: either a reference to a deployed contract (resolved to its
 * address at execution time) or a literal JSON-serializable value.
 *
 * Intentionally an alias for `ContractArg` from core — using a config-local
 * name makes step typings self-documenting without introducing new semantics.
 */
export type ConfigArg = RefArg | LiteralArg;

// ---------------------------------------------------------------------------
// ConfigStep variants
// ---------------------------------------------------------------------------

/**
 * A generic setter call on a deployed contract.
 *
 * @example
 * ```ts
 * const step: SetXStep = {
 *   kind: "setX",
 *   id: "set-fee",
 *   target: "feeController",
 *   function: "setFee",
 *   args: [{ kind: "literal", value: 500 }],
 * };
 * ```
 */
export interface SetXStep {
  /** Discriminant — always `"setX"`. */
  readonly kind: "setX";
  /**
   * Unique, non-empty step identifier within a `ConfigSpec`.
   * Used by the execution engine to checkpoint partial runs idempotently.
   */
  readonly id: string;
  /**
   * Deployment id of the target contract (the one whose setter is called).
   * Must resolve to a known deployed contract when a deployment is provided.
   */
  readonly target: string;
  /**
   * Name of the setter function to call on `target` (e.g. `"setFee"`).
   * Must be a non-empty string.
   */
  readonly function: string;
  /**
   * Positional call arguments. Each is either a ref to a deployed contract
   * (resolved to its address) or a literal value.
   */
  readonly args?: ConfigArg[];
}

/**
 * Grant a role on an access-controlled contract.
 *
 * @example
 * ```ts
 * const step: GrantRoleStep = {
 *   kind: "grantRole",
 *   id: "grant-minter",
 *   target: "token",
 *   role: "MINTER_ROLE",
 *   account: { kind: "ref", contract: "minterContract" },
 * };
 * ```
 */
export interface GrantRoleStep {
  /** Discriminant — always `"grantRole"`. */
  readonly kind: "grantRole";
  /**
   * Unique, non-empty step identifier within a `ConfigSpec`.
   */
  readonly id: string;
  /**
   * Deployment id of the access-controlled contract receiving the role grant.
   * Must resolve to a known deployed contract when a deployment is provided.
   */
  readonly target: string;
  /**
   * Role identifier string (e.g. `"MINTER_ROLE"`, `"DEFAULT_ADMIN_ROLE"`).
   * Must be a non-empty string.
   */
  readonly role: string;
  /**
   * The account that receives the role. Can be a ref to a deployed contract
   * (resolved to its address) or a literal address string.
   */
  readonly account: ConfigArg;
}

/**
 * Wire one deployed contract into another via a setter.
 *
 * The pattern is: call `into.<function>(source-address)` — i.e. register the
 * `source` contract inside the `into` contract.
 *
 * @example
 * ```ts
 * const step: WireStep = {
 *   kind: "wire",
 *   id: "wire-token-into-vault",
 *   source: "token",
 *   into: "vault",
 *   function: "setToken",
 * };
 * ```
 */
export interface WireStep {
  /** Discriminant — always `"wire"`. */
  readonly kind: "wire";
  /**
   * Unique, non-empty step identifier within a `ConfigSpec`.
   */
  readonly id: string;
  /**
   * Deployment id of the contract whose address is passed into `into`.
   * Must resolve to a known deployed contract when a deployment is provided.
   */
  readonly source: string;
  /**
   * Deployment id of the contract that receives the wiring call.
   * Must resolve to a known deployed contract when a deployment is provided.
   */
  readonly into: string;
  /**
   * Name of the setter function on `into` that accepts the `source` address
   * (e.g. `"setToken"`). Must be a non-empty string.
   */
  readonly function: string;
}

// ---------------------------------------------------------------------------
// ConfigStep discriminated union
// ---------------------------------------------------------------------------

/**
 * A single declarative post-deployment configuration step.
 *
 * Discriminated on `kind` — consumers can switch/narrow exhaustively.
 *
 * @example
 * ```ts
 * const spec: ConfigSpec = {
 *   version: 1,
 *   steps: [
 *     {
 *       kind: "setX",
 *       id: "set-fee",
 *       target: "feeController",
 *       function: "setFee",
 *       args: [{ kind: "literal", value: 500 }],
 *     },
 *     {
 *       kind: "grantRole",
 *       id: "grant-minter",
 *       target: "token",
 *       role: "MINTER_ROLE",
 *       account: { kind: "ref", contract: "minterContract" },
 *     },
 *     {
 *       kind: "wire",
 *       id: "wire-token-into-vault",
 *       source: "token",
 *       into: "vault",
 *       function: "setToken",
 *     },
 *   ],
 * };
 * ```
 */
export type ConfigStep = SetXStep | GrantRoleStep | WireStep;

// ---------------------------------------------------------------------------
// ConfigSpec — top-level container
// ---------------------------------------------------------------------------

/**
 * The top-level declarative post-deployment configuration spec.
 *
 * @example
 * ```ts
 * const spec: ConfigSpec = {
 *   version: 1,
 *   steps: [
 *     { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
 *   ],
 * };
 * ```
 */
export interface ConfigSpec {
  /** Schema version — always `1` for this generation of the spec. */
  readonly version: 1;
  /** Ordered list of configuration steps to apply. */
  readonly steps: ConfigStep[];
}

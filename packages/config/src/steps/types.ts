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
 *
 * Ordered vs. unordered steps:
 *
 *   ConfigSpec supports two complementary lists of steps:
 *
 *   - `steps` — unordered, per-node steps. The execution engine may iterate them
 *     in any order (currently array order, but callers must not rely on it).
 *     These represent per-node configuration that is logically independent of
 *     other nodes' configuration.
 *
 *   - `orderedSteps` — globally ordered steps. Executed in strict array index
 *     order, after all unordered steps. Use these when the exact sequence of
 *     calls matters (e.g. step B depends on the state written by step A).
 *
 *   Both lists share the same step-id namespace — duplicate ids across the two
 *   lists are rejected by the validator. Steps in both lists may reference
 *   deployed contract addresses via `{ kind: "ref", contract: "<deploy-id>" }`
 *   in arg fields, or a deploy-id address via `{ kind: "addressRef",
 *   deployId: "<deploy-id>" }` in target / source / into fields.
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
 *
 * To pass a deployed contract's address as an argument, use a `RefArg`:
 * `{ kind: "ref", contract: "<deploy-id>" }`.
 */
export type ConfigArg = RefArg | LiteralArg;

// ---------------------------------------------------------------------------
// AddressRef — explicit address-of-a-deployed-contract reference
// ---------------------------------------------------------------------------

/**
 * An explicit reference to a deployed contract's on-chain address, by its
 * deploy-id. At execution time the engine resolves `deployId` to the contract's
 * address from `deployedAddresses`.
 *
 * This is syntactically equivalent to `{ kind: "ref", contract: deployId }`
 * when used in an `args` position. `AddressRef` is provided as a named,
 * self-documenting alias so studio tooling and consumers do not need to use the
 * generic "ref" nomenclature when the intent is specifically "the address of
 * this deployed contract".
 *
 * @example
 * ```ts
 * const ref: AddressRef = { kind: "addressRef", deployId: "token" };
 * // Step arg usage — resolves to token's on-chain address at execution time.
 * const step: SetXStep = {
 *   kind: "setX",
 *   id: "register-token",
 *   target: "registry",
 *   function: "register",
 *   args: [ref],
 * };
 * ```
 */
export interface AddressRef {
  /** Discriminant — always `"addressRef"`. */
  readonly kind: "addressRef";
  /**
   * The deploy-id of the contract whose address should be resolved.
   * Must match a key in `deployedAddresses` at execution time.
   */
  readonly deployId: string;
}

/**
 * Extended step argument type that includes `AddressRef` in addition to the
 * core `RefArg` and `LiteralArg`. Use `ConfigArgExtended` when you want to
 * express an address-of-contract reference with the explicit `"addressRef"` kind.
 *
 * The execution engine accepts both `ConfigArg` (with `RefArg`) and
 * `ConfigArgExtended` (with `AddressRef`). Both resolve to the same on-chain
 * address at execution time.
 */
export type ConfigArgExtended = RefArg | LiteralArg | AddressRef;

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
 *
 * @example With an address reference:
 * ```ts
 * const step: SetXStep = {
 *   kind: "setX",
 *   id: "register-token",
 *   target: "registry",
 *   function: "register",
 *   args: [{ kind: "addressRef", deployId: "token" }],
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
   *
   * To pass a deployed contract's address as an argument, use a `RefArg`:
   * `{ kind: "ref", contract: "<deploy-id>" }`.
   *
   * Studio tooling may use `AddressRef` (`{ kind: "addressRef", deployId }`)
   * internally; it must normalize to `RefArg` before producing a `ConfigSpec`.
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
   *
   * To reference a deployed contract's address, use a `RefArg`:
   * `{ kind: "ref", contract: "<deploy-id>" }`.
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
 * Two complementary step lists are supported:
 *
 * **`steps` (unordered)**
 *   Per-node configuration steps. The execution engine makes no guarantee about
 *   the execution order between steps in this list (currently array order, but
 *   callers must not depend on it). These represent logically independent node
 *   configuration that could be parallelised in the future.
 *
 * **`orderedSteps` (globally ordered)**
 *   Steps that must run in strict array-index order. The engine executes them
 *   sequentially, in order, after all unordered `steps` have been processed.
 *   Use this list when later steps depend on state written by earlier ones.
 *
 * Both lists share the same step-id namespace. The validator rejects any spec
 * where the same id appears in both lists or more than once in either list.
 *
 * Backward compatibility: existing specs that only have `steps` continue to
 * work unchanged. `orderedSteps` is optional and defaults to an empty list.
 *
 * @example
 * ```ts
 * const spec: ConfigSpec = {
 *   version: 1,
 *   // Unordered per-node steps (order not guaranteed)
 *   steps: [
 *     { kind: "setX", id: "set-fee", target: "feeController", function: "setFee" },
 *     { kind: "setX", id: "set-limit", target: "vault", function: "setLimit",
 *       args: [{ kind: "literal", value: 1000 }] },
 *   ],
 *   // Ordered global steps — executed in array order, after steps
 *   orderedSteps: [
 *     { kind: "wire", id: "wire-token-into-vault", source: "token", into: "vault",
 *       function: "setToken" },
 *     { kind: "grantRole", id: "grant-minter", target: "token",
 *       role: "MINTER_ROLE", account: { kind: "ref", contract: "minterContract" } },
 *   ],
 * };
 * ```
 */
export interface ConfigSpec {
  /** Schema version — always `1` for this generation of the spec. */
  readonly version: 1;
  /**
   * Unordered per-node configuration steps.
   *
   * Steps in this list have no guaranteed execution order relative to each
   * other. The engine currently iterates them in array order, but callers
   * MUST NOT rely on that — treat these as a bag of independent node-level
   * configuration operations.
   *
   * All three step kinds (setX / grantRole / wire) are supported.
   */
  readonly steps: ConfigStep[];
  /**
   * Globally ordered configuration steps.
   *
   * Steps in this list are executed in strict array-index order, after all
   * unordered `steps` have been processed. The execution engine guarantees
   * that step N+1 is not started until step N has completed (and been
   * recorded in the journal).
   *
   * Use this list for steps whose correctness depends on a specific sequence
   * (e.g. grant a role that was set up by a prior step).
   *
   * Optional — omit or pass an empty array for specs that do not need
   * ordered global steps. Existing specs without this field remain valid.
   */
  readonly orderedSteps?: ConfigStep[];
}

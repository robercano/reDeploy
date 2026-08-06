/**
 * Safe Transaction Builder-compatible JSON batch output (issue #154, point 3).
 *
 * `buildSafeBatch()` converts a `ProposedTransaction[]` (from
 * `proposeDeploy()` — propose/propose.ts) into the minimal JSON shape the
 * Safe Transaction Builder UI/CLI accepts for a batch import: `version`,
 * `chainId`, `createdAt`, `meta`, and `transactions[]` with `to`/`value`/
 * `data`. This is a pure, offline transform — no network access, no Safe
 * Transaction Service API call (see the module doc below for that seam).
 *
 * SCOPE BOUNDARY — contract CREATION cannot be represented (documented seam)
 * ==============================================================================
 * A `ProposedTransaction` with `to === null` is a raw contract-CREATION
 * transaction — exactly what Ignition's basic strategy sends for `m.contract`
 * futures (no `to`, `data` is init code + encoded constructor args). The Safe
 * Transaction Builder format — and Safe's `execTransaction` itself — has NO
 * representation for this: a Safe transaction is always a `CALL` (or
 * `DELEGATECALL`) to an explicit `to` address; Safe contracts cannot
 * originate a raw `CREATE`.
 *
 * Production Safe-based contract deployment works around this by routing
 * creation through a deterministic deployment factory (e.g. the widely-used
 * CREATE2 proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956`), which turns
 * the step into an ordinary CALL (`to: <factory>`, `data: <salt + initcode>`).
 * Wiring that up (an alternate Ignition strategy, or a compile-time rewrite
 * of creation futures into factory calls) is EXPLICITLY OUT OF SCOPE for
 * this change — `buildSafeBatch()` throws a clear `SafeBatchError` if the
 * input contains any `to === null` entry, rather than silently emitting an
 * invalid batch. Config/call-only batches (post-deployment configuration —
 * every transaction already has a real `to`) are fully supported today.
 *
 * SAFE TRANSACTION SERVICE API (OPTIONAL — NOT IMPLEMENTED)
 * =============================================================
 * Issue #154 allows (but does not require) actually PROPOSING the batch via
 * Safe's Transaction Service API (`POST /v1/safes/{address}/multisig-transactions/`),
 * "only if it comes cheap and is fully unit-testable without network". That
 * endpoint requires an EIP-712 signature over the Safe transaction hash from
 * an actual Safe owner and a live (or heavily mocked) HTTP round-trip to
 * Safe's infrastructure — properly unit-testing that without a network
 * dependency means mocking Safe's API contract in detail, which is a
 * meaningfully sized follow-up, not a "comes cheap" addition here. This file
 * deliberately stops at producing the batch JSON — a caller can feed it to
 * the Safe Transaction Builder UI directly (drag-and-drop import) today, or
 * a follow-up ticket can add a thin HTTP client on top of this same
 * `SafeBatchJson` shape.
 */

import type { ProposedTransaction } from "./propose.js";

/** Discriminated error code for SafeBatchError. */
export type SafeBatchErrorCode = "UNSUPPORTED_CREATION";

/**
 * Thrown by buildSafeBatch() when the input batch contains a transaction
 * that cannot be represented in the Safe Transaction Builder format — see
 * this file's module doc, "SCOPE BOUNDARY".
 */
export class SafeBatchError extends Error {
  readonly code: SafeBatchErrorCode;

  constructor(code: SafeBatchErrorCode, message: string) {
    super(message);
    this.name = "SafeBatchError";
    this.code = code;
  }
}

/** One transaction entry in the Safe Transaction Builder batch JSON schema. */
export interface SafeBatchTransactionJson {
  readonly to: string;
  readonly value: string;
  readonly data: string;
}

/** The Safe Transaction Builder batch JSON schema (minimal viable subset). */
export interface SafeBatchJson {
  readonly version: string;
  readonly chainId: string;
  readonly createdAt: number;
  readonly meta: {
    readonly name: string;
    readonly description: string;
    readonly txBuilderVersion: string;
  };
  readonly transactions: SafeBatchTransactionJson[];
}

/** Options for buildSafeBatch(). */
export interface BuildSafeBatchOptions {
  /** The chain id the batch targets (e.g. 1 for mainnet). */
  readonly chainId: number;
  /** Optional human-readable batch name. Defaults to "reDeploy batch". */
  readonly name?: string;
  /** Optional human-readable description. Defaults to "". */
  readonly description?: string;
  /**
   * Override for `Date.now()` — lets tests assert an exact `createdAt`
   * without mocking global time. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * Builds a Safe Transaction Builder-compatible batch JSON object from an
 * ORDERED list of proposed transactions (see propose/propose.ts's
 * `ProposeResult.transactions` — order is preserved verbatim here, matching
 * how the Transaction Builder / Safe's `MultiSend` executes batch entries
 * strictly in array order).
 *
 * SECURITY: no private key or signer material ever flows through this
 * function — it operates purely on the already-public `to`/`data`/`value`
 * transaction shape.
 *
 * @throws SafeBatchError with code "UNSUPPORTED_CREATION" if any transaction
 *   has `to === null` (a raw contract-creation step) — see this file's
 *   module doc, "SCOPE BOUNDARY".
 */
export function buildSafeBatch(
  transactions: readonly ProposedTransaction[],
  options: BuildSafeBatchOptions,
): SafeBatchJson {
  const creationIndexes = transactions
    .map((tx, index) => ({ tx, index }))
    .filter(({ tx }) => tx.to === null)
    .map(({ index }) => index);

  if (creationIndexes.length > 0) {
    throw new SafeBatchError(
      "UNSUPPORTED_CREATION",
      `buildSafeBatch: ${creationIndexes.length} transaction(s) at index [${creationIndexes.join(", ")}] ` +
        `are raw contract-creation steps ("to": null). The Safe Transaction Builder format has no ` +
        `representation for a raw CREATE — Safe's execTransaction always calls an explicit "to" address. ` +
        `Production Safe-based contract deployment requires routing creation through a deterministic ` +
        `deployment factory (e.g. a CREATE2 proxy) so the step becomes an ordinary call. This is a ` +
        `documented, deferred seam (see packages/core/README.md's "Propose mode" section) — NOT ` +
        `implemented by buildSafeBatch(). Config/call-only batches (every transaction has a non-null ` +
        `"to") are fully supported.`,
    );
  }

  return {
    version: "1.0",
    chainId: String(options.chainId),
    createdAt: (options.now ?? Date.now)(),
    meta: {
      name: options.name ?? "reDeploy batch",
      description: options.description ?? "",
      txBuilderVersion: "1.16.5",
    },
    transactions: transactions.map((tx) => ({
      to: tx.to as string,
      value: tx.value,
      data: tx.data,
    })),
  };
}

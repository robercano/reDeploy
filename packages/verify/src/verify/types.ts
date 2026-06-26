/**
 * Shared types for the @redeploy/verify module.
 *
 * This file defines the stable public surface: the VerifierClient interface,
 * status unions, result types, and the input contract entry shape.
 *
 * DESIGN NOTES
 * ============
 *
 * Status model
 * ------------
 * Per-contract verification can be in one of four states:
 *   "verified"         — provider confirmed the source matches the on-chain bytecode.
 *   "already-verified" — provider reports the contract was already verified
 *                        previously. Treated as success (overall success stays true).
 *   "pending"          — submission was accepted but the provider has not yet
 *                        finished (e.g. Etherscan's asynchronous verification queue).
 *   "failed"           — the provider rejected the submission or returned an error.
 *                        Overall success becomes false.
 *
 * Throw vs. return distinction (mirrors @redeploy/core deploy.ts)
 * ---------------------------------------------------------------
 * verifyDeployment() THROWS a VerifyError (with a stable VerifyErrorCode) for
 * setup/usage errors: missing API key, empty contract set, unknown contract id,
 * malformed entry, unsupported provider. These are programmer errors — the
 * caller should fix them before retrying.
 *
 * Per-contract provider failures (network errors, HTTP non-2xx, rejected
 * submissions) are NOT thrown. They are returned as ContractVerifyResult
 * entries with status "failed" and a human-readable message.
 *
 * VerifierClient interface
 * ------------------------
 * The VerifierClient<TSubmitRequest> interface is the seam between
 * verifyDeployment() and any concrete verifier (Etherscan, Sourcify, mock).
 * It is generic on TSubmitRequest so each client can require the exact fields
 * it needs without a loose base type.
 */

// ---------------------------------------------------------------------------
// Status union
// ---------------------------------------------------------------------------

/**
 * The verification status of a single contract after a verifyDeployment() call.
 *
 * - "verified"         — successfully verified by the provider.
 * - "already-verified" — the provider reports the contract was already verified;
 *                        treated as success.
 * - "pending"          — submitted but the provider has not yet finished.
 * - "failed"           — the provider rejected or errored; check `message`.
 */
export type VerificationStatus = "verified" | "already-verified" | "pending" | "failed";

// ---------------------------------------------------------------------------
// VerifierClient interface
// ---------------------------------------------------------------------------

/**
 * Base shape for a submit request. Concrete client types extend this.
 */
export interface SubmitRequest {
  /** Deployed contract address. */
  readonly address: string;
  /** Solidity contract name (artifact name). */
  readonly contractName: string;
}

/**
 * Result of a submit() call.
 */
export interface SubmitResult {
  /** Current status after submit. */
  readonly status: VerificationStatus;
  /**
   * Human-readable message. Present for "failed" status and sometimes for
   * "already-verified" (provider message).
   */
  readonly message?: string;
  /**
   * Provider-issued GUID for async status polling.
   * Only present when status is "pending" (Etherscan-style async verification).
   */
  readonly guid?: string;
}

/**
 * Result of a checkStatus() call.
 */
export interface StatusResult {
  /** Current status from the provider. */
  readonly status: VerificationStatus;
  /**
   * Human-readable message. Present for "failed" and "pending" with detail.
   */
  readonly message?: string;
}

/**
 * Minimal injectable verifier client interface.
 *
 * @typeParam TSubmitRequest — The client-specific submit request type.
 *   Each concrete client (Etherscan, Sourcify) extends SubmitRequest with
 *   its own required fields.
 *
 * Both submit() and checkStatus() must be implemented. isVerified() is
 * optional — clients that don't support it return false.
 *
 * The interface is intentionally minimal so mocks stay simple in tests.
 */
export interface VerifierClient<TSubmitRequest extends SubmitRequest = SubmitRequest> {
  /**
   * Submit a contract for verification.
   *
   * @param request - Client-specific submit request. Must include at least
   *   `address` and `contractName`.
   * @returns A SubmitResult. Never throws for provider-level errors —
   *   returns status "failed" instead.
   */
  submit(request: TSubmitRequest): Promise<SubmitResult>;

  /**
   * Check the verification status of a previously submitted GUID.
   *
   * @param guid - The GUID returned by a prior submit() call with status
   *   "pending". The format is provider-specific.
   * @returns A StatusResult. Never throws for provider-level errors.
   */
  checkStatus(guid: string): Promise<StatusResult>;

  /**
   * Check whether a contract address is already verified on the provider.
   *
   * Optional — clients that do not support this return false.
   *
   * @param address - The deployed contract address.
   */
  isVerified?(address: string): Promise<boolean>;

  /**
   * Poll checkStatus() until a terminal state (verified/already-verified/failed)
   * or until the max poll attempts are exhausted.
   *
   * Optional — clients that support async polling should implement this.
   * The verifyDeployment() orchestrator calls this when submit() returns
   * status "pending" and the client exposes this method.
   */
  pollUntilDone?(guid: string): Promise<StatusResult>;
}

// ---------------------------------------------------------------------------
// Input contract entry for verifyDeployment()
// ---------------------------------------------------------------------------

/**
 * A single deployed contract entry passed to verifyDeployment().
 *
 * The caller is responsible for supplying the source/compiler information.
 * verifyDeployment() does NOT recompile. Source code (sourceCode for
 * Etherscan, files map for Sourcify) is passed as-is to the underlying
 * client.
 */
export interface ContractVerifyEntry {
  /** Unique contract id (used as the key in the result). */
  readonly id: string;
  /** Deployed contract address (hex, checksummed or lowercase). */
  readonly address: string;
  /**
   * Solidity contract name (artifact name), e.g. "Token".
   * Sent as `contractname` to Etherscan.
   */
  readonly contractName: string;
  /**
   * Solidity compiler version string, e.g. "v0.8.28+commit.7893614a".
   * Required for Etherscan. May be omitted for Sourcify (it reads from
   * metadata.json).
   */
  readonly compilerVersion?: string;
  /**
   * ABI-encoded constructor arguments (hex, without 0x prefix).
   * Note: passed to Etherscan as `constructorArguements` (historical
   * misspelling on the wire). Optional — defaults to "".
   */
  readonly constructorArguments?: string;
  /**
   * Source code or standard-json-input string (for Etherscan).
   * This client does NOT recompile — the caller must supply the compiled
   * standard-json-input or flat source.
   */
  readonly sourceCode?: string;
  /**
   * Source code format for Etherscan.
   * @default "solidity-standard-json-input"
   */
  readonly codeFormat?: "solidity-standard-json-input" | "solidity-single-file";
  /**
   * Files map for Sourcify verification (metadata.json + source files).
   * Keys are file names (e.g. "metadata.json", "contracts/Token.sol"),
   * values are file contents as strings.
   */
  readonly files?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Per-contract result type
// ---------------------------------------------------------------------------

/**
 * The verification result for a single contract.
 */
export interface ContractVerifyResult {
  /** The contract id (from ContractVerifyEntry.id). */
  readonly id: string;
  /** The deployed address. */
  readonly address: string;
  /** Verification status after the provider call. */
  readonly status: VerificationStatus;
  /**
   * Human-readable message from the provider. Present for "failed" status
   * and sometimes for other statuses (e.g. provider-specific info).
   */
  readonly message?: string;
  /**
   * Provider-issued GUID. Only present for Etherscan-style submissions that
   * remain in "pending" status after polling.
   */
  readonly guid?: string;
}

// ---------------------------------------------------------------------------
// Top-level result type
// ---------------------------------------------------------------------------

/**
 * The result of a verifyDeployment() call.
 *
 * `success` is true iff every contract's status is "verified" or
 * "already-verified". A single "failed" or "pending" contract makes
 * success false.
 */
export interface VerifyDeploymentResult {
  /**
   * True iff every contract reached a "verified" or "already-verified" status.
   * False if any contract is "failed" or "pending".
   */
  readonly success: boolean;
  /** Per-contract results in submission order. */
  readonly results: ReadonlyArray<ContractVerifyResult>;
}

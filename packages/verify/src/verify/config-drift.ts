/**
 * On-chain configuration drift detection for @redeploy/verify.
 *
 * OVERVIEW
 * ========
 *
 * verifyConfig() reads the live on-chain state for each step in a ConfigSpec
 * and compares it to the declared expected value. It returns a per-step drift
 * report and an overall `clean` flag.
 *
 * GETTER RESOLUTION CONVENTION
 * =============================
 *
 * setX steps: Setters and getters do NOT share a name (e.g. "setFee" has no
 * automatic getter "fee"). The caller MUST supply a read descriptor for every
 * setX step in `options.reads`. Each descriptor specifies:
 *   - `function`: the getter function name to call on the target contract
 *   - `args`:     optional positional args to pass to the getter (ConfigArg[])
 *   - `expected`: the expected return value to compare against (ConfigArg)
 *
 * If a setX step has no read descriptor, verifyConfig() throws a
 * ConfigVerifyError with code "MISSING_GETTER_MAPPING" — it does NOT silently
 * skip the step or mark it "match". This prevents false drift-free reports.
 *
 * wire steps: The caller MUST supply a read descriptor for the wire step as
 * well (in `options.reads[stepId]`). The descriptor specifies the getter
 * function name on the `into` contract that returns the current wired address.
 * If no read descriptor is provided for a wire step, ConfigVerifyError with
 * code "MISSING_GETTER_MAPPING" is thrown.
 *
 * grantRole steps: Always verified by calling `hasRole(role, account)` on the
 * target contract. No read descriptor is required — this convention is built
 * in and documented here.
 *
 * VALUE NORMALIZATION RULES
 * =========================
 *
 * The following normalizations are applied before comparing expected vs actual:
 *
 * 1. Addresses: If both sides look like 0x-prefixed hex strings of 40+ chars,
 *    compare them case-insensitively (`.toLowerCase()`). This means checksummed
 *    addresses (EIP-55) are treated as equal to their lowercase equivalents.
 *
 * 2. Numerics: bigint, number, and hex/decimal numeric strings are treated as
 *    numerically equal when they represent the same integer. The comparison
 *    converts both sides to BigInt where possible. Supported inputs:
 *      - number literal: 500
 *      - bigint literal: 500n
 *      - decimal string: "500"
 *      - hex string: "0x1f4"
 *    Floating-point numbers are NOT supported for numeric normalization.
 *
 * 3. Booleans: strict boolean equality after the above normalizations fail
 *    to apply. A string "true"/"false" is NOT coerced to a boolean.
 *
 * 4. Strings: strict string equality (after address normalization check).
 *    Case-insensitive matching is ONLY applied when both sides look like
 *    Ethereum addresses (0x + 40 hex chars), not for arbitrary strings.
 *
 * 5. null: strict null equality.
 *
 * THROW vs. RETURN (mirrors verifyDeployment())
 * ==============================================
 *
 * Setup/usage errors → THROWN as ConfigVerifyError:
 *   - Unknown ref id (a contract id not in deployedAddresses) → UNKNOWN_REF
 *   - Missing getter mapping for a setX or wire step → MISSING_GETTER_MAPPING
 *   - Malformed spec (empty step id, missing required field) → MALFORMED_SPEC
 *
 * Per-step read failures (ChainReader.call throws/rejects) → NOT thrown.
 * They are returned as a step result with status "error" and the error message.
 * The overall report's `clean` is set to false.
 *
 * CHAIN READER INTERFACE
 * ======================
 *
 * ChainReader is a minimal injectable interface. Tests can mock it trivially
 * without a real chain connection.
 *
 * For grantRole steps, hasRole is modeled as a normal `call` with:
 *   function: "hasRole"
 *   args: [role, account]
 * returning a boolean. The ChainReader implementor is expected to handle
 * this pattern (e.g. by encoding the call appropriately and decoding
 * the bool return).
 */

import type { ConfigSpec, ConfigStep, ConfigArg } from "@redeploy/config";
import { ConfigVerifyError } from "./config-errors.js";

// ---------------------------------------------------------------------------
// ChainReader interface
// ---------------------------------------------------------------------------

/**
 * Minimal injectable interface for reading live on-chain state.
 *
 * Both `address` and `function` are required. `args` is optional.
 *
 * For grantRole verification, the caller should expect this interface to
 * handle calls of the form:
 *   { address: targetAddress, function: "hasRole", args: [role, account] }
 * returning a boolean.
 *
 * Tests can implement this with a simple mock:
 * ```ts
 * const reader: ChainReader = {
 *   call: async ({ address, function: fn, args }) => {
 *     if (fn === "hasRole") return true;
 *     if (fn === "getFee") return 500n;
 *     throw new Error(`Unexpected call: ${fn}`);
 *   },
 * };
 * ```
 */
export interface ChainReader {
  /**
   * Make a read call to a deployed contract.
   *
   * @param req.address  - The deployed contract address.
   * @param req.function - The function name to call (view/pure).
   * @param req.args     - Positional arguments to pass (optional).
   * @returns The raw return value. verifyConfig() applies normalization
   *          (address case, numeric coercion) before comparison.
   * @throws If the call fails (network error, revert, etc.).
   *         Thrown errors are caught by verifyConfig() and returned as
   *         per-step results with status "error".
   */
  call(req: {
    readonly address: string;
    readonly function: string;
    readonly args?: ReadonlyArray<unknown>;
  }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Read descriptor (caller-supplied getter mapping for setX and wire)
// ---------------------------------------------------------------------------

/**
 * A read descriptor tells verifyConfig() how to read back a value that was
 * written by a setX or wire step.
 *
 * For setX steps:
 *   - `function`: name of the getter to call on the target contract
 *   - `args`:     optional positional args to pass to the getter
 *   - `expected`: the value we expect the getter to return
 *
 * For wire steps:
 *   - `function`: name of the getter to call on the `into` contract
 *   - `args`:     optional (typically none for wire getters)
 *   - `expected`: NOT required — it is automatically set to the resolved
 *                 address of `step.source`. Any `expected` provided here
 *                 for a wire step is IGNORED.
 *
 * Example:
 * ```ts
 * reads: {
 *   "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } },
 *   "set-treasury": { function: "getTreasury", expected: { kind: "ref", contract: "treasury" } },
 *   "wire-token-into-vault": { function: "getToken" },
 * }
 * ```
 */
export interface ReadDescriptor {
  /** Getter function name to call on the target/into contract. */
  readonly function: string;
  /** Optional positional arguments for the getter call. */
  readonly args?: ConfigArg[];
  /**
   * Expected return value (for setX steps only).
   * For wire steps this field is ignored — the expected value is derived
   * from the resolved address of the step's `source` deployment id.
   */
  readonly expected?: ConfigArg;
}

// ---------------------------------------------------------------------------
// Per-step drift result
// ---------------------------------------------------------------------------

/**
 * The drift status for a single config step after on-chain verification.
 *
 * - "match" — the live on-chain value equals the declared expected value.
 * - "drift" — the live on-chain value differs from the declared expected value.
 * - "error" — the ChainReader.call threw an error; could not determine state.
 */
export type StepDriftStatus = "match" | "drift" | "error";

/**
 * The drift report for a single config step.
 */
export interface StepDriftResult {
  /** The step id. */
  readonly id: string;
  /** Drift status. */
  readonly status: StepDriftStatus;
  /** The expected value (resolved, as a plain JS value). */
  readonly expected: unknown;
  /** The actual on-chain value returned by ChainReader.call. */
  readonly actual: unknown;
  /**
   * Human-readable message. Present when status is "drift" or "error".
   * Describes what differed or what error was thrown.
   */
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Overall verifyConfig() result
// ---------------------------------------------------------------------------

/**
 * The overall result of a verifyConfig() call.
 *
 * `clean` is true iff every step has status "match".
 * Any "drift" or "error" step → `clean: false`.
 */
export interface ConfigVerifyResult {
  /**
   * True iff every step's status is "match".
   * False if any step is "drift" or "error".
   */
  readonly clean: boolean;
  /**
   * Per-step drift results, in the same order as the steps in the ConfigSpec.
   */
  readonly results: StepDriftResult[];
}

// ---------------------------------------------------------------------------
// Options for verifyConfig()
// ---------------------------------------------------------------------------

/**
 * Options for verifyConfig().
 *
 * @throws ConfigVerifyError("MISSING_GETTER_MAPPING") — for setX or wire steps
 *   with no entry in `reads`.
 * @throws ConfigVerifyError("UNKNOWN_REF") — for refs/ids not found in
 *   `deployedAddresses`.
 * @throws ConfigVerifyError("MALFORMED_SPEC") — for steps with an empty id or
 *   missing required fields.
 */
export interface VerifyConfigOptions {
  /**
   * The validated/expected ConfigSpec describing what was configured.
   * Must have at least one step. Steps must have non-empty `id` fields.
   */
  readonly spec: ConfigSpec;

  /**
   * Map of deployment id → deployed address (0x-prefixed).
   * Used to resolve RefArg and deployment id references (target, source,
   * into, account).
   */
  readonly deployedAddresses: Record<string, string>;

  /**
   * Injectable chain reader for reading live on-chain state.
   * Use a mock in tests to avoid real chain calls.
   */
  readonly reader: ChainReader;

  /**
   * Read descriptors for setX and wire steps, keyed by step id.
   *
   * - setX: required. Must include `function` and `expected`.
   * - wire: required. Must include `function`. The `expected` field is
   *   ignored — the expected value is the resolved address of `step.source`.
   * - grantRole: NOT required. hasRole() is always used.
   */
  readonly reads?: Record<string, ReadDescriptor>;
}

// ---------------------------------------------------------------------------
// Value normalization helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the value looks like an Ethereum address:
 * 0x-prefixed string of exactly 40 hex characters.
 */
function looksLikeAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * Try to convert a value to BigInt for numeric comparison.
 * Supports: bigint, integer number (no fractional part), decimal string,
 * 0x-prefixed hex string.
 * Returns null if conversion is not applicable.
 */
function tryToBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) return null;
    return BigInt(v);
  }
  if (typeof v === "string") {
    // Decimal string: digits only (possibly with leading sign)
    if (/^-?\d+$/.test(v)) {
      try {
        return BigInt(v);
      } catch {
        return null;
      }
    }
    // Hex string: 0x followed by hex digits
    if (/^0x[0-9a-fA-F]+$/.test(v)) {
      try {
        return BigInt(v);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Serialize a value to a human-readable string for use in error messages.
 * Handles BigInt by appending 'n', and falls back to JSON.stringify for
 * everything else. Avoids throwing for unserializable types.
 */
function safeSerialize(v: unknown): string {
  if (typeof v === "bigint") return `${v}n`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Compare two values with normalization for addresses and numerics.
 *
 * Rules (applied in order):
 * 1. If both sides look like Ethereum addresses, compare case-insensitively.
 * 2. If both sides can be parsed as BigInt (bigint, integer, decimal/hex string),
 *    compare numerically.
 * 3. Strict equality (===) for all other types.
 *
 * @param expected - The declared expected value.
 * @param actual   - The live on-chain value.
 * @returns true if the values are considered equal.
 */
export function valuesEqual(expected: unknown, actual: unknown): boolean {
  // 1. Address normalization: both look like addresses → compare lowercased
  if (looksLikeAddress(expected) && looksLikeAddress(actual)) {
    return expected.toLowerCase() === actual.toLowerCase();
  }

  // 2. Numeric normalization: both can be parsed as BigInt
  const expectedBig = tryToBigInt(expected);
  const actualBig = tryToBigInt(actual);
  if (expectedBig !== null && actualBig !== null) {
    return expectedBig === actualBig;
  }

  // 3. Strict equality fallback
  return expected === actual;
}

// ---------------------------------------------------------------------------
// Argument resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a ConfigArg to a plain JS value.
 * - RefArg → deployedAddresses[contract]
 * - LiteralArg → value
 * - ReadArg → NOT supported (throws UNSUPPORTED_ARG); see below.
 *
 * `ReadArg` (`{ kind: "read", contract, function, args? }`) derives its value
 * by calling a view/pure function on a deployed contract at execution time.
 * Config-drift verification (this module) only compares *declared* expected
 * values against live on-chain state read via `ChainReader`; it does not
 * execute an additional on-chain read to resolve a `ReadArg` into a concrete
 * value. Supporting this would require wiring a second on-chain call path
 * into verify, which is out of scope for this iteration. Callers that used a
 * `read` arg when producing/consuming a step must resolve it to a `literal`
 * (or `ref`) before passing the spec to verifyConfig().
 *
 * @throws ConfigVerifyError("UNKNOWN_REF") if the contract id is not in
 *   deployedAddresses.
 * @throws ConfigVerifyError("UNSUPPORTED_ARG") if `arg.kind === "read"`.
 */
function resolveArg(arg: ConfigArg, deployedAddresses: Record<string, string>, context: string): unknown {
  switch (arg.kind) {
    case "ref": {
      const address = deployedAddresses[arg.contract];
      if (address === undefined) {
        throw new ConfigVerifyError(
          "UNKNOWN_REF",
          `${context}: ref to unknown deployment id "${arg.contract}". ` +
            `Known ids: ${Object.keys(deployedAddresses).join(", ") || "(none)"}`,
        );
      }
      return address;
    }
    case "read":
      throw new ConfigVerifyError(
        "UNSUPPORTED_ARG",
        `${context}: 'read' args are not supported in config-drift verification yet (arg reads a value ` +
          `from a deployed contract). Use a literal or ref, or resolve the read value before verification.`,
      );
    case "literal":
      return arg.value;
    default: {
      const exhaustive: never = arg;
      throw new ConfigVerifyError(
        "MALFORMED_SPEC",
        `${context}: unknown ConfigArg kind: ${JSON.stringify((exhaustive as ConfigArg).kind)}`,
      );
    }
  }
}

/**
 * Resolve a deployment id string to an address.
 *
 * @throws ConfigVerifyError("UNKNOWN_REF") if the id is not in deployedAddresses.
 */
function resolveId(id: string, deployedAddresses: Record<string, string>, context: string): string {
  const address = deployedAddresses[id];
  if (address === undefined) {
    throw new ConfigVerifyError(
      "UNKNOWN_REF",
      `${context}: unknown deployment id "${id}". ` +
        `Known ids: ${Object.keys(deployedAddresses).join(", ") || "(none)"}`,
    );
  }
  return address;
}

/**
 * Resolve an array of ConfigArgs to plain values.
 */
function resolveArgs(
  args: ConfigArg[] | undefined,
  deployedAddresses: Record<string, string>,
  context: string,
): unknown[] {
  if (!args || args.length === 0) return [];
  return args.map((arg) => resolveArg(arg, deployedAddresses, context));
}

// ---------------------------------------------------------------------------
// Per-step verifiers
// ---------------------------------------------------------------------------

/**
 * Verify a single ConfigStep against the live chain state.
 * Returns a StepDriftResult; never throws (per-step errors are returned,
 * not re-thrown).
 *
 * Setup errors (UNKNOWN_REF, MISSING_GETTER_MAPPING) are propagated up
 * because they indicate a caller bug, not a chain error.
 */
async function verifyStep(
  step: ConfigStep,
  deployedAddresses: Record<string, string>,
  reader: ChainReader,
  reads: Record<string, ReadDescriptor> | undefined,
): Promise<StepDriftResult> {
  const ctx = `step "${step.id}"`;

  if (step.kind === "setX") {
    // Setup: require a read descriptor
    const descriptor = reads?.[step.id];
    if (!descriptor) {
      throw new ConfigVerifyError(
        "MISSING_GETTER_MAPPING",
        `${ctx}: setX step has no read descriptor in options.reads. ` +
          `Supply reads["${step.id}"] = { function: "<getter>", expected: <ConfigArg> }.`,
      );
    }
    if (!descriptor.expected) {
      throw new ConfigVerifyError(
        "MISSING_GETTER_MAPPING",
        `${ctx}: read descriptor for setX step is missing the "expected" field. ` +
          `Supply reads["${step.id}"].expected = <ConfigArg>.`,
      );
    }

    const targetAddress = resolveId(step.target, deployedAddresses, ctx);
    const getterArgs = resolveArgs(descriptor.args, deployedAddresses, ctx);
    const expectedValue = resolveArg(descriptor.expected, deployedAddresses, ctx);

    let actual: unknown;
    try {
      actual = await reader.call({
        address: targetAddress,
        function: descriptor.function,
        args: getterArgs,
      });
    } catch (err) {
      return {
        id: step.id,
        status: "error",
        expected: expectedValue,
        actual: undefined,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const match = valuesEqual(expectedValue, actual);
    return {
      id: step.id,
      status: match ? "match" : "drift",
      expected: expectedValue,
      actual,
      message: match
        ? undefined
        : `Expected ${safeSerialize(expectedValue)} but got ${safeSerialize(actual)}`,
    };
  }

  if (step.kind === "grantRole") {
    // grantRole: verify via hasRole(role, account) on target
    const targetAddress = resolveId(step.target, deployedAddresses, ctx);
    const accountValue = resolveArg(step.account, deployedAddresses, ctx);

    let actual: unknown;
    try {
      actual = await reader.call({
        address: targetAddress,
        function: "hasRole",
        args: [step.role, accountValue],
      });
    } catch (err) {
      return {
        id: step.id,
        status: "error",
        expected: true,
        actual: undefined,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const hasRole = actual === true;
    return {
      id: step.id,
      status: hasRole ? "match" : "drift",
      expected: true,
      actual,
      message: hasRole
        ? undefined
        : `Role "${step.role}" not granted to ${String(accountValue)}: hasRole returned ${safeSerialize(actual)}`,
    };
  }

  if (step.kind === "wire") {
    // Setup: require a read descriptor for the getter on `into`
    const descriptor = reads?.[step.id];
    if (!descriptor) {
      throw new ConfigVerifyError(
        "MISSING_GETTER_MAPPING",
        `${ctx}: wire step has no read descriptor in options.reads. ` +
          `Supply reads["${step.id}"] = { function: "<getter-on-into-contract>" }.`,
      );
    }

    const intoAddress = resolveId(step.into, deployedAddresses, ctx);
    const expectedAddress = resolveId(step.source, deployedAddresses, ctx);
    const getterArgs = resolveArgs(descriptor.args, deployedAddresses, ctx);

    let actual: unknown;
    try {
      actual = await reader.call({
        address: intoAddress,
        function: descriptor.function,
        args: getterArgs,
      });
    } catch (err) {
      return {
        id: step.id,
        status: "error",
        expected: expectedAddress,
        actual: undefined,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const match = valuesEqual(expectedAddress, actual);
    return {
      id: step.id,
      status: match ? "match" : "drift",
      expected: expectedAddress,
      actual,
      message: match
        ? undefined
        : `Expected wired address ${expectedAddress} but got ${safeSerialize(actual)}`,
    };
  }

  // TypeScript exhaustiveness: step.kind is never here
  const exhaustive: never = step;
  throw new ConfigVerifyError(
    "MALFORMED_SPEC",
    `Unknown step kind: ${JSON.stringify((exhaustive as ConfigStep).kind)}`,
  );
}

// ---------------------------------------------------------------------------
// Public API: verifyConfig()
// ---------------------------------------------------------------------------

/**
 * Verify on-chain configuration state against a declared ConfigSpec.
 *
 * For each step in the spec, reads the live value from the chain via the
 * injected ChainReader and compares it to the expected value. Returns a
 * per-step drift report and an overall `clean` flag.
 *
 * @param options - See VerifyConfigOptions.
 * @returns ConfigVerifyResult with per-step results and clean flag.
 *
 * @throws ConfigVerifyError("UNKNOWN_REF") if a ref contract id or target/
 *   source/into/account id is not in deployedAddresses.
 * @throws ConfigVerifyError("MISSING_GETTER_MAPPING") if a setX or wire step
 *   has no entry in `options.reads`.
 * @throws ConfigVerifyError("MALFORMED_SPEC") if any step has an empty id or
 *   missing required fields.
 *
 * Per-step ChainReader.call failures (network errors, reverts) are NOT thrown
 * — they appear in the results with status "error" and contribute to
 * clean: false.
 *
 * @example
 * ```ts
 * const result = await verifyConfig({
 *   spec,
 *   deployedAddresses: { feeController: "0x...", vault: "0x...", token: "0x..." },
 *   reader: myChainReader,
 *   reads: {
 *     "set-fee": { function: "getFee", expected: { kind: "literal", value: 500 } },
 *     "wire-token-into-vault": { function: "getToken" },
 *   },
 * });
 * if (!result.clean) {
 *   for (const r of result.results) {
 *     if (r.status !== "match") console.error(r.id, r.status, r.message);
 *   }
 * }
 * ```
 */
export async function verifyConfig(options: VerifyConfigOptions): Promise<ConfigVerifyResult> {
  const { spec, deployedAddresses, reader, reads } = options;

  // --- 1. Validate spec structure -----------------------------------------------

  if (!spec.steps || spec.steps.length === 0) {
    throw new ConfigVerifyError("MALFORMED_SPEC", "ConfigSpec has no steps. At least one step is required.");
  }

  for (const step of spec.steps) {
    if (!step.id || step.id.trim() === "") {
      throw new ConfigVerifyError("MALFORMED_SPEC", `A config step has an empty or missing id.`);
    }
  }

  // --- 2. Verify each step -------------------------------------------------------

  const results: StepDriftResult[] = [];

  for (const step of spec.steps) {
    // verifyStep throws for setup errors (UNKNOWN_REF, MISSING_GETTER_MAPPING)
    // and returns per-step results for chain read failures.
    const result = await verifyStep(step, deployedAddresses, reader, reads);
    results.push(result);
  }

  // --- 3. Compute overall clean flag ---------------------------------------------

  const clean = results.every((r) => r.status === "match");

  return { clean, results };
}

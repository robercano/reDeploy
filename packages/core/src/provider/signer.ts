/**
 * Pluggable signer seam for @redeploy/core's provider layer.
 *
 * DESIGN
 * ======
 * `jsonRpc.ts` originally derived a viem local account DIRECTLY from a raw
 * private key and used it to sign every transaction/message. Issue #154 asks
 * for an external-signer / Safe-proposal deploy path so production teams
 * don't need a raw `DEPLOYER_PRIVATE_KEY` at all.
 *
 * Rather than re-architecting `DeployOptions` (it already has an injection
 * seam — `provider: EIP1193Provider`, see deploy/deploy.ts), we generalize
 * ONE level down: `jsonRpc.ts`'s signing logic is parameterized over a
 * `Signer` interface instead of a raw private key. `jsonRpcProvider()` keeps
 * its exact existing signature/behavior (private-key -> local viem account)
 * as one `Signer` implementation (`privateKeySigner`); callers who want a
 * hardware wallet, remote KMS, or any other external signer implement this
 * SAME narrow interface and pass it to `signerProvider()` instead.
 *
 * `Signer` is intentionally a minimal structural subset of viem's account
 * `CustomSource` shape (address + the three signing methods jsonRpc.ts
 * actually calls) — NOT the full `LocalAccount`/`PrivateKeyAccount` type,
 * which carries local-key-only fields (`publicKey`, `source`, `type`) that an
 * external signer (e.g. a hardware wallet or a remote signing service) has no
 * reason to implement. Any viem local account (including the one
 * `privateKeyToAccount` returns) satisfies `Signer` structurally with no
 * adapter needed.
 */

import { privateKeyToAccount } from "viem/accounts";
import type {
  TransactionSerializableLegacy,
  TransactionSerializableEIP1559,
  TypedDataDomain,
  TypedDataParameter,
} from "viem";

/**
 * A pluggable transaction/message signer.
 *
 * Implementations MUST sign locally (or via whatever secure channel they
 * wrap — an HSM, a hardware wallet, a remote KMS) and MUST NEVER expose the
 * underlying key material through this interface.
 */
export interface Signer {
  /** The 0x-prefixed address this signer signs on behalf of. */
  readonly address: `0x${string}`;

  /** Sign a serializable transaction (legacy or EIP-1559) and return the raw signed tx hex. */
  signTransaction(
    transaction: TransactionSerializableLegacy | TransactionSerializableEIP1559,
  ): Promise<`0x${string}`>;

  /** Sign a raw message (as used by `personal_sign` / `eth_sign`). */
  signMessage(args: { message: { raw: `0x${string}` } }): Promise<`0x${string}`>;

  /** Sign EIP-712 typed data (as used by `eth_signTypedData_v3` / `_v4`). */
  signTypedData(args: {
    domain?: TypedDataDomain;
    types: Record<string, readonly TypedDataParameter[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Builds a `Signer` backed by a raw private key, signing LOCALLY via viem's
 * `privateKeyToAccount`. This is the exact same account construction
 * `jsonRpcProvider()` has always used — extracted here so it can also be
 * passed explicitly to `signerProvider()` (e.g. by callers who want to build
 * the signer once and reuse it across multiple providers/networks).
 *
 * SECURITY: the private key is consumed once to derive the account and is
 * NEVER stored on the returned object, logged, or included in error
 * messages — see jsonRpc.ts's module doc for the full security note (it
 * still applies unchanged; this function is a pure extraction).
 */
export function privateKeySigner(privateKey: string): Signer {
  return privateKeyToAccount(privateKey as `0x${string}`);
}

# @redeploy/core

Deployment engine on top of Hardhat Ignition: declarative deployment spec, dependency
resolution/ordering, idempotent journal-based resume.

See the repo-level `CLAUDE.md` for the overall project context. This README covers one
feature in depth: **upgradeable proxies**.

## Upgradeable proxies (UUPS / Transparent)

A `ContractEntry` can declare `upgradeable` to be deployed behind a proxy instead of
directly:

```ts
const spec: DeploymentSpec = {
  version: 1,
  contracts: [
    {
      id: "vault",
      contract: "Vault",
      args: [{ kind: "literal", value: "0x..." }],
      upgradeable: {
        kind: "uups",
        initializer: {
          function: "initialize",
          args: [{ kind: "literal", value: "0x..." }],
        },
      },
    },
  ],
};
```

`compileSpec()` (`src/compile/compile.ts`) has no built-in `m.proxy()` helper to lean on
(ignition-core 0.15.15 doesn't ship one), so it composes the standard OpenZeppelin proxy
pattern by hand from Ignition primitives:

1. `impl = m.contract(entry.contract, ctorArgs, { id: "<id>_impl" })` — the implementation.
2. `data = m.encodeFunctionCall(impl, initializer.function, initializerArgs)` (or `"0x"`
   if no `initializer` is declared).
3. The proxy itself:
   - **uups**: `m.contract("ERC1967Proxy", [impl, data], { id: "<id>_proxy" })`
   - **transparent**: `m.contract("TransparentUpgradeableProxy", [impl, proxyAdminOwner, data], { id: "<id>_proxy" })`
     — OZ v5's `TransparentUpgradeableProxy` deploys its own `ProxyAdmin` internally,
     owned by `proxyAdminOwner`.
4. `handle = m.contractAt(entry.contract, proxy, { id: entry.id })` — this is what gets
   stored under the entry's `id`.

**Refs always resolve to the proxy.** Any `{ kind: "ref", contract: "vault" }` elsewhere
in the spec — and `DeployResult.deployedAddresses["vault"]` — resolves to the PROXY's
address, exposed with the IMPLEMENTATION's ABI. That's the entire point of a proxy:
callers always talk to the one stable address, across every future upgrade.

### uups vs. transparent

| | `kind: "uups"` | `kind: "transparent"` |
|---|---|---|
| Proxy artifact | `ERC1967Proxy` | `TransparentUpgradeableProxy` |
| Who can upgrade | The implementation itself (must inherit OZ's `UUPSUpgradeable` and implement `_authorizeUpgrade`) | A separate `ProxyAdmin` contract, deployed internally by the proxy |
| `proxyAdminOwner` | Not used — rejected by `validateSpec` (`UNUSED_PROXY_ADMIN_OWNER`) if set | **Required** — rejected by `validateSpec` (`MISSING_PROXY_ADMIN_OWNER`) if absent |

The proxy artifact names are overridable per-project via
`CompileOptions.proxyArtifacts` (`{ uups?: string; transparent?: string }`), for
projects that vendor OpenZeppelin under different artifact names. Both artifacts must be
compiled/available to the `ArtifactResolver` passed to `deploy()` — they ship as part of
`openzeppelin-contracts` v5; reDeploy does not vendor OZ's Solidity sources itself.

### Initializer

The optional `initializer` runs atomically with proxy deployment, via `delegatecall`
through the proxy — so it initializes PROXY storage, not the implementation's. This is
typically an OZ `Initializable` contract's `initialize(...)` function. `function` must be
a plain Solidity identifier (`validateSpec`'s `INVALID_IDENTIFIER` rejects anything else
— it flows directly into on-chain calldata), and `args` go through the exact same
validated ref/literal/param/expr/resolver arg-mapping as constructor `args`.

### Proxy-admin ownership (security)

For `kind: "transparent"`, `proxyAdminOwner` is the INITIAL owner of the proxy's
`ProxyAdmin` — only that address may later call `ProxyAdmin.upgradeAndCall`. There is
**no fallback default** (no `address(0)`, no implicit deployer account): an unset
proxy-admin owner is an access-control footgun, not a convenience default, so
`validateSpec` rejects it outright (`MISSING_PROXY_ADMIN_OWNER`).

### Upgrading

`compile/compile.ts` also exports `compileUpgrade()`, a standalone compiler for an
explicit upgrade step: it deploys a NEW implementation (under a caller-supplied,
fresh future `id` — reusing the original `<id>_impl` id would be replayed from
Ignition's journal and skipped, since the journal keys by future id, not bytecode) and
calls the appropriate on-chain upgrade function — `upgradeToAndCall` directly on the
proxy for `"uups"`, or `ProxyAdmin.upgradeAndCall` for `"transparent"` (which requires
the caller to supply the `ProxyAdmin`'s address explicitly — this library does not
compute or guess it). See `compileUpgrade`'s doc comment for the full API.

`src/deploy/proxyHistory.ts` provides a typed data model —
`ProxyImplementationHistory` / `ProxyImplementationRecord` — plus pure helpers
(`deriveProxyHistoriesFromSpec`, `appendProxyImplementationRecord`) for tracking which
implementation a proxy currently points at and its upgrade history. This is a v1,
core-only data model: it is **not** wired into `@redeploy/reader` yet — that is
follow-up work built on this stable shape.

### Storage-layout safety is OUT OF SCOPE (v1)

reDeploy does **not** validate that a new implementation's storage layout is compatible
with the previous one — deploying an incompatible implementation will corrupt proxy
storage. Run your own storage-layout check before upgrading, e.g. the
[`@openzeppelin/upgrades-core`](https://github.com/OpenZeppelin/openzeppelin-upgrades)
/ `hardhat-upgrades` plugin's validator, or `forge inspect --pretty storage-layout`.

## Signers and propose mode (issue #154)

Production teams generally don't want a raw `DEPLOYER_PRIVATE_KEY` sitting in an
environment variable — they sign through a hardware wallet, a remote KMS, or (most
commonly) a Safe multisig. This section covers both pieces: the pluggable signer seam,
and "propose mode" — collecting a transaction batch instead of broadcasting it.

### Pluggable signers

`jsonRpc.ts`'s signing step is factored into a narrow `Signer` interface
(`provider/signer.ts`):

```ts
export interface Signer {
  readonly address: `0x${string}`;
  signTransaction(tx): Promise<`0x${string}`>;
  signMessage(args: { message: { raw: `0x${string}` } }): Promise<`0x${string}`>;
  signTypedData(args): Promise<`0x${string}`>;
}
```

`jsonRpcProvider({ rpcUrl, privateKey })` is **unchanged** — same signature, same
behavior — it just derives a `Signer` internally via `privateKeySigner(privateKey)` and
delegates to the new, more general `signerProvider({ rpcUrl, signer })`. To wire up an
external signer (hardware wallet, remote KMS, etc.), implement `Signer` yourself and call
`signerProvider()` directly:

```ts
import { signerProvider, deploy } from "@redeploy/core";

const provider = signerProvider({
  rpcUrl: process.env.RPC_URL!,
  signer: myHardwareWalletSigner, // implements Signer
});

await deploy({ spec, provider, accounts: [myHardwareWalletSigner.address], ... });
```

This follows the same injection pattern `DeployOptions` already uses for
`provider`/`accounts`/`defaultSender` — no new options were added to `DeployOptions`
itself; the signer seam lives one level down, in how you construct the `provider` you
pass in.

### Propose mode: collecting a batch instead of broadcasting

`proposeDeploy()` runs the exact same validate → resolve → compile pipeline as
`deploy()`, but instead of broadcasting transactions it returns the ordered batch
Ignition *would* have sent:

```ts
import { proposeDeploy, buildSafeBatch } from "@redeploy/core";

const { transactions } = await proposeDeploy({
  spec, provider, accounts, artifactResolver,
  deploymentDir, // OPTIONAL — see "resuming" below
});

const safeBatch = buildSafeBatch(transactions, { chainId: 1, name: "My deploy" });
// -> write safeBatch to a .json file and import it in the Safe Transaction Builder UI
```

`transactions` is `{ to, data, value }[]`, in send order. `buildSafeBatch()` converts
that into the Safe Transaction Builder's batch JSON schema (`version`, `chainId`,
`createdAt`, `meta`, `transactions[]`).

**Why this reuses Ignition's real engine instead of a hand-rolled planner:** unlike
`simulate()` (chain-free, no real addresses/calldata), `proposeDeploy()` runs Ignition's
actual `deploy()` against an in-memory `collectingProvider` (`propose/collectingProvider.ts`)
that intercepts `eth_sendTransaction` and never broadcasts. Everything downstream —
constructor-arg encoding, dependency batching, proxy expansion, CREATE address
prediction — is therefore identical to what a real `deploy()` run would produce, with
zero duplicated logic.

#### The journal invariant

**A transaction that is only proposed — never signed and broadcast — must never be
recorded as complete in your real, resumable journal.** `proposeDeploy()` guarantees
this structurally, not by convention: it never passes your real `deploymentDir` to
Ignition. Either:

- **Fresh proposal** (no `deploymentDir` given): Ignition runs against a throwaway temp
  directory, deleted when `proposeDeploy()` returns. No journal is ever created at any
  path you can see.
- **Resuming** (`deploymentDir` given, pointing at a real, partially-complete
  deployment): its `journal.jsonl` is **copied** (read-only on the original) into the
  same throwaway temp directory. Ignition sees the real resume state — it skips
  already-COMPLETE futures exactly like a normal resume — and only *collects*
  transactions for futures that are NOT yet complete. The copy (and anything Ignition
  appends to it during this run) is deleted at the end. Your real `deploymentDir` is
  opened at most once, for a read, and never for a write.

See `test/propose.test.ts`'s "journal invariant" suite for the executable proof
(byte-for-byte comparison of the real `journal.jsonl` before/after a `proposeDeploy()`
call against a partially-deployed spec).

#### The confirm-then-resume operator flow

1. **Propose**: `proposeDeploy({ ..., deploymentDir })` → `buildSafeBatch()` → write the
   JSON, import it into the Safe Transaction Builder UI (or feed `transactions` to
   whatever external-signer tooling you use).
2. **Execute**: the Safe's signers (or the external signer, one transaction at a time)
   actually sign and execute the batch on-chain.
3. **Resume**: re-run a **normal** `deploy()` against the same `deploymentDir`, using a
   `provider`/`accounts` combination that reflects who actually sent the transactions.

Step 3 is deliberately where this feature's scope ends. `deploy()`'s idempotent
journal-replay only recognizes a future as complete when it observes the matching
on-chain result through Ignition's own execution engine — bridging "the Safe executed
batch X" back into Ignition's journal format automatically (so a plain resume also works
when the **Safe itself**, not an EOA/signer Ignition's engine already tracks, was the
sender) is **not implemented here**. It is a real, documented follow-up seam — most
likely a small journal-reconciliation tool that reads the Safe's executed-transaction
history and imports the resulting addresses, rather than anything `propose/propose.ts`
itself should own.

#### Safe Transaction Service API — not implemented (documented seam)

Issue #154 allows, but doesn't require, actually *submitting* the proposal via Safe's
Transaction Service API rather than stopping at the batch JSON. That endpoint needs an
EIP-712 signature from a real Safe owner and a live (or heavily-mocked) HTTP round-trip —
properly unit-testing it without a network dependency means modeling Safe's API contract
in real detail, which didn't fit this change's scope ("only if it comes cheap and is
fully unit-testable without network" — it isn't, here). `buildSafeBatch()`'s output is
the seam: a thin HTTP client can be layered on top of it in a follow-up.

#### Contract-creation steps and Safe batches (documented limitation)

A `ProposedTransaction` with `to: null` is a raw contract-CREATION transaction —
Ignition's basic deploy strategy has no factory, so it sends a plain CREATE. Safe has no
representation for this: a Safe transaction is always a `CALL`/`DELEGATECALL` to an
explicit `to` address; a Safe cannot originate a raw `CREATE`. `buildSafeBatch()` throws
`SafeBatchError("UNSUPPORTED_CREATION", ...)` if the batch contains any such entry,
rather than silently emitting a batch Safe's own tooling would reject.

Config/call-only batches (post-deployment configuration — every transaction already has
a real `to`) are fully supported today. Real Safe-based **deployment** of new contracts
requires routing creation through a deterministic factory (e.g. the widely-used CREATE2
proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956`), turning the step into an ordinary
call. Wiring that up — an alternate Ignition strategy, or a compile-time rewrite of
creation futures into factory calls — is explicitly out of scope for this change.

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

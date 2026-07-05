# @redeploy/core — Anvil e2e tests

These tests exercise `deploy()` against a **real, local Anvil chain** — not a
mocked EIP-1193 provider — to prove the idempotent-resume guarantee described
in `src/deploy/deploy.ts` holds against real JSON-RPC semantics, real
transaction receipts, and real on-chain bytecode.

## Dependency

These tests require the [`anvil`](https://book.getfoundry.sh/reference/anvil/)
binary (part of [Foundry](https://getfoundry.sh)) to be on `PATH` (or pointed
to via the `ANVIL_BIN` environment variable). They also require the fixture
contracts under `contracts/` to be built:

```sh
forge build --root contracts
```

If `anvil` is not found, or the fixtures are not built, every e2e suite is
`describe.skip`ped with a clear console warning — the suite is never silently
treated as passing; a skip is visible in the test report.

## Running

```sh
# from the repo root
pnpm -F @redeploy/core test:e2e

# or from packages/core
pnpm test:e2e
```

The default `pnpm -F @redeploy/core test` (fast, network-free unit suite)
does **not** run these tests — they are excluded via `vitest.config.ts` and
only picked up by the dedicated `vitest.e2e.config.ts` used by `test:e2e`.

## What's covered

- `real-deploy.e2e.test.ts` — deploys a linked multi-contract spec (Vault refs
  Token; VaultERC4626 refs Token + PriceOracle), asserts
  `deployed_addresses.json` is written, every contract has on-chain bytecode,
  and the ref-wired values read back correctly via `eth_call`.
- `resume-idempotent.e2e.test.ts` — interrupts a deployment mid-way (a wrapped
  real provider throws on the second `eth_estimateGas` call) and resumes
  against the same `deploymentDir`, asserting the already-deployed contract's
  address is unchanged and the journal shows no new activity for it.
- `resume-spec-change.e2e.test.ts` — deploys a complete spec, then re-runs
  with one new contract added, asserting only the new contract is deployed and
  every pre-existing address/journal entry is untouched.

## Harness

`anvilHarness.ts` spawns a fresh `anvil` process on a randomized port (never
the fixed `8545`, to avoid collisions with other instances) for each test
file, polls `eth_chainId` until it is ready, and exposes Anvil's deterministic
dev accounts (read back via `anvil --config-out`, not hardcoded) plus a
`stop()` that reliably kills the process and cleans up its temp directory.

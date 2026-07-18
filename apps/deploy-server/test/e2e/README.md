# @redeploy/deploy-server — Anvil e2e tests

These tests exercise the real HTTP server (`createServer()` from `../../src/server.ts`)
against **real, local Anvil chains** — not the mocked `@redeploy/core` /
`@redeploy/reader` modules used by `test/deploy.test.ts` — to prove the
multi-network wiring (issue #139) actually deploys, resumes, and applies
per-network `deploymentParameters` precedence against real JSON-RPC
semantics, real transaction receipts, and real on-chain bytecode.

## Dependency

These tests require the [`anvil`](https://book.getfoundry.sh/reference/anvil/)
binary (part of [Foundry](https://getfoundry.sh)) to be on `PATH` (or pointed
to via the `ANVIL_BIN` environment variable). They also require the fixture
contracts under `contracts/` to be built:

```sh
forge build --root contracts
```

If `anvil` is not found, or the fixtures are not built, every e2e suite is
`describe.skipIf`ped with a clear console warning — the suite is never
silently treated as passing; a skip is visible in the test report.

## Running

```sh
# from the repo root
pnpm -F @redeploy/deploy-server test:e2e

# or from apps/deploy-server
pnpm test:e2e
```

The default `pnpm -F @redeploy/deploy-server test` (fast, network-free suite)
does **not** run these tests — they are excluded via `vitest.config.ts` and
only picked up by the dedicated `vitest.e2e.config.ts` used by `test:e2e`.

## What's covered

- `multi-network.e2e.test.ts` — starts TWO independent Anvil chains and
  configures a `NETWORKS_CONFIG` with two networks ("alpha"/"beta"), each
  pointing at a different chain and carrying a different server-side
  `deploymentParameters.admin` override. It POSTs the SAME `DeploymentSpec`
  (whose `spec.parameters.admin` simulates a studio-baked `networkOverrides`
  default) to `/api/deploy?network=alpha` and `?network=beta`, and proves:
  - the server's per-network `deploymentParameters` WIN over the client-baked
    `spec.parameters` default (read back on-chain via `hasRole`), for both
    networks independently;
  - both deploys land on their own, independent chain (real bytecode on each);
  - both networks' journals are non-empty and distinct;
  - re-POSTing to a previously-deployed network RESUMES (same address)
    without touching the other network's journal or chain.

## Harness

`anvilHarness.ts` spawns a fresh `anvil` process on a randomized port (never
the fixed `8545`, to avoid collisions with other instances — this suite
starts two at once) for each test file, polls `eth_chainId` until ready, and
exposes Anvil's deterministic dev accounts (read back via `anvil --config-out`,
not hardcoded) plus a `stop()` that reliably kills the process and cleans up
its temp directory. This is a deliberate copy of
`packages/core/test/e2e/anvilHarness.ts`'s logic (test code cannot import
across package `test/` directories).

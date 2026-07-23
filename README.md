# reDeploy `^^`

> **Declarative, idempotent, verifiable smart-contract deployments** — built on
> [Hardhat Ignition](https://hardhat.org/ignition). One spec. One graph. One truth.
>
> **Website:** [redeploy.thesolidchain.com](https://redeploy.thesolidchain.com) · a product of **The Solid Chain**

reDeploy lets you declaratively define contract deployments (constructor args, inter-contract links,
ordering), deploy them **idempotently and resumably** — a contract already deployed is never re-deployed, and
an interrupted run picks up exactly where it stopped — apply **resumable post-deployment configuration**,
**verify** both source and on-chain configuration, and **read** deployment state back through a typed API.
A **visual studio** (drag-and-drop) authors the connection/config graph and inspects live deployments.
reDeploy reuses Hardhat Ignition's module engine, journal, and resume semantics wherever possible rather than
reinventing them.

Built for smart-contract teams deploying multi-contract systems across chains who need reproducible,
resumable, verifiable deployments — and a visual way to wire and inspect them.

## Highlights

- **Declarative spec** — contracts, args, `ref`s between them, and explicit ordering in one JSON document.
  Args can be literals, per-network **params**, safe **expressions** (`keccak256`, CREATE2 addresses,
  arithmetic), async **resolvers**, or values **read live** from already-deployed contracts.
- **Idempotent & resumable** — the Ignition journal is the source of truth. Re-running a deploy skips what's
  on-chain, creates only what's missing, and resumes interrupted runs. Safe to run in CI.
- **Post-deploy configuration** — roles, wiring, setters declared as steps (`set` / `grantRole` / `wire`),
  applied like migrations: journaled, resumable, re-runnable.
- **Two-layer verification** — source on Etherscan & Sourcify, plus on-chain assertion that the *live
  configuration* still matches the declared spec. Drift is a diff, not an incident.
- **Multi-network** — one spec, many networks: per-network parameters, per-network journals, network
  selection end-to-end from studio to server.
- **Visual studio** — drag-and-drop authoring over the same engine: simulate the plan, deploy for real,
  inspect any live deployment. Emits the same spec files you'd write by hand.

## Quick start

```sh
git clone https://github.com/robercano/reDeploy && cd reDeploy
pnpm install
cp .env.example .env        # fill in what you need; never commit .env

# terminal 1 — a local chain
anvil

# terminal 2 — the deploy server
pnpm --filter @redeploy/deploy-server dev

# terminal 3 — the studio (proxies /api to the deploy server)
pnpm --filter @redeploy/studio dev    # → http://localhost:5173
```

Prefer the terminal? The `redeploy` CLI wraps the same libraries:

```sh
redeploy simulate --spec protocol.spec.json     # plan only, nothing on-chain
redeploy deploy   --spec protocol.spec.json     # idempotent, resumable
redeploy apply-config --spec protocol.spec.json # post-deploy steps
redeploy verify --source --config               # both verification layers
redeploy status                                 # read the journal back
```

Full local walkthrough (Anvil, `.env`, SSE endpoints, real deploy):
**[`docs/RUNBOOK-anvil-deploy.md`](docs/RUNBOOK-anvil-deploy.md)**.

## Packages & apps

| Module | Package | What it does |
| --- | --- | --- |
| `packages/core` | `@redeploy/core` | Deployment engine over Ignition — declarative spec, dependency resolution/ordering, idempotent journal-based resume, plan-only simulate. |
| `packages/config` | `@redeploy/config` | Post-deployment configuration — declarative steps, resumable partial configuration, args read live from deployed contracts. |
| `packages/verify` | `@redeploy/verify` | Source/bytecode verification (Etherscan/Sourcify) + on-chain assertion that live configuration matches the declared spec. |
| `packages/reader` | `@redeploy/reader` | Read-only typed API over deployment + config state — snapshots and per-network address-book export for external systems. |
| `apps/cli` | `@redeploy/cli` | The `redeploy` command — deploy/simulate/apply-config/verify/status/snapshot over the libraries. |
| `apps/studio` | `@redeploy/studio` | Visual tool (React + React Flow) for drag-and-drop authoring of connections/config (emits spec files) and a deployment inspector. |
| `apps/deploy-server` | `@redeploy/deploy-server` | Minimal `node:http` server exposing simulate (plan-only), real deploy, deployment state, and network discovery to the studio and other clients. |
| `apps/website` | `@redeploy/website` | The public one-page site served at redeploy.thesolidchain.com. |
| `contracts/` | — | Foundry project: sample interconnected Solidity contracts used as deployment fixtures. |

## Deploy server

`apps/deploy-server` is a minimal `node:http` server (no framework) listening on `127.0.0.1:8787` by default
(`PORT` / `HOST` env overrides; `HOST` stays loopback unless explicitly overridden). It loads a repo-root
`.env` on startup — real `process.env` values take precedence.

- **`GET /health`** → `{ "status": "ok" }`.
- **`GET /api/deployment`** → read-only `DeploymentView` (`{ contracts, configSteps, warnings }`) built from
  the on-disk Ignition journal. The deployment directory is resolved **strictly from server env** — never from
  client input — as a deliberate boundary against path traversal.
- **`GET /api/networks`** → the configured network registry for multi-network deploys.
- **`POST /api/simulate`** → plan-only, no chain writes. SSE stream: `step` frames, then a terminal `done`.
- **`POST /api/deploy`** → a **real** deploy that broadcasts on-chain. SSE stream: `progress`, then a
  terminal `done` with the resulting `DeploymentView`. Secrets are never echoed in responses or logs.

Environment variables for the deploy path: `RPC_URL` (defaults to Anvil's `http://127.0.0.1:8545`),
`FOUNDRY_OUT` (defaults to `contracts/out`), `DEPLOYER_PRIVATE_KEY` (required for real deploys — use a
throwaway key locally, a keystore/hardware wallet for anything real), `DEPLOYMENT_DIR` (journal + snapshot
location). See [`.env.example`](.env.example).

## Studio deploy flow

The studio (`:5173`) proxies `/api` to the deploy server (`:8787`, override `VITE_DEPLOY_SERVER_URL`); both
dev servers must run for the deploy flow. Toolbar: **Deploy (simulate)** for a plan-only preview,
**Plan** for a local create/skip/change diff, **Deploy (real)** for a confirmed on-chain broadcast — results
render in the read-only Inspector (React Flow canvas with addresses, args, and config-step status).

## Contributing & the orchestrator harness

This repo is developed with an orchestrated multi-agent Claude Code setup — a lead orchestrator scoping work
to worktree-isolated implementers, gated by adversarial reviewers and CI. If you're contributing (or adapting
the `.claude/` harness for your own project):

- **[`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md)** — harness setup, step by step.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the orchestrator/implementer/reviewer mental model.
- **[`docs/USAGE.md`](docs/USAGE.md)** — how to drive the orchestrator day to day.

Gates for every module (build · lint · typecheck · test · coverage ≥ 80%) run locally via
`.claude/scripts/gate.sh` and in CI on every PR.

## License

[MIT](LICENSE) © 2026 Roberto Cano · The Solid Chain

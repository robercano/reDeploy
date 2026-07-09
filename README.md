# reDeploy

reDeploy is a **deployment system built on top of Hardhat Ignition**. It lets you declaratively define
contract deployments (constructor args, inter-contract links, ordering), deploy them **idempotently and
resumably** (a contract already deployed is never re-deployed), apply **resumable post-deployment
configuration**, **verify** both source and on-chain configuration, and **read** existing deployment state from
external systems. A **visual studio** (drag-and-drop) authors the connection/config graph and inspects live
deployments. reDeploy reuses Hardhat Ignition's module engine, journal, and resume semantics wherever possible
rather than reinventing them.

Built for smart-contract teams deploying multi-contract systems across chains who need reproducible, resumable,
verifiable deployments and a visual way to wire and inspect them.

## Packages & apps
- **`packages/core`** — `@redeploy/core`: deployment engine over Ignition — declarative spec, dependency
  resolution/ordering, idempotent journal-based resume, plan-only simulate.
- **`packages/config`** — `@redeploy/config`: post-deployment configuration — declarative steps, resumable
  partial configuration, config-state idempotency.
- **`packages/verify`** — `@redeploy/verify`: source/bytecode verification (Etherscan/Sourcify) + on-chain
  assertion that live configuration matches the declared spec.
- **`packages/reader`** — `@redeploy/reader`: read-only library exposing deployment + config state via a typed
  API to external systems.
- **`apps/studio`** — `@redeploy/studio`: visual tool (React + React Flow) for drag-and-drop authoring of
  connections/config (emits spec files) and a deployment inspector.
- **`apps/deploy-server`** — `@redeploy/deploy-server`: HTTP server (node:http, no framework) exposing
  deployment **simulate** (plan-only) and **real deploy** over `@redeploy/core` (+ `@redeploy/reader`),
  consumed by the studio.
- **`contracts/`** — Foundry project: sample interconnected Solidity contracts used as deployment fixtures.

## Deploy server
`apps/deploy-server` is a minimal `node:http` server (no framework) that exposes deployment simulation and
execution as an HTTP API for the studio (and any other client). It listens on `127.0.0.1:8787` by default
(override with the `PORT` / `HOST` env vars; `HOST` stays loopback unless explicitly overridden). It loads a
repo-root `.env` on startup — real `process.env` values always take precedence over the file.

Endpoints:
- **`GET /health`** → `{ "status": "ok" }`.
- **`GET /api/deployment`** → read-only JSON `DeploymentView` (`{ contracts, configSteps, warnings }`), built
  from the on-disk Ignition journal. Returns the empty view (`{contracts:[],configSteps:[],warnings:[]}`) for a
  never-deployed directory, or `500 { "error": "Failed to read deployment state" }` on other read failures. The
  deployment directory is resolved **strictly from server env** — never from client input — as a deliberate
  security boundary against path traversal.
- **`POST /api/simulate`** — plan-only, no chain writes. Body is a `DeploymentSpec` JSON document. Response is
  `Content-Type: text/event-stream` (SSE): zero or more `event: step` frames (one per planned step, each
  augmented with `address: null`), followed by a terminal `event: done` frame — `{success:true}` on success, or
  `{success:false, errors:[...]}` on failure.
- **`POST /api/deploy`** — a **real** deploy that broadcasts transactions on-chain. Body is a `DeploymentSpec`
  JSON document. Response is SSE: an `event: progress` frame (`{phase:"deploying"}`), then a terminal
  `event: done` frame — `{success:true, deployment: DeploymentView | null, warning?}` on success, or
  `{success:false, errors:[{code?, message}]}` on failure.

Environment variables read by the deploy path (values are never echoed in responses or logs):
- `RPC_URL` — JSON-RPC endpoint. Defaults to `http://127.0.0.1:8545` (Anvil's default).
- `FOUNDRY_OUT` — Foundry artifacts directory. Defaults to `<repo>/contracts/out`.
- `DEPLOYER_PRIVATE_KEY` — required for real deploys (`POST /api/deploy`); accepted with or without a `0x`
  prefix. Missing → a terminal `done{success:false}` SSE error, not a crash.
- `DEPLOYMENT_DIR` — where the Ignition journal is persisted. Defaults to an OS-temp directory
  (`redeploy-deployments/default`). Successful real deploys also persist a snapshot under
  `<DEPLOYMENT_DIR>/snapshots/<takenAt>.json`.

## Studio deploy flow
The studio (`apps/studio`, Vite dev server on `:5173`) proxies `/api` requests to the deploy-server at
`http://127.0.0.1:8787` (override via `VITE_DEPLOY_SERVER_URL`). **Both dev servers must be running** for the
studio's deploy flow to work.

Toolbar actions:
- **`Deploy (simulate)`** — POSTs the current spec to `/api/simulate` for a plan-only preview (shows
  `Simulating…` while in flight). No chain writes.
- **`Plan`** — a local, synchronous dry-run diff (create/skip/change) against the last known deployment state;
  no network call.
- **`Deploy (real)`** — opens a confirmation modal (red/danger styling, since it's irreversible) and, once
  confirmed, POSTs to `/api/deploy` to broadcast on-chain (shows `Deploying…` while in flight).

The read-only **Inspector** renders the resulting `DeploymentView` as a React Flow canvas: each contract node
shows its Deploy ID, contract name, deployed address (blue monospace) or "(not deployed)", and constructor
args; a right-side panel lists config steps with completed/pending badges; a context badge reads
"Real deployment (broadcast on-chain)" or "Simulated plan (dry run)" depending on the source of the view.

For the full step-by-step local walkthrough against Anvil (start Anvil, configure `.env`, run both dev
servers, deploy, and curl the SSE endpoints directly), see
**[`docs/RUNBOOK-anvil-deploy.md`](docs/RUNBOOK-anvil-deploy.md)**.

## Contributor tooling (orchestrator harness)
This repo is developed using an orchestrated multi-agent Claude Code setup (a lead orchestrator that scopes
work to worktree-isolated implementers, gated by adversarial reviewers). If you're contributing to reDeploy (or
adapting its `.claude/` harness for another project), see:
- **[`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md)** — harness setup, step by step.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the orchestrator/implementer/reviewer mental model.
- **[`docs/USAGE.md`](docs/USAGE.md)** — how to drive the orchestrator day to day.

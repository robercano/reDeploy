# reDeploy

> Project-WIDE context only. Task-specific detail belongs in the ticket/prompt, not here.

## What this project is
reDeploy is a **deployment system built on top of Hardhat Ignition**. It lets you declaratively define
contract deployments (constructor args, inter-contract links, ordering), deploy them **idempotently and
resumably** (a contract already deployed is never re-deployed), apply **resumable post-deployment
configuration**, **verify** both source and on-chain configuration, and **read** existing deployment state from
external systems. A **visual studio** (drag-and-drop) authors the connection/config graph and inspects live
deployments. We reuse Hardhat Ignition's module engine, journal, and resume semantics wherever possible rather
than reinventing them.

Users: smart-contract teams deploying multi-contract systems across chains who need reproducible, resumable,
verifiable deployments and a visual way to wire and inspect them.

## Stack & layout
- Language / runtime: TypeScript (Node ≥ 20, ESM/NodeNext) + Solidity 0.8.28.
- Package manager: **pnpm** workspaces (`pnpm@10.33`). Tests: **vitest** (TS), **forge** (Solidity).
- Deployment engine: **Hardhat Ignition** (the system wraps/extends it).
- Key directories (mirror `.claude/gates.json` → `modules`):
  - `packages/core/` — `@redeploy/core`: deployment engine over Ignition — declarative spec, dependency
    resolution/ordering, idempotent journal-based resume.
  - `packages/config/` — `@redeploy/config`: post-deployment configuration — declarative steps, resumable
    partial configuration, config-state idempotency.
  - `packages/verify/` — `@redeploy/verify`: source/bytecode verification (Etherscan/Sourcify) + on-chain
    assertion that live configuration matches the declared spec.
  - `packages/reader/` — `@redeploy/reader`: read-only library exposing deployment + config state via a typed
    API to external systems.
  - `apps/studio/` — `@redeploy/studio`: visual tool (React + React Flow, added by its ticket) for drag-and-drop
    authoring of connections/config (emits spec files) and a deployment inspector.
  - `contracts/` — Foundry project: sample interconnected Solidity contracts used as deployment fixtures.

## Conventions
- Code style: TypeScript strict mode (see `tsconfig.base.json`); ESM imports use explicit `.js` extensions
  (NodeNext). Solidity formatted by `forge fmt` (config in `contracts/foundry.toml`).
- Module independence: each `packages/*` / `apps/*` is self-contained (own `package.json`, `tsconfig.json`,
  build/test scripts) so worktree-isolated workers build and test their module in isolation.
- Testing: vitest specs live in each package's `test/` dir; Solidity tests are `*.t.sol` under `contracts/test/`.
  Write/extend tests alongside every change.
- Dependency direction: `core` is the base; `config` and `reader` build on `core`; `verify` and `studio` build
  on those. Don't introduce cycles.
- Definition of done: builds, typechecks, lints, tests pass, and coverage ≥ `coverage_threshold` (80) for the
  touched module; required review lenses approve.

## Multi-agent orchestration
This repo is driven by the orchestrated multi-agent setup in `.claude/`. See `docs/USAGE.md`.
- **Agents:** `.claude/agents/` — orchestrator, implementer (worktree-isolated), reviewer, test-runner.
- **Adapter:** `.claude/gates.json` — module map, gate commands, model routing. **Keep this current.**
- **Gates run via** `.claude/scripts/gate.sh <name>` and the hooks in `.claude/settings.json`.
- **Workflow:** `.claude/workflows/feature-fanout.js` for deterministic fan-out.
- **Tickets:** tracked as **GitHub Issues** in `robercano/reDeploy`, labeled by module. Drive one issue at a
  time through the orchestrator.

### Module boundaries (hard rule)
A worker assigned to a module MUST NOT edit files outside that module's `path`. Cross-module work is re-scoped
by the orchestrator, never reached across by a worker. Shared root config (`package.json`,
`pnpm-workspace.yaml`, `tsconfig.base.json`) changes only via an explicit infra/bootstrap task.

### Merge policy
`pr-per-agent` — base branch `main`. (Mirrored in `gates.json` → `merge`.)

## Don'ts
- Don't put secrets (RPC keys, private keys, Etherscan keys) in the repo — use `.env` (gitignored);
  commit `.env.example`.
- Don't bypass the gates.
- Don't reinvent what Hardhat Ignition already provides (module engine, journal, resume) — wrap/extend it.
- Don't commit Foundry `out/`/`cache/` or build `dist/` — but deployment journals ARE intentionally tracked.

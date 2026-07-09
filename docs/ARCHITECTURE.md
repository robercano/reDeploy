# Architecture

## reDeploy product

reDeploy is a resumable, idempotent deployment system built on Hardhat Ignition. The end-to-end pipeline is
**simulate → deploy → inspect**:

1. **Author** — a `DeploymentSpec` is authored either by hand or via the studio's drag-and-drop canvas.
2. **Simulate** (plan-only, no chain writes) — `POST /api/simulate` on the deploy-server calls `@redeploy/core`'s
   `simulate()` and streams back the planned steps (SSE), so a user can preview what would happen before
   committing to a real deploy.
3. **Deploy** (real, broadcasts on-chain) — `POST /api/deploy` calls `@redeploy/core`'s `deploy()`, which wraps
   Hardhat Ignition's module engine/journal for idempotent, resumable execution, and streams progress + result
   (SSE).
4. **Inspect** — `GET /api/deployment` (and the studio's read-only Inspector) reads the on-disk Ignition journal
   via `@redeploy/reader` and renders current deployment + config-step state.

Where the deploy-server sits in the dependency graph:

```
  studio (apps/studio, :5173)
       │  POST/GET /api  (Vite proxy → :8787)
       ▼
  deploy-server (apps/deploy-server, :8787)
       │  simulate() / deploy() / readDeployment()
       ▼
  @redeploy/core  +  @redeploy/reader
       │  wraps
       ▼
  Hardhat Ignition (module engine, journal, resume)
       │  reads compiled artifacts (FOUNDRY_OUT)
       ▼
  contracts/ (Foundry project — `forge build` → contracts/out)
```

See the root [`README.md`](../README.md) for the full endpoint/env reference and
[`RUNBOOK-anvil-deploy.md`](RUNBOOK-anvil-deploy.md) for a hands-on local walkthrough against Anvil.

## Orchestrator harness (contributor tooling)

This repo is built using the orchestrated multi-agent Claude Code setup described below — the harness that
drives day-to-day development on reDeploy itself, distinct from the reDeploy product described above.

## The topology
```
        YOU  — plan approval (planning) · /workflows glance (standup) · PR review (demo)
                       │
              ┌────────▼─────────┐
              │   ORCHESTRATOR   │  Opus. Scopes + delegates. Holds no implementation detail.
              └────────┬─────────┘
        ┌──────────────┼──────────────┐
   ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
   │implementer│  │implementer│  │implementer│   Sonnet. Each in its OWN git worktree + branch.
   │  module A │  │  module B │  │  module C │   Delegates exploration to Explore (Haiku).
   └────┬─────┘   └────┬─────┘   └────┬─────┘
        └──────────────┼──────────────┘
                  ┌─────▼─────┐
                  │ reviewers │  Opus. One per lens, adversarial. approve/reject → loop.
                  └───────────┘
```

## The three levers (know which to reach for)
| Lever | Mechanism | Use for |
|---|---|---|
| **Subagents** (`.claude/agents/*.md`) | Model-*decided* delegation | Open-ended "break this down"; specialized roles |
| **Workflows** (`.claude/workflows/*.js`) | *Deterministic* JS: `pipeline`/`parallel`/`agent`, loops, schemas | Repeatable fan-out where YOU control control-flow |
| **Worktrees** (`isolation: worktree`) | Each agent → own dir + branch | Preventing file clashes between parallel workers |

Subagents = flexible, model-driven. Workflows = repeatable, you-driven. They compose: a workflow can spawn the
same role agents; an orchestrator subagent can decide to invoke a workflow.

## Two-tier design (why this is a reusable framework, not a one-off)
- **Generic harness (portable):** the four agents, the workflow, `gate.sh`, the hooks, the topology, model
  routing, the adversarial-review pattern, the human checkpoints. None of it hardcodes a stack.
- **Project adapter (swappable):** `.claude/gates.json` (module map + gate commands + routing) and `CLAUDE.md`
  (context). This is the only per-project layer.

The agents are written to **read the adapter at runtime** ("run the commands in `gates.json`", "stay inside
your module's `path`"), so the same harness drives a Solidity monorepo, a Next.js app, or a Rust service —
only the adapter changes.

> In a personal setup you can push the generic tier up to `~/.claude/` (shared across all repos) and keep only
> the adapter in-repo. For a GitHub *template*, everything ships in-repo so each generated project is
> self-contained — that's what this template does.

## Why each design choice
- **Worktree isolation** is the real fix for clashes — physical separation, not politeness. Module boundaries
  + merge discipline are the logical/integration backstops.
- **Adversarial, one-lens-per-reviewer** beats a single "looks good?" pass: a reviewer told to *refute* through
  a specific lens (correctness/tests/security/perf) catches what a generic approver rubber-stamps.
- **Hard gate via Stop hook**: a failing test gate is enforced outside the model, so it can't be argued around.
- **Model routing** (Opus orchestrate/review · Sonnet build · Haiku explore) mirrors Anthropic's own finding —
  Opus-orchestrator + Sonnet-workers gave a large quality gain at the cost of ~15× tokens.

## Limits to respect
- **2–4 parallel workers** is the practical ceiling before human review/merge becomes the bottleneck.
- Token cost scales with agent count — see [`TOKEN_BUDGET.md`](TOKEN_BUDGET.md).
- Remove worktrees on merge (`git worktree list` / `git worktree remove`).

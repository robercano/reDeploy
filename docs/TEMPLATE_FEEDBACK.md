# Template Feedback Log

> Learnings discovered while using the **ai-project-orchestrator** template (upstream:
> `robercano/ai-project-orchestrator`) on this project. This is a **capture bridge**, not a permanent doc:
> append entries as we hit rough edges, then promote the `generic`-tier ones upstream (PR for ready fixes,
> issue for discussion) and record the link in **Status**. Remove entries once they've landed upstream.
>
> **Tier is the gate:** only `generic` items (agents, workflow, `gate.sh`, the `settings.json` template, docs)
> get promoted. `adapter` items (this repo's `gates.json`, `CLAUDE.md`, module map) stay local.

Entry format:

```
### <title>
- Type: bug | docs | feature | info
- Tier: generic | adapter
- Evidence: what we saw (with file/links)
- Proposed change: concrete edit to the template
- Status: open | filed #N | PR #N | merged <link>
```

---

### No pre-approved permission allow-list → parallel fan-out trips approvals + a settings.json write-race
- Type: bug
- Tier: generic
- Evidence: The template ships hooks (`PostToolUse` lint, `Stop` test) and worktree isolation, but
  `.claude/settings.json` carries only a tiny `allow` list. During setup, every new command shape
  (`pnpm …`, `forge …`, `git add/commit/push`, one-off `chmod`/`echo`) got auto-recorded into the **tracked**
  `settings.json`. Because the harness persists a grant *before* the approved command runs, a `git add` of a
  hand-cleaned `settings.json` re-staged the harness-rewritten (noisy) version — a lost-update race. With N
  parallel implementers this becomes concurrent read-modify-write on the permission file (lost updates, and
  JSON that can be left malformed), plus simultaneous, ambiguous approval prompts that stall workers.
- Proposed change: (1) Ship a comprehensive generic `allow` list covering the agent command surface
  (`gate.sh`, `pnpm`, `forge`/`cast`, `git`, `gh`, common read-only tools) so nothing needs runtime approval.
  (2) Add a minimal `deny` list for clearly dangerous ops (force-push, reading `.env*`). (3) Route runtime
  grant-persistence to `.claude/settings.local.json` and gitignore it, so incidental grants never dirty the
  shared, tracked file. (4) Document the worktree settings-resolution behavior (do subagents read worktree-local
  or main `.claude/`?) — **needs verification**, see separate entry.
- Status: open

### Empty repo can't pass gates until a skeleton exists
- Type: docs
- Tier: generic
- Evidence: `GETTING_STARTED.md` Step 3 says to sanity-check `gate.sh build|lint|test`, but on a freshly
  generated repo there is no build system yet, so real gate commands fail (not skip). We had to scaffold a
  buildable workspace first for the pilot to work.
- Proposed change: Add a "bootstrap first" note: either scaffold a minimal buildable skeleton before wiring
  real gate commands, or keep gates empty (skip) until a bootstrap task lands. Make the ordering explicit.
- Status: open

### Reusable backlog seeder + GitHub Issues as the ticket source
- Type: feature
- Tier: generic
- Evidence: We chose GitHub Issues for tickets and wrote `.claude/scripts/seed-issues.sh` (idempotent: reused
  labels, skipped existing titles) to bulk-create a module-labeled backlog. This is a generally useful pattern
  the template doesn't provide.
- Proposed change: Ship an optional, generic `seed-issues.sh` example (labels per module from `gates.json`,
  idempotent create) and mention GitHub Issues as a first-class ticket source in `USAGE.md`.
- Status: open

### `test_affected` has no cheap pnpm-workspace equivalent
- Type: docs
- Tier: generic
- Evidence: `gates.json` defines `test_affected` (used by the `Stop` hook), but pnpm has no built-in
  "affected since base" filter without extra tooling (turbo/nx or `--filter "...[origin/main]"`, which is
  flaky in worktrees). We set `test_affected` = full test suite as a stopgap.
- Proposed change: Add per-stack guidance for `test_affected` (turbo/nx, `pnpm --filter`, Foundry, etc.) and
  note that "= full test" is an acceptable starting point.
- Status: open

### Worked TS + Solidity (Foundry + Hardhat) adapter as a reference example
- Type: info
- Tier: generic
- Evidence: reDeploy's `.claude/gates.json` + `CLAUDE.md` are a complete, working adapter for a mixed
  TypeScript + Solidity pnpm monorepo (vitest + forge gates, 6-module map). `PROMPTS.md` #8 talks about
  onboarding new stacks but ships no concrete non-JS example.
- Proposed change: Add a sanitized TS+Solidity adapter snippet to the docs (or an `examples/` dir) as a
  reference for mixed-stack projects.
- Status: open

### Verify: how subagents resolve `.claude/` settings inside a worktree
- Type: info
- Tier: generic
- Evidence: Implementers run with `isolation: worktree`. `.claude/settings.json` is a tracked file, so each
  worktree gets its own checked-out copy. It's unclear whether a subagent resolves permissions/hooks from the
  worktree-local `.claude/` or the main project `.claude/`. This determines whether parallel workers contend on
  one file or isolate (and then collide at merge).
- Proposed change: Run a small probe, document the answer, and ensure the allow-list/hook story holds under
  worktree isolation. (Blocks confidence in the fix for the allow-list race entry above.)
- Status: open

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

### (A) No pre-approved permission allow-list → settings.json grant-race + approval fatigue
- Type: bug
- Tier: generic
- Evidence: The template ships hooks (`PostToolUse` lint, `Stop` test) and worktree isolation, but
  `.claude/settings.json` carries only a tiny `allow` list. Every new command shape we ran got auto-recorded
  into the **tracked** `settings.json`; because the harness persists a grant *before* the approved command
  runs, a `git add` of a hand-cleaned file re-staged the harness-rewritten (noisy) version (lost-update). With
  many workers, the same approval prompts would also stall the fan-out. **Note:** this is the *project*
  `settings.json` problem — distinct from `.claude.json` corruption (see entry C).
- Proposed change: Ship a comprehensive generic `allow` list covering the agent command surface
  (`gate.sh`, `git`, `pnpm`/package manager, build/test tools, `gh`, common read-only tools) so nothing needs
  runtime approval, plus a minimal `deny` list (force-push, `rm -rf`, reading `.env*`). reDeploy's committed
  `.claude/settings.json` (59 allow / 4 deny) is the tested reference. To commit it cleanly despite the
  runtime rewrite, stage via the git index (`git hash-object -w` + `git update-index --cacheinfo`).
- Status: implemented in reDeploy (commit 0bb3ff6); ready to promote upstream as a PR.

### (B) Empty repo can't pass gates until a skeleton exists
- Type: docs
- Tier: generic
- Evidence: `GETTING_STARTED.md` Step 3 says to sanity-check `gate.sh build|lint|test`, but on a freshly
  generated repo there is no build system yet, so real gate commands fail (not skip). We scaffolded a buildable
  workspace first for the pilot to work.
- Proposed change: Add a "bootstrap first" note: either scaffold a minimal buildable skeleton before wiring
  real gate commands, or keep gates empty (skip) until a bootstrap task lands. Make the ordering explicit.
- Status: open

### Reusable backlog seeder + GitHub Issues as the ticket source
- Type: feature
- Tier: generic
- Evidence: We chose GitHub Issues for tickets and wrote `.claude/scripts/seed-issues.sh` (idempotent: reused
  labels, skipped existing titles) to bulk-create a module-labeled backlog. The template doesn't provide this.
- Proposed change: Ship an optional, generic `seed-issues.sh` example (labels per module from `gates.json`,
  idempotent create) and mention GitHub Issues as a first-class ticket source in `USAGE.md`.
- Status: open

### `test_affected` has no cheap pnpm-workspace equivalent
- Type: docs
- Tier: generic
- Evidence: `gates.json` defines `test_affected` (used by the `Stop` hook), but pnpm has no built-in
  "affected since base" filter without extra tooling. We set `test_affected` = full test suite as a stopgap.
- Proposed change: Add per-stack guidance for `test_affected` (turbo/nx, `pnpm --filter "...[origin/main]"`,
  Foundry, etc.) and note that "= full test" is an acceptable starting point.
- Status: open

### Worked TS + Solidity (Foundry + Hardhat) adapter as a reference example
- Type: info
- Tier: generic
- Evidence: reDeploy's `.claude/gates.json` + `CLAUDE.md` are a complete adapter for a mixed TypeScript +
  Solidity pnpm monorepo (vitest + forge gates, 6-module map). `PROMPTS.md` #8 mentions onboarding new stacks
  but ships no concrete non-JS example.
- Proposed change: Add a sanitized TS+Solidity adapter snippet to the docs (or an `examples/` dir).
- Status: open

### (C) Concurrent config-file write safety under parallel subagents (re: anthropics/claude-code#29217)
- Type: info
- Tier: generic
- Evidence: **Empirically probed on 2026-06-09, Claude Code v2.1.153, Linux/WSL2.** Upstream issue
  [anthropics/claude-code#29217](https://github.com/anthropics/claude-code/issues/29217) reports `~/.claude.json`
  (global config) corruption from non-atomic concurrent writes by multiple processes/subagents — but it was
  reported on v2.1.59–2.1.62, labeled `platform:windows`, and is **CLOSED as `stale`** (not confirmed-fixed).
  Our probe: 6 parallel subagents × 8 tool calls + 1 worktree-isolated subagent + the main session, ~50 tool
  calls in a 3–8s window. Result: `~/.claude.json` stayed **valid JSON**, grew normally (27790 → 28231 bytes),
  **0 `.corrupted.*` files**, backups healthy. A prior hard WSL crash mid-write also left it valid.
  **Conclusion: #29217 does not reproduce on v2.1.153/WSL2** — safe to fan out at modest concurrency.
  Worktree/settings-resolution observations from the same probe:
  - Worktrees are created at `<repo>/.claude/worktrees/agent-<id>` on branch `worktree-agent-<id>`, and are
    **auto-removed on completion**.
  - Each worktree gets its **own checked-out `.claude/settings.json`** (starts from the committed 59-entry
    list), so grant-writes are **isolated per worktree** — no cross-worker contention on the file.
  - Subagents **auto-approve and persist** non-allowlisted commands (`uname -a` succeeded; the worktree's
    settings.json grew 59 → 65 during the run) — but into the worktree-local copy, which is discarded.
  - The harness **owns `settings.json` at runtime**: it rewrote the *main* working-tree copy to its own session
    list (59 → 36), clobbering manual edits. Source of truth = the **committed** file; never expect a
    hand-edit to persist mid-session; always commit via the index-bypass.
  - `.claude/settings.local.json` did **not** auto-capture grants (stayed 0 entries) — routing grants to a
    gitignored local file is **not** automatic; worktree isolation is what actually prevents the race.
- Proposed change: In the template docs, (1) link #29217 and state the corruption is an *upstream Claude Code*
  concern the template can only document + mitigate (not fix); (2) recommend modest `max_parallel_workers`
  (2–3) and not running other CC sessions / the Desktop app from the same home during runs; (3) note the
  index-bypass commit trick for `settings.json`; (4) **residual risk:** an implementer's `git add -A` can stage
  a grant-drifted `settings.json` into its PR — add an implementer instruction to never stage
  `.claude/settings*.json`, or a pre-commit guard.
- Status: probe complete; ready to promote upstream as an issue (doc + mitigation guidance).

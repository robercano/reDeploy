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
- Status: PR — upstream robercano/ai-project-orchestrator#1 (reDeploy reference commit 0bb3ff6).

### (B) Empty repo can't pass gates until a skeleton exists
- Type: docs
- Tier: generic
- Evidence: `GETTING_STARTED.md` Step 3 says to sanity-check `gate.sh build|lint|test`, but on a freshly
  generated repo there is no build system yet, so real gate commands fail (not skip). We scaffolded a buildable
  workspace first for the pilot to work.
- Proposed change: Add a "bootstrap first" note: either scaffold a minimal buildable skeleton before wiring
  real gate commands, or keep gates empty (skip) until a bootstrap task lands. Make the ordering explicit.
- Status: PR — upstream robercano/ai-project-orchestrator#2.

### Reusable backlog seeder + GitHub Issues as the ticket source
- Type: feature
- Tier: generic
- Evidence: We chose GitHub Issues for tickets and wrote `.claude/scripts/seed-issues.sh` (idempotent: reused
  labels, skipped existing titles) to bulk-create a module-labeled backlog. The template doesn't provide this.
- Proposed change: Ship an optional, generic `seed-issues.sh` example (labels per module from `gates.json`,
  idempotent create) and mention GitHub Issues as a first-class ticket source in `USAGE.md`.
- Status: PR — upstream robercano/ai-project-orchestrator#3.

### `test_affected` has no cheap pnpm-workspace equivalent
- Type: docs
- Tier: generic
- Evidence: `gates.json` defines `test_affected` (used by the `Stop` hook), but pnpm has no built-in
  "affected since base" filter without extra tooling. We set `test_affected` = full test suite as a stopgap.
- Proposed change: Add per-stack guidance for `test_affected` (turbo/nx, `pnpm --filter "...[origin/main]"`,
  Foundry, etc.) and note that "= full test" is an acceptable starting point.
- Status: filed — upstream issue robercano/ai-project-orchestrator#4.

### Worked TS + Solidity (Foundry + Hardhat) adapter as a reference example
- Type: info
- Tier: generic
- Evidence: reDeploy's `.claude/gates.json` + `CLAUDE.md` are a complete adapter for a mixed TypeScript +
  Solidity pnpm monorepo (vitest + forge gates, 6-module map). `PROMPTS.md` #8 mentions onboarding new stacks
  but ships no concrete non-JS example.
- Proposed change: Add a sanitized TS+Solidity adapter snippet to the docs (or an `examples/` dir).
- Status: filed — upstream issue robercano/ai-project-orchestrator#6.

### (D) Owner-authored PRs can't be formally approved + no PR-feedback/notification loop
- Type: feature
- Tier: generic
- Evidence: With `pr-per-agent`, agents create PRs via the owner's `gh` auth → GitHub hard-blocks PR
  authors from approving their own PRs, so the "Sprint demo" checkpoint can never produce a formal
  Approve (hit on robercano/reDeploy#14). USAGE.md also documented nothing about how review comments
  flow back into the implementer loop, or how the agent learns of new tickets/comments unprompted.
- Proposed change: Ship `bot-gh.sh` (gh wrapper as a bot machine account, `GH_BOT_TOKEN` in `.env`;
  one free generically-named machine account is ToS-allowed and reusable across repos; classic PAT —
  fine-grained can't target other personal accounts' repos) + a USAGE.md "PR feedback loop" section
  (ticket → PR → review-comments-via-orchestrator → merge, plus cron//loop polling with a cursor file).
  Follow-up learning (reDeploy fce0356): an INLINE polling command (loops, `$()`, redirects) never matches
  a permission rule → every cron firing blocks on approval. Ship `notify-poll.sh` (repo derived from the
  git remote) and pre-approve that one command in `settings.json`.
- Follow-up (2026-06-16): the bot needs **per-repo collaborator access**, and this bites silently. Opening
  the #8 PR in a *second, private* repo (`ai-project-orchestrator` itself) failed with the opaque
  `GraphQL: Could not resolve to a Repository with the name '<owner>/<repo>'` — the bot simply couldn't see
  the private repo because it had only ever been added to reDeploy. `bot-gh.sh`'s header notes "add it as a
  collaborator (write) on each repo" (setup step 2), but nothing enforces or surfaces it: the failure reads
  like a typo'd repo name, not a missing grant. Fix needed two API calls — `PUT repos/<r>/collaborators/<bot>
  -f permission=push` (owner auth) then accept the invite as the bot (`PATCH user/repository_invitations/<id>`
  with the bot token).
- Proposed change (follow-up): (1) add a **preflight to `bot-gh.sh`** — when args contain `--repo OWNER/NAME`
  (or a `pr create` in a repo cwd), do a cheap `gh repo view` with the bot token first and, on failure, print
  the exact collaborator-grant + invite-accept commands instead of letting the opaque GraphQL error surface;
  (2) document the per-repo "invite + accept" one-time step (and the gh recipe) in the USAGE.md PR-feedback
  section, not only in the script header.
- Status: PR — upstream robercano/ai-project-orchestrator#7 (reDeploy reference: bot-gh.sh + USAGE.md
  on branch chore/orchestrator-setup). Follow-up (collaborator preflight + docs): **open** — not yet
  promoted; #7 already merged, so this needs a fresh upstream PR/issue.

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
- Status: filed — upstream issue robercano/ai-project-orchestrator#5 (doc + mitigation guidance).

---

> **emdash feature-comparison batch (filed 2026-06-12).** Entries (E)–(H) were surfaced by comparing this
> headless harness against [emdash](https://github.com/generalaction/emdash) (YC W26, Apache-2.0 desktop GUI
> for agents-in-worktrees) while driving the template downstream on reDeploy. Thesis: the two are
> **complementary** — emdash as a visual cockpit, this harness as the autonomous engine.

### (E) No server-side gate enforcement — ship a CI workflow that runs gates.json on PRs
- Type: feature
- Tier: generic
- Evidence: The harness enforces gates locally (`settings.json` hooks + `gate.sh`, plus the orchestrator
  running them before opening a PR), but **nothing enforces gates at the GitHub PR level** — the template
  ships no `.github/workflows/`. Downstream (reDeploy), a PR merged with an *empty* status-check rollup: the
  only thing between a red gate and `main` was the orchestrator remembering to run `gate.sh`. emdash treats
  **GitHub Actions as the source of truth** for pre-merge checks (it only *monitors* check runs), so any
  visual front-end over this harness expects server-side checks to exist.
- Proposed change: Ship a generated `.github/workflows/gates.yml` (+ a `PROMPTS.md` entry to draft it from
  `gates.json`) that runs each gate (`build`/`lint`/`typecheck`/`test`/`coverage`) on `pull_request`,
  mirroring the local gate commands — generate the job matrix from `gates.json` `modules` so it stays a
  config edit, not hand-maintained YAML. Document **branch protection (required checks)** as the enforcement
  teeth, and enforce `coverage_threshold` in CI.
- Status: filed — upstream issue robercano/ai-project-orchestrator#8.

### (F) Per-worktree setup/teardown lifecycle so isolated workers can run all gates
- Type: feature
- Tier: generic
- Evidence: Implementers and the test-runner work in **isolated git worktrees**, but a fresh worktree lacks
  toolchain state that lives outside the tree — freshly installed `node_modules`, or Foundry libs pulled by
  `forge install`. Downstream (reDeploy), worktree workers **could not run the `forge` gate** until a one-time
  `forge install` was done by hand in the main checkout; the orchestrator had to run the full forge suite
  itself *after* the fact, defeating in-worktree gating. emdash handles this with per-worktree lifecycle
  scripts in `.emdash.json` (`scripts.setup`/`run`/`teardown`).
- Proposed change: Add an optional **per-worktree lifecycle** to the adapter — e.g. `gates.json` →
  `worktree.setup`/`worktree.teardown`, or a `settings.json` hook on worktree create/remove — that bootstraps
  a worktree on creation (install deps, `forge install`, link shared caches) and tears down on removal. Makes
  *"every gate runs in isolation"* actually true.
- Status: filed — upstream issue robercano/ai-project-orchestrator#9.

### (G) Evaluate an optional visual cockpit (emdash) as a front-end over the headless pipeline
- Type: info
- Tier: generic
- Evidence: This harness is **headless/CLI-first** (code-defined fan-out, gate-as-code, adversarial multi-lens
  review, cron poll + scheduled wakeups). emdash covers the *overlapping* layer — "run N agents in worktrees +
  diff/review/merge UX" — with a polished desktop GUI, ~27 providers, SSH/SFTP remote, scheduled automations,
  and GitHub-check surfacing. But emdash has **no role-based orchestration, no local gate enforcement, no
  adversarial review, and no headless mode** — so the two are complementary, not substitutes.
- Proposed change: Spike whether emdash (or similar) can sit on top of the **same worktrees** as a visual
  front-end while this harness stays the autonomous engine. Document the integration seam (both drive git
  worktrees — pick one driver per session to avoid clutter), what must exist for checks to show up in such a
  GUI (depends on (E) — server-side gates), and what the harness keeps that the GUI can't replace
  (gates-as-code, defined roles, adversarial review, headless autonomy). Outcome is a `docs/` decision note,
  not necessarily an integration.
- Status: filed — upstream issue robercano/ai-project-orchestrator#10.

### (H) Self-host: a self-adapter + fixture target so the template can iterate on itself
- Type: feature
- Tier: generic
- Evidence: The template drives a *target* project via the adapter (`gates.json` + `CLAUDE.md`). To improve the
  harness **using** the harness, the orchestrator repo must become its own target (the bootstrap/chicken-and-egg
  problem). Two things make it tractable: (1) **worktree isolation already breaks the immediate cycle** —
  implementers edit candidate `.claude/` files on a branch in a worktree while the driving session keeps the
  definitions it loaded at start; (2) **self-hosting promotion** — harness `vN` drives the change producing
  `vN+1`, then you restart the session to adopt it (like a compiler compiling its successor); agent/`settings`/
  hook changes only take effect on a *fresh* session, so they need a smoke test that launches a sub-session in
  the candidate worktree.
- Proposed change: Ship a **self-adapter** so the repo dogfoods itself — its own `gates.json` over the harness
  artifacts (`lint`: shellcheck `.claude/scripts/*.sh` + `node --check` on workflows + markdownlint docs;
  `build`/`typecheck`: JSON-schema-validate `gates.json`, parse-check `settings.json`; `test`: a smoke harness
  running `feature-fanout.js` against a tiny checked-in **fixture target repo** under `examples/`, asserting a
  scope→implement→review loop yields a green PR — validating end-to-end **without infinite regress**).
  Optionally a **pinned known-good engine** copy (tag/submodule) to launch the driving session, so a broken
  candidate can't brick the driver mid-loop.
- Status: filed — upstream issue robercano/ai-project-orchestrator#11.

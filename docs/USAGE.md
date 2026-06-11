# Using the Orchestrator (after setup)

Two ways to drive it: **conversational** (the orchestrator subagent — flexible) or **workflow** (deterministic
fan-out). Plus the human checkpoints that keep you in the loop.

## A. Conversational — the orchestrator subagent
Best for one-off or exploratory tasks where the shape isn't known up front.

**Kick off:**
```
Use the orchestrator agent. Task: <describe the goal>.
Scope it into non-overlapping sub-tasks by module, show me the plan, and WAIT for approval.
```
The orchestrator reads `gates.json` + `CLAUDE.md`, decomposes, and presents a plan in plan mode.

**Approve / adjust the plan** — this is your *planning checkpoint*. Check: are sub-tasks truly independent? Is
each inside one module? Too many workers for the size? Then approve.

**Let it run.** Each sub-task goes to an `implementer` in its own worktree/branch; on "done" the orchestrator
fans the change to `reviewer`s (one per lens); rejects loop back to the implementer until clean.

**Mid-run controls:**
- "Status?" → orchestrator emits the standup block (done/in-progress/blocked, branches, gates, risks).
- "Pause worker B / drop sub-task C / re-scope D."
- "Show me worker A's diff before it opens a PR."

## B. Workflow — deterministic fan-out
Best for repeatable, known-shape work (a feature with clear parts, a migration, a sweep). Token-heavy, so it's
gated behind explicit opt-in.

```
ultracode run the feature-fanout workflow with task: "<your task>"
```
or ask: *"Run the `feature-fanout` workflow, args.task = '…'"*. It runs `Scope → Implement → Review → loop`
(up to 3 iterations/sub-task) and returns approved vs. needs-human results. Watch live with `/workflows`.

Tune `.claude/workflows/feature-fanout.js`: `LENSES`, `MAX_ITERS`, model per stage, worktree isolation.

## The human checkpoints (your agile cadence)
| Ceremony | Mechanism | What you do |
|---|---|---|
| **Sprint planning** | Plan mode (`ExitPlanMode`) | Approve/adjust the decomposition before any code |
| **Daily standup** | `/workflows` board · "Status?" · `TodoWrite` list | Glance at progress; unblock |
| **Sprint demo** | PR-per-agent + `/review` + `verify`/`run` skills | Review each branch; see features actually work |
| **Retro** | `npx ccusage` + run notes | Tune routing, worker count, prompts for next run |

## The iteration loop (how "done" is enforced)
```
implementer ──done──▶ gates (build/lint/types/test/coverage via gate.sh + hooks)
                          │ red → implementer keeps working (Stop hook blocks finish)
                          ▼ green
                     reviewers (1 per lens, adversarial)
                          │ any reject → reasons fed back → implementer iterates
                          ▼ consensus approve (per gates.json review.consensus)
                     PR / merge (per gates.json merge.policy)
```

## Ticket → PR → merge (the standing loop)
1. **Plan** — GitHub Issues are the backlog: planned conversationally (then seeded via
   `.claude/scripts/seed-issues.sh`) or added manually. Label with `module:*` / `type:*`.
2. **Build** — "Work issue #N": the orchestrator scopes, implementers build in isolated worktrees,
   reviewer lenses gate, `gate.sh` gates must be green.
3. **PR** — created with `.claude/scripts/bot-gh.sh pr create …` so the PR author is the **bot machine
   account** (token in `.env` → `GH_BOT_TOKEN`), not the repo owner. GitHub hard-blocks PR authors
   from approving their own PRs — bot authorship is what makes a formal human Approve possible. Only PR
   creation uses the bot; commits, pushes and everything else stay on the owner's account.
4. **Review** — the owner reviews on GitHub. New review comments are picked up by the notification poll
   (below) or by asking *"address the comments on PR #N"*. Fixes go through the same
   implementer → reviewer loop on the same branch; pushing updates the PR in place.
5. **Merge** — owner approves; merge per `gates.json.merge`; clean up the worktree (see below).

### One-time setup: the bot machine account (~10 min, human-only)
1. Create a **free** GitHub account for the bot. GitHub ToS allows exactly **one** free machine account
   alongside your personal account — so name it generically (e.g. `<you>-assistant-bot`) and **reuse it
   across all your repos**, adding it as a collaborator wherever it should open PRs.
2. From the owner account: repo **Settings → Collaborators →** invite the bot with **write** access;
   accept the invite as the bot.
3. As the bot: **Settings → Developer settings → Personal access tokens → Tokens (classic)** → generate
   with `repo` scope. Classic, not fine-grained — fine-grained PATs can't reliably target repos owned by
   *another* personal account.
4. Put it in `.env` (gitignored) as `GH_BOT_TOKEN=…`. Verify with:
   `.claude/scripts/bot-gh.sh api user --jq .login` → should print the bot's username.

### Notifications (new issues / PR comments)
A **Claude Code cron** polls `robercano/reDeploy` every ~15 min while Claude Code is running:
new issues and new PR comments/reviews since the cursor in `.claude/state/notify-cursor` (gitignored)
are summarized in the session, with an offer to kick the orchestrator. Cron jobs are session-scoped and
auto-expire after **7 days** — re-arm at session start by asking: *"set up the reDeploy notification
cron"*. For tighter cadence during an active work session, additionally run
`/loop 5m check reDeploy for new issues and PR comments`.

Re-arm spec (`CronCreate` schedule `6,21,36,51 * * * *`): the cron prompt runs
`bash .claude/scripts/notify-poll.sh` — pre-approved in `.claude/settings.json`, so it never blocks on a
permission prompt. The script reads/advances the cursor and prints the four sections (issues, PR review
comments, issue-comments on PRs, PR reviews) as JSON; the cron prompt then either replies one line
("No new GitHub activity on reDeploy.") or summarizes the items (number, author, gist, link) and asks
whether to act (address PR comments / start an issue) — never starting implementation unprompted.

## Merge discipline
- **`pr-per-agent`** (default): each worker → branch → PR. You (or a merge step) integrate; conflicts surface
  at PR time. Cleanest/auditable.
- **`orchestrated-sequential-merge`**: a coordinator merges branches in dependency order, re-running gates
  after each. Faster when many finish together, but needs careful ordering.

After merging a branch, clean its worktree:
```bash
git worktree list
git worktree remove <path>
```

## Scaling up
Start at `max_parallel_workers: 1–2`. Raise it only when your review+merge throughput proves it can keep up.
If workers stall or collide, the fix is almost always a sharper **module map** in `gates.json`, not more agents.

## When NOT to orchestrate
Trivial or single-file changes: just do them directly. The 15× token multiplier isn't worth it. The
orchestrator itself is told to use one worker and no parallelism for small tasks — hold it to that.

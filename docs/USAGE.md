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
   creation uses the bot; commits, pushes and everything else stay on the owner's account. `bot-gh.sh`
   auto-assigns every new PR to the repo owner (`--assignee robercano`, override with `OWNER_LOGIN`) so
   the owner gets a GitHub notification to review.
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

### Autonomous PR loop (notifications → merge → iterate)
A **Claude Code cron** drives `robercano/reDeploy` every ~15 min while Claude Code is running. Your
workflow is: **add issues → review PRs → give feedback → the agent fixes → you Approve → the agent merges
and moves on**. Your GitHub **Approve is the only human gate**; everything downstream of it is automatic.

Each tick the cron does exactly this, in order:
1. **Poll** — `bash .claude/scripts/notify-poll.sh` prints new issues / PR comments / reviews since the
   cursor in `.claude/state/notify-cursor` (gitignored), plus a cursor-independent **open-PR status**
   section (per PR: latest owner review, CI rollup, mergeable). Summarizes new items (number, author, gist,
   link).
2. **Merge** — `bash .claude/scripts/merge-ready.sh` merges every open PR you've **APPROVED** that is
   **mergeable** and **CI-green**, then deletes the branch. Safety: it merges only if your approval was
   submitted **at/after the PR's last commit** — so a free private repo (no branch protection to dismiss
   stale approvals) still never auto-merges commits you haven't seen. **Pushing a new commit after you
   approve requires a re-approval.** Reports each PR merged or why it was skipped.
3. **Address feedback** — for any open PR with unanswered review feedback from you (`CHANGES_REQUESTED` or
   review comments since the last push), runs the orchestrator → implementer → reviewer loop on the **same
   branch** and pushes (updates the PR in place). It does not merge here — the next tick's step 2 will, once
   you re-approve.
4. **Advance** — **only when there are zero open PRs** (all merged), picks the lowest-numbered open issue
   labelled `module:*` that has no `feat/issue-<n>-*` branch yet and kicks the orchestrator on it
   (scope → plan → implement → bot PR). This serializes work — one issue in flight at a time — so the loop
   stays bounded and cheap.
5. If nothing is actionable, replies one line: *"No actionable reDeploy activity on reDeploy."*

The cron never **approves** PRs (only you do) and never starts a new issue while a PR is open. Both scripts
run as the bot via `GH_BOT_TOKEN` (a write collaborator) and are pre-approved in `.claude/settings.json`, so
the cron runs headless without permission prompts or a separate owner `gh auth login`.

Cron jobs are session-scoped and auto-expire after **7 days** — re-arm at session start by asking: *"set up
the reDeploy PR-loop cron"*. For a tighter cadence during an active session, additionally run
`/loop 5m run the reDeploy PR loop`. Re-arm spec: `CronCreate` schedule `6,21,36,51 * * * *`, with the cron
prompt encoding steps 1–5 above.

### Adaptive cadence policy
The PR-loop cron self-adjusts its polling frequency to avoid burning cycles when there's nothing to do:
- **Fast (every minute, `* * * * *`)** — whenever there is **≥1 open PR or ≥1 open `module:*` issue** (work
  is in flight: issues to drive, approvals/feedback to pick up promptly).
- **Idle (hourly, `17 * * * *`)** — when there are **zero open PRs and zero open issues** (backlog drained).

Each tick runs a **STEP 0** before the usual steps 1–5: it checks open PRs + open `module:*` issues, computes
the desired cadence, and if the current job's schedule doesn't match, it `CronDelete`s itself and
`CronCreate`s a replacement at the right schedule with the *same* prompt. So the loop speeds up automatically
when you add issues / a PR opens, and falls back to hourly once everything is merged. The cron prompt is
identical at both cadences (it carries the STEP 0 logic), so it stays stable across self-recreation.

## Testing on a phone (opt-in)
`/test-pr <pr-number>` normally prepares a PR worktree and prints `humanTest.launch` (studio + deploy-server on
`localhost`, browser-only). Add `--phone` (or set `PHONE=1`) to instead print `humanTest.launchPhone`, which
starts the same dev servers and additionally opens a `cloudflared` quick tunnel to the studio so a phone can
reach it over the internet — no app/source changes, same Vite dev server, just tunneled.

This is opt-in, and *not* meant to be left unattended — before using it, know that:
- The tunnel's `https://*.trycloudflare.com` URL is **public** for anyone who has it while it's up.
- It exposes the studio's dev server **and its `/api` proxy** to the deploy-server, so a visitor can trigger
  **real deploys** using the worktree's `.env` (RPC URL / private keys).
- It's **ephemeral** — Ctrl-C tears down the tunnel and both dev servers together.
- It must be **attended** — don't leave it running unsupervised.

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

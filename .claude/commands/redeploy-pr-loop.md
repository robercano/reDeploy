---
description: Arm (or re-arm) the reDeploy autonomous PR-loop cron and run one tick now
---

You are (re)arming the reDeploy autonomous PR loop for repo `robercano/reDeploy`. Do BOTH steps:

## 1. (Re)arm the cron — idempotent
- Call `CronList`. If a job already exists whose prompt mentions "reDeploy autonomous PR loop", leave it (don't create a duplicate) and report its id + schedule.
- Otherwise `CronCreate` with `durable: true` and schedule `6,21,36,51 * * * *` and the EXACT prompt below.

Prompt to use (the tick logic, with adaptive STEP 0):

> Run one tick of the reDeploy autonomous PR loop (repo robercano/reDeploy). Follow docs/USAGE.md and .claude/agents/*; reviewer lenses + consensus per .claude/gates.json; PRs are created/updated via .claude/scripts/bot-gh.sh (bot author robercano-ghbot), commits stay as the owner.
>
> STEP 0 — adaptive cadence: count open PRs (base main) and open issues labelled module:*. Desired cadence = FAST "* * * * *" if there is ≥1 open PR OR ≥1 open module:* issue; else IDLE "17 * * * *". If this job's current schedule != desired, CronDelete this job and CronCreate a durable replacement with this SAME prompt at the desired schedule.
>
> Then, in order:
> 1. POLL: run `bash .claude/scripts/notify-poll.sh`; summarize new issues / PR comments / reviews and the open-PR status section.
> 2. MERGE: run `bash .claude/scripts/merge-ready.sh`; report each PR merged or why skipped. (It only merges PRs the owner APPROVED that are CI-green & mergeable; never approves.)
> 3. ADDRESS FEEDBACK: for any open PR with unanswered owner review feedback (CHANGES_REQUESTED, or review comments since last push), run orchestrator→worktree implementer→reviewer-lenses on the SAME branch and push to update the PR in place. Do NOT merge here.
> 4. ADVANCE: ONLY when there are ZERO open PRs — pick the lowest-numbered open module:* issue with no feat/issue-<n>-* branch; drive it through the orchestrator (scope → worktree implementer → gate.sh gates → reviewer lenses → bot PR). One issue in flight at a time.
> 5. If nothing actionable, reply exactly one line: "No actionable reDeploy activity on reDeploy."

## 2. Run one tick now
Execute steps 1–5 above immediately so the loop doesn't wait for the next cron fire. Report what happened (polled items, merges, feedback addressed, issue advanced — or "no actionable activity").

Notes: the cron is session-scoped (and may not persist across restarts even with `durable`), which is why this command exists — running `/redeploy-pr-loop` at the start of any session restores the whole loop in one step. For a tighter in-session cadence you can also run `/loop 5m /redeploy-pr-loop`.

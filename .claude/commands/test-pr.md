---
description: Prepare an open PR for local human testing — checks out its branch into an isolated, ready-to-run worktree (deps built) and hands you the launch command.
argument-hint: <pr-number> [--phone] | --serve <pr-number> | --reset
---

You are preparing an OPEN pull request for the user to manually test locally, WITHOUT disturbing their main
working tree. The arguments are: **$ARGUMENTS**

Do this:

1. Run `bash .claude/scripts/prepare-pr.sh $ARGUMENTS`. It resolves the PR's head branch, fetches it, creates (or
   refreshes) a **detached** worktree at `<humanTest.worktreeDir>/pr-<n>` (default `.worktrees/pr-<n>`),
   and runs the project's `humanTest.prepare` command (install + build) inside it. The script is idempotent —
   re-running it on the same PR just fast-forwards the worktree to the latest pushed commit and rebuilds.

2. If the script fails, report the exact error and stop (common causes: the PR is closed, the bot token isn't set,
   or `humanTest` isn't configured in `.claude/gates.json`). Do not guess.

3. On success, report to the user, in this order:
   - the PR number, its title, and the **exact head commit SHA** the worktree is now at (so they know they are
     testing the latest pushed code, not a stale build — the usual reason "the fix doesn't work" for them);
   - the ready-to-run path and the launch command the script printed, e.g.
     `cd <path> && <humanTest.launch>`.
   - Tell them to run the launch command **in their own terminal** (a dev server is long-running and needs a
     browser), and to tear the worktree down with `git worktree remove <path>` when finished.

4. Offer (do not assume) to start the launch command for them in the background if they'd rather you drive it.

## Testing on a phone (opt-in): `--phone`

`/test-pr <pr-number> --phone` (equivalently: `bash .claude/scripts/prepare-pr.sh <pr-number> --phone`, or set
`PHONE=1` in the environment) does everything the default path does, but prints `humanTest.launchPhone` instead
of `humanTest.launch`. That command starts the same dev servers **and** opens a `cloudflared` quick tunnel to
the already-running studio (`http://localhost:5173`), so a phone (or anyone with the link) can reach it over the
internet. Nothing about the app changes — it's the same Vite dev server, just tunneled.

Before telling the user to run the printed command, make sure they see all four caveats:
1. **Public** — the printed `https://<random>.trycloudflare.com` URL works for anyone who has it while the
   tunnel is up, not just the phone it's meant for.
2. **Exposes `/api` too** — the tunnel forwards the studio's Vite dev server, which proxies `/api` to the
   deploy-server. That means a visitor to the URL can trigger **real deploys**, using whatever RPC URL and
   private keys are configured in the worktree's `.env`.
3. **Ephemeral** — the tunnel and both dev servers are tied together (backgrounded dev servers + a trap); killing
   the command (Ctrl-C) tears down everything at once. There is no persistence across runs.
4. **Attended use only** — don't leave it running unattended; treat the tunnel URL like a temporary, unauthenticated
   admin panel for the duration it's up.

As with step 4 above, offer (do not assume) to start the launch command in the background for the user; if you do
start `humanTest.launchPhone`, watch its output for the `https://<random>.trycloudflare.com` URL and surface that
URL clearly once it appears, so it's easy to open on the phone.

If `humanTest.launchPhone` isn't configured in `.claude/gates.json`, the script says so and falls back to
printing the normal `humanTest.launch` command — report that to the user rather than treating it as a failure.

Notes:
- This never edits the PR and never touches `main` — the worktree is an isolated, detached checkout, so it can
  coexist with the same branch checked out elsewhere (e.g. an agent worktree).
- The prepare/launch/launchPhone/worktree-dir commands are read from `.claude/gates.json` → `humanTest`, so this
  command is project-agnostic. If `humanTest` is absent, the script still makes the worktree and tells the user
  to build/run manually.

## Serving a PR through the always-on studio: `--serve` / `--reset`

If you've set up the always-on, Cloudflare-tunneled studio described in `docs/ALWAYS-ON-TUNNEL.md` (a
`systemd --user` service serving `https://<STUDIO_HOSTNAME>` continuously, reachable from a phone anywhere), two
extra modes point that persistent service at a specific PR instead of a one-off local/quick-tunnel launch:

- **`/test-pr --serve <pr-number>`** (equivalently `bash .claude/scripts/prepare-pr.sh --serve <pr-number>`): runs
  the exact same prepare flow as `/test-pr <pr-number>` above (resolve branch, fetch, create/refresh the detached
  worktree, run `humanTest.prepare`), then repoints the always-on studio's `active` symlink at that PR's worktree
  and restarts the `redeploy-app` systemd user service. `https://<STUDIO_HOSTNAME>` then serves that PR — no
  terminal needs to stay open, and it's immediately reachable from a phone.
- **`/test-pr --reset`** (alias: `--serve-main`; equivalently `bash .claude/scripts/prepare-pr.sh --reset`): points
  the always-on studio's `active` symlink back at the main checkout and restarts `redeploy-app`. Takes no PR
  number.

Both print `Open: https://$REDEPLOY_STUDIO_HOSTNAME` if that environment variable is set, otherwise a reminder to
set it. If no systemd user session / `redeploy-app` service exists on this machine (e.g. this sandbox, or CI),
both print a warning to restart it manually rather than failing.

**Existing behavior is unchanged**: plain `/test-pr <pr-number>` and `/test-pr <pr-number> --phone` behave exactly
as documented above — `--serve`/`--reset` are new, additive modes. If both `--serve` and `--phone` are passed,
`--serve` wins (the always-on tunnel supersedes the ephemeral quick-tunnel launch command).

See `docs/ALWAYS-ON-TUNNEL.md` for the full always-on setup (dedicated named tunnel, systemd units, Cloudflare
Access, the `active` symlink model) — this command only documents the `prepare-pr.sh` integration point.

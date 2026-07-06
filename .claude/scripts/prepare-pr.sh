#!/usr/bin/env bash
# prepare-pr.sh [--phone] <pr-number>
# prepare-pr.sh --serve <pr-number>
# prepare-pr.sh --reset | --serve-main
# Prepare a ready-to-run local checkout of an OPEN pull request so a human can
# manually test it, WITHOUT touching the main working tree. Idempotent.
#
#   1. Resolves the PR's head branch (via bot-gh.sh) and fetches it.
#   2. Creates or refreshes a DETACHED git worktree at <worktreeDir>/pr-<n>.
#      (Detached, not a named branch, so it never clashes with the same branch
#      already checked out in an agent worktree — git forbids that.)
#   3. Runs humanTest.prepare inside the worktree (install/build) if configured.
#   4. Prints the worktree path + the humanTest.launch command to run.
#
# Config (.claude/gates.json → "humanTest"):
#   prepare       shell cmd run IN the worktree to make it runnable (optional)
#   launch        shell cmd to start the app for manual testing (printed, optional)
#   launchPhone   shell cmd to start the app AND a public cloudflared tunnel for
#                 phone testing (printed instead of launch, opt-in, optional)
#   worktreeDir   parent dir for PR worktrees (optional, default ".worktrees")
#
# gh reads go through bot-gh.sh for consistent auth; git ops stay local.
#
# --phone / PHONE=1: opt-in "phone testing" mode. Behavior is otherwise
# BYTE-IDENTICAL to the default path — it only changes which launch command is
# printed at the end (humanTest.launchPhone instead of humanTest.launch) and
# prints a caveat block, because launchPhone exposes the dev studio (and its
# /api proxy) publicly over a cloudflared quick tunnel.
#
# --serve <pr-number>: runs the full default flow above (prepare the PR
# worktree), then repoints the always-on studio's ~/.local/share/redeploy/active
# symlink at that worktree and restarts the redeploy-app systemd --user service,
# so the always-on tunnel (docs/ALWAYS-ON-TUNNEL.md) starts serving the PR.
# --reset / --serve-main: repoints `active` back at this repo's main checkout
# and restarts redeploy-app. Does NOT require a PR number.
# If both --serve and --phone are given, --serve wins (see below).
set -uo pipefail

phone=0
serve=0
reset=0
rest=()
for arg in "$@"; do
  case "$arg" in
    --phone) phone=1 ;;
    --serve) serve=1 ;;
    --reset|--serve-main) reset=1 ;;
    *) rest+=("$arg") ;;
  esac
done
if [ -n "${PHONE:-}" ] && [ "$PHONE" != "0" ]; then
  phone=1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"
cd "$root"

# Stable symlink the always-on redeploy-app systemd --user service points its
# WorkingDirectory at (see docs/ALWAYS-ON-TUNNEL.md). --serve/--reset repoint it.
ACTIVE_LINK="$HOME/.local/share/redeploy/active"

# Restart the always-on app service, if one is configured on this machine.
# Guards failures instead of hard-failing: this script also runs in
# environments (CI, sandboxes) with no systemd user session at all.
restart_app_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "⚠️  systemctl not found — restart redeploy-app manually: systemctl --user restart redeploy-app" >&2
    return 0
  fi
  if ! systemctl --user restart redeploy-app 2>/dev/null; then
    echo "⚠️  could not restart redeploy-app via 'systemctl --user restart redeploy-app' — restart it manually." >&2
    return 0
  fi
  echo "▶ restarted redeploy-app"
}

# Print the hostname to open, if the operator has told us what it is.
print_hostname() {
  if [ -n "${REDEPLOY_STUDIO_HOSTNAME:-}" ]; then
    echo "Open: https://$REDEPLOY_STUDIO_HOSTNAME"
  else
    echo "(serving at your configured <STUDIO_HOSTNAME> — set REDEPLOY_STUDIO_HOSTNAME to have the"
    echo " full URL printed here. See docs/ALWAYS-ON-TUNNEL.md.)"
  fi
}

# --reset / --serve-main: point the always-on studio back at the main checkout.
# Short-circuits BEFORE the PR-number requirement below — no PR number needed.
if [ "$reset" = "1" ]; then
  mkdir -p "$(dirname "$ACTIVE_LINK")"
  ln -sfn "$root" "$ACTIVE_LINK"
  echo "▶ active -> $root (main checkout)"
  restart_app_service
  echo ""
  echo "✅ Always-on studio now serving the main checkout."
  print_hostname
  exit 0
fi

pr="${rest[0]:?usage: prepare-pr.sh [--phone] <pr-number> | --serve <pr-number> | --reset}"
case "$pr" in
  ''|*[!0-9]*) echo "prepare-pr: PR number must be numeric (got '$pr')" >&2; exit 2 ;;
esac

gates="$root/.claude/gates.json"
read_gate() {
  node -e "try{const g=require('$gates');process.stdout.write((g.humanTest&&g.humanTest['$1'])||'')}catch(e){process.stdout.write('')}" 2>/dev/null
}
prepare_cmd="$(read_gate prepare)"
launch_cmd="$(read_gate launch)"
launch_phone_cmd="$(read_gate launchPhone)"
wt_parent="$(read_gate worktreeDir)"; wt_parent="${wt_parent:-.worktrees}"

# Resolve the PR's head branch (gh through the bot wrapper for consistent auth).
branch="$("$script_dir/bot-gh.sh" pr view "$pr" --json headRefName -q .headRefName 2>/dev/null)"
if [ -z "$branch" ]; then
  echo "prepare-pr: could not resolve head branch for PR #$pr (is it open? is the bot token set?)" >&2
  exit 1
fi
echo "▶ PR #$pr → branch '$branch'"

git fetch origin "$branch" || { echo "prepare-pr: git fetch origin $branch failed" >&2; exit 1; }
sha="$(git rev-parse FETCH_HEAD)"

wt="$root/$wt_parent/pr-$pr"
if git worktree list --porcelain | grep -qxF "worktree $wt"; then
  echo "▶ refreshing existing worktree $wt → $sha"
  git -C "$wt" checkout -q --detach "$sha" || { echo "prepare-pr: could not update worktree" >&2; exit 1; }
else
  echo "▶ creating worktree $wt (detached at $sha)"
  mkdir -p "$root/$wt_parent"
  git worktree add -f --detach "$wt" "$sha" || { echo "prepare-pr: git worktree add failed" >&2; exit 1; }
fi

# Many apps read a gitignored repo-root .env at runtime (e.g. the deploy-server).
# A detached worktree has no .env, so symlink the main checkout's if present.
if [ -f "$root/.env" ] && [ ! -e "$wt/.env" ]; then
  ln -s "$root/.env" "$wt/.env" && echo "▶ linked $wt/.env → $root/.env"
fi

if [ -n "$prepare_cmd" ]; then
  echo "▶ prepare: $prepare_cmd"
  ( cd "$wt" && eval "$prepare_cmd" ) || { echo "prepare-pr: humanTest.prepare failed" >&2; exit 1; }
else
  echo "▶ humanTest.prepare not configured in gates.json — skipping deps/build"
fi

# --serve wins over --phone: they are different modes, and serving through the
# always-on tunnel supersedes printing a local/quick-tunnel launch command.
if [ "$serve" = "1" ]; then
  mkdir -p "$(dirname "$ACTIVE_LINK")"
  ln -sfn "$wt" "$ACTIVE_LINK"
  echo "▶ active -> $wt (PR #$pr)"
  restart_app_service
  echo ""
  echo "✅ Always-on studio now serving PR #$pr ($sha)."
  print_hostname
  echo ""
  echo "(The systemd redeploy-app service serves this now — no need to run humanTest.launch"
  echo " yourself. To go back to the main checkout: bash $script_dir/prepare-pr.sh --reset)"
  exit 0
fi

echo ""
echo "✅ PR #$pr is ready to test. In your terminal:"
echo "     cd $wt"
if [ "$phone" = "1" ]; then
  if [ -n "$launch_phone_cmd" ]; then
    echo "     $launch_phone_cmd"
    echo ""
    echo "⚠️  Phone testing mode — before you run this, know that:"
    echo "     1. The printed https://*.trycloudflare.com URL is PUBLIC while the tunnel is up —"
    echo "        anyone with the link can reach it, not just your phone."
    echo "     2. It exposes the dev studio AND its /api proxy, which can trigger REAL deploys"
    echo "        using whatever RPC URL / private keys are in your .env."
    echo "     3. It is ephemeral — the tunnel and both dev servers die together on Ctrl-C."
    echo "     4. It must be attended — don't leave it running unattended."
  else
    echo "     (humanTest.launchPhone not configured in gates.json — falling back to launch)"
    if [ -n "$launch_cmd" ]; then
      echo "     $launch_cmd"
    else
      echo "     (no humanTest.launch configured — start the app manually)"
    fi
  fi
else
  if [ -n "$launch_cmd" ]; then
    echo "     $launch_cmd"
  else
    echo "     (no humanTest.launch configured — start the app manually)"
  fi
fi
echo ""
echo "When done, tear it down with:  git worktree remove $wt"

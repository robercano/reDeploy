#!/usr/bin/env bash
# Run gh as the reDeploy bot account, so PRs are authored by the bot and the
# human owner can formally review/approve them (GitHub blocks PR authors from
# approving their own PRs). Token comes from GH_BOT_TOKEN in .env.
#
# Usage: .claude/scripts/bot-gh.sh pr create --title "..." --body "..."
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "$root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.env"
  set +a
fi
: "${GH_BOT_TOKEN:?GH_BOT_TOKEN not set — add it to .env (see .env.example)}"

export PATH="$HOME/.local/bin:$PATH"

# Preflight: the bot needs collaborator access to EACH (private) repo it acts on.
# Without it, gh fails with an opaque "Could not resolve to a Repository with the
# name '<owner>/<repo>'" that reads like a typo, not a missing grant. If a --repo
# target is given and the bot can't see it, print the exact grant + accept commands.
target_repo=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--repo" ]; then target_repo="$a"; break; fi
  case "$a" in
    --repo) prev="--repo"; continue;;
    --repo=*) target_repo="${a#--repo=}"; break;;
  esac
done
if [ -n "$target_repo" ] && ! GH_TOKEN="$GH_BOT_TOKEN" gh repo view "$target_repo" >/dev/null 2>&1; then
  bot="$(GH_TOKEN="$GH_BOT_TOKEN" gh api user --jq .login 2>/dev/null || echo '<bot>')"
  cat >&2 <<EOF
bot-gh.sh: bot account '$bot' cannot access '$target_repo' (private repo + not a collaborator?).
One-time setup — run as the repo OWNER, then accept the invite as the bot:
  gh api -X PUT repos/$target_repo/collaborators/$bot -f permission=push
  id=\$("$0" api user/repository_invitations --jq ".[] | select(.repository.full_name==\"$target_repo\") | .id")
  "$0" api -X PATCH user/repository_invitations/\$id
EOF
  exit 1
fi

GH_TOKEN="$GH_BOT_TOKEN" exec gh "$@"

#!/usr/bin/env bash
# Run gh as the reDeploy bot account, so PRs are authored by the bot and the
# human owner can formally review/approve them (GitHub blocks PR authors from
# approving their own PRs). Token comes from REDEPLOY_BOT_TOKEN in .env.
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
: "${REDEPLOY_BOT_TOKEN:?REDEPLOY_BOT_TOKEN not set — add it to .env (see .env.example)}"

export PATH="$HOME/.local/bin:$PATH"
GH_TOKEN="$REDEPLOY_BOT_TOKEN" exec gh "$@"

#!/usr/bin/env bash
# GitHub notification poll for robercano/reDeploy: prints new issues, PR review
# comments, issue-comments on PRs, and PR reviews since the cursor, then
# advances the cursor. Designed to be invoked by the notification cron job —
# pre-approved in .claude/settings.json so it never blocks on a permission
# prompt. Output is JSON sections for the model to summarize.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo="robercano/reDeploy"
state_dir="$root/.claude/state"
cursor_file="$state_dir/notify-cursor"

mkdir -p "$state_dir"
cursor=$(cat "$cursor_file" 2>/dev/null || date -u -d '30 minutes ago' +%FT%TZ)
now=$(date -u +%FT%TZ)
echo "CURSOR=$cursor NOW=$now"

echo "=== issues ==="
gh api "repos/$repo/issues?state=all&since=$cursor" \
  --jq '[.[] | select(.pull_request == null) | {n:.number,title:.title,user:.user.login,created:.created_at,updated:.updated_at,url:.html_url}]'

echo "=== pr review comments ==="
gh api "repos/$repo/pulls/comments?sort=updated&direction=desc&since=$cursor" \
  --jq '[.[] | {pr:.pull_request_url,user:.user.login,body:.body,updated:.updated_at,url:.html_url}]'

echo "=== issue-comments on PRs ==="
gh api "repos/$repo/issues/comments?sort=updated&direction=desc&since=$cursor" \
  --jq '[.[] | select(.html_url | contains("/pull/")) | {user:.user.login,body:.body,updated:.updated_at,url:.html_url}]'

echo "=== reviews on open PRs ==="
for n in $(gh pr list -R "$repo" --json number -q '.[].number'); do
  gh api "repos/$repo/pulls/$n/reviews" \
    --jq "[.[] | select(.submitted_at > \"$cursor\") | {pr:$n,user:.user.login,state:.state,body:.body,submitted:.submitted_at,url:.html_url}]"
done

echo "$now" > "$cursor_file"
echo "=== cursor advanced to $now ==="

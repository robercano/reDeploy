#!/usr/bin/env bash
# gate.sh <gate-name>
# Runs the command stored at .gates.<gate-name> in .claude/gates.json.
# Empty/missing command => skip with exit 0 (so pre-setup repos don't block).
# Non-zero command exit => propagates (so Stop hooks force the agent to keep working).
set -uo pipefail

key="${1:?usage: gate.sh <gate-name>}"
# Repo root is two levels up from this script (<root>/.claude/scripts/gate.sh) —
# robust whether or not we're nested inside another git repo.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"

# Dependency-freshness preflight. pnpm copies the resolved lockfile to
# node_modules/.pnpm/lock.yaml on every install, so a byte-diff against the
# working pnpm-lock.yaml is a fast, offline staleness check. When they differ,
# node_modules is behind the lockfile (e.g. a merged PR added a dependency like
# viem) and TS builds fail with opaque "Cannot find module" errors that print to
# STDOUT — leaving hooks to report an unhelpful "No stderr output". Surface the
# real cause on STDERR and stop early so the fix ('pnpm install') is obvious.
if [ -f "$root/pnpm-lock.yaml" ]; then
  installed_lock="$root/node_modules/.pnpm/lock.yaml"
  if [ ! -e "$installed_lock" ] || ! cmp -s "$root/pnpm-lock.yaml" "$installed_lock"; then
    echo "gate.sh: node_modules is out of sync with pnpm-lock.yaml — run 'pnpm install' (gate '$key' skipped)." >&2
    exit 1
  fi
fi

gates="$root/.claude/gates.json"

if [ ! -f "$gates" ]; then
  echo "gate.sh: no $gates found — skipping '$key'"; exit 0
fi

cmd="$(node -e "try{const g=require('$gates');process.stdout.write((g.gates&&g.gates['$key'])||'')}catch(e){process.stdout.write('')}" 2>/dev/null)"

if [ -z "$cmd" ]; then
  echo "gate.sh: gate '$key' not configured in gates.json — skipping"; exit 0
fi

echo "▶ gate '$key': $cmd"
cd "$root" && eval "$cmd"

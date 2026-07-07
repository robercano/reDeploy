#!/usr/bin/env bash
# deploy/always-on/install.sh
# One-time (idempotent, safe to re-run) installer for the always-on studio
# systemd --user units. Run this in a normal external terminal, NOT from
# inside the Claude Code sandbox — it writes under $HOME and talks to the
# systemd --user bus, neither of which the sandbox can reach.
#
# What this does:
#   1. Creates ~/.config/systemd/user if missing.
#   2. Copies this directory's unit templates into ~/.config/systemd/user/,
#      WITHOUT overwriting any copy you've already edited (see "idempotent
#      copy" below) — some of these templates still have placeholders
#      (<NODE_BIN_DIR>, <STUDIO_HOSTNAME>, <TUNNEL_UUID>) that only you can
#      fill in, so silently clobbering an edited copy would lose that work.
#   3. Creates the repo-local `.serve/` dir and points `.serve/active` at this
#      repo's own checkout (the "main checkout" default target) if the
#      symlink doesn't already exist.
#   4. Runs `systemctl --user daemon-reload`.
#   5. Enables + starts ONLY `redeploy-app.path` (the sentinel-watcher — safe
#      to enable unconditionally, it does nothing until the sentinel is
#      touched). It deliberately does NOT enable/start redeploy-app,
#      redeploy-anvil, or cloudflared-redeploy themselves, since those still
#      need their placeholders filled in first; this script prints the
#      remaining manual commands instead.
#
# Re-running this script is safe: steps 1, 3, 4, 5 are naturally idempotent;
# step 2 skips any unit file that already exists at the destination (printing
# a `.new` copy alongside instead, so you can diff and merge if the template
# changed upstream).
set -euo pipefail

# Resolve the repo root robustly from this script's own location:
# deploy/always-on/install.sh -> repo root is two levels up.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
units_src="$script_dir/systemd"
units_dst="$HOME/.config/systemd/user"

echo "▶ repo root: $repo_root"
echo "▶ systemd --user unit dir: $units_dst"

mkdir -p "$units_dst"

# Idempotent copy: never overwrite an existing (possibly hand-edited) unit.
# If the destination already exists, drop a `.new` copy alongside it instead,
# so the operator can diff/merge manually rather than silently losing edits.
copy_unit() {
  local name="$1"
  local src="$units_src/$name"
  local dst="$units_dst/$name"
  if [ ! -f "$src" ]; then
    echo "  ⚠️  skipping $name — not found at $src"
    return 0
  fi
  if [ -e "$dst" ]; then
    if cmp -s "$src" "$dst"; then
      echo "  = $name already installed and identical — skipping"
    else
      cp "$src" "$dst.new"
      echo "  ! $name already exists and differs — wrote $dst.new for you to diff/merge"
      echo "    (existing $dst left untouched, in case you've edited its placeholders)"
    fi
  else
    cp "$src" "$dst"
    echo "  + installed $name -> $dst"
    echo "    (edit placeholders in it before enabling, if any — see docs/ALWAYS-ON-TUNNEL.md)"
  fi
}

echo "▶ installing unit templates (skip-if-exists, .new alongside on conflict):"
copy_unit redeploy-anvil.service
copy_unit redeploy-app.service
copy_unit redeploy-app.path
copy_unit redeploy-app-restart.service
copy_unit cloudflared-redeploy.service

# Repo-local active symlink + sentinel dir. Default target is this repo's own
# checkout — the same thing `prepare-pr.sh --reset` points it back at.
serve_dir="$repo_root/.serve"
active_link="$serve_dir/active"
mkdir -p "$serve_dir"
if [ -e "$active_link" ] || [ -L "$active_link" ]; then
  echo "▶ $active_link already exists — leaving it as-is ($(readlink -f "$active_link" 2>/dev/null || echo '?'))"
else
  ln -sfn "$repo_root" "$active_link"
  echo "▶ created $active_link -> $repo_root"
fi

echo "▶ systemctl --user daemon-reload"
systemctl --user daemon-reload

echo "▶ enabling + starting redeploy-app.path (sentinel watcher — safe, does nothing until touched)"
systemctl --user enable --now redeploy-app.path

cat <<EOF

✅ install.sh done. Remaining MANUAL steps before the studio is actually reachable:

  1. Fill in placeholders in the installed unit files (if you haven't already):
       \$EDITOR $units_dst/redeploy-app.service         # <NODE_BIN_DIR>
       \$EDITOR $units_dst/cloudflared-redeploy.service # <STUDIO_HOSTNAME> etc (see docs)
     (redeploy-app.path / redeploy-app-restart.service / redeploy-anvil.service need no edits.)

  2. Create ~/.config/redeploy/env.anvil (see docs/ALWAYS-ON-TUNNEL.md section 5) if you
     haven't already.

  3. Enable + start the remaining services once placeholders are filled in:
       systemctl --user enable --now redeploy-anvil redeploy-app cloudflared-redeploy

  4. Keep services running after logout:
       loginctl enable-linger "\$USER"

See docs/ALWAYS-ON-TUNNEL.md for the full runbook.
EOF

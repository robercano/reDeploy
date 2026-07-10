# Always-on studio tunnel — templates

These are installable templates for running an always-on, Cloudflare Access-gated tunnel to the
reDeploy studio from a WSL2/Linux machine via `systemd --user` services. The authoritative runbook —
prerequisites, install steps, gotchas, and operations — lives at
[`docs/ALWAYS-ON-TUNNEL.md`](../../docs/ALWAYS-ON-TUNNEL.md). Start there; this directory just holds
the files it references.

All templates are parameterized — substitute `<STUDIO_HOSTNAME>`, `<TUNNEL_UUID>`, `<NODE_BIN_DIR>`,
etc. with your own values before installing. No file here contains real secrets or owner-specific
values.

`redeploy-app.service`'s `WorkingDirectory` points at a repo-local `.serve/active` symlink (not a
path under `$HOME/.local/share`), and restarts are driven by a systemd path unit
(`redeploy-app.path`) watching a `.serve/reload` sentinel file rather than a direct
`systemctl --user restart` call from the caller. This is what lets `/test-pr --serve`/`--reset`
(`.claude/scripts/prepare-pr.sh`) work from inside the Claude Code sandbox, where `$HOME` is
read-only and the systemd --user bus is unreachable: flipping the symlink and touching the sentinel
are both plain repo-local file writes, and systemd itself — running outside the sandbox — picks up
the sentinel change and does the actual restart. See
[`docs/ALWAYS-ON-TUNNEL.md`](../../docs/ALWAYS-ON-TUNNEL.md) for the full model.

## Files

- `systemd/redeploy-anvil.service` — local-only Anvil chain (127.0.0.1:8545), not exposed by the tunnel.
- `systemd/redeploy-app.service` — studio (:5173) + deploy-server (:8787); one of the tunnel's published
  origins. `WorkingDirectory` is the repo-local `.serve/active` symlink.
- `systemd/redeploy-website.service` — marketing website Vite dev server (:5180); the other published
  tunnel origin. Rides the same `.serve/active` symlink as `redeploy-app.service`.
- `systemd/redeploy-app.path` — watches `.serve/reload`; on change, triggers `redeploy-app-restart.service`.
  This is the restart mechanism `/test-pr --serve`/`--reset` relies on.
- `systemd/redeploy-app-restart.service` — oneshot unit that runs `systemctl --user restart redeploy-app`;
  triggered by `redeploy-app.path`, not started/enabled directly.
- `systemd/cloudflared-redeploy.service` — runs the named cloudflared tunnel with an explicit `--config`.
- `redeploy-studio.yml.example` — the dedicated cloudflared config for that tunnel: two ingress rules
  (studio at `<STUDIO_HOSTNAME>` -> :5173, website at `<WEBSITE_HOSTNAME>` -> :5180) plus credentials.
- `install.sh` — idempotent installer: copies the unit templates (including `redeploy-website.service`)
  into `~/.config/systemd/user/` (skip-if-exists — never clobbers an edited copy), creates `.serve/` +
  `.serve/active` (pointed at the repo's own checkout) if missing, and enables the `redeploy-app.path`
  sentinel watcher. Prints the remaining manual steps (placeholder edits, enabling the other services).
  Safe to re-run.

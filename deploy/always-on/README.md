# Always-on studio tunnel — templates

These are installable templates for running an always-on, Cloudflare Access-gated tunnel to the
reDeploy studio from a WSL2/Linux machine via `systemd --user` services. The authoritative runbook —
prerequisites, install steps, gotchas, and operations — lives at
[`docs/ALWAYS-ON-TUNNEL.md`](../../docs/ALWAYS-ON-TUNNEL.md). Start there; this directory just holds
the files it references.

All templates are parameterized — substitute `<STUDIO_HOSTNAME>`, `<TUNNEL_UUID>`, `<NODE_BIN_DIR>`,
etc. with your own values before installing. No file here contains real secrets or owner-specific
values.

## Files

- `systemd/redeploy-anvil.service` — local-only Anvil chain (127.0.0.1:8545), not exposed by the tunnel.
- `systemd/redeploy-app.service` — studio (:5173) + deploy-server (:8787); the tunnel's only published origin.
- `systemd/cloudflared-redeploy.service` — runs the named cloudflared tunnel with an explicit `--config`.
- `redeploy-studio.yml.example` — the dedicated cloudflared config for that tunnel (ingress rules, credentials).

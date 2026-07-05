# Always-on, authenticated reDeploy studio tunnel (WSL2 + systemd user services)

## 1. Overview

Goal: `https://<STUDIO_HOSTNAME>` reachable from your phone anytime the PC + WSL2 are up, behind a
Cloudflare Access login page, with the app pointed at a **local Anvil** chain (no real-money deploys
possible).

This is built from three `systemd --user` services (Anvil, the studio + deploy-server, and a named
`cloudflared` tunnel) plus a Cloudflare Access application in front of the hostname. Nothing here
requires `sudo` — everything runs as your own user via `systemd --user`.

Throughout this doc, substitute:

| Placeholder | Meaning |
|---|---|
| `<STUDIO_HOSTNAME>` | The hostname you want to expose, e.g. `studio.example.com` |
| `<TUNNEL_UUID>` | The UUID printed by `cloudflared tunnel create` (see step 3) |
| `<NODE_BIN_DIR>` | The directory containing your `node` binary (see step 6) |
| `redeploy-studio` | The tunnel name — a plain label; any name works, this doc uses this one throughout |

Templates referenced below live under [`deploy/always-on/`](../deploy/always-on/README.md).

## 2. Prerequisites

- A domain managed by Cloudflare (a "zone" in your Cloudflare account).
- `cloudflared` installed locally (`which cloudflared` to confirm; if missing, install it per
  Cloudflare's docs for your OS).
- One-time browser login authorizing the zone:
  ```
  cloudflared tunnel login
  ```
  This opens a browser to pick the zone and drops a cert under `~/.cloudflared/`.

## 3. Create a dedicated named tunnel

```
cloudflared tunnel create redeploy-studio
```

This prints a `TUNNEL_UUID` and writes credentials to `~/.cloudflared/<TUNNEL_UUID>.json`. Note the
UUID — you'll need it below.

Map DNS for the hostname to this tunnel:

```
cloudflared tunnel route dns --overwrite-dns <TUNNEL_UUID> <STUDIO_HOSTNAME>
```

> **GOTCHA — always pass an explicit tunnel identity.**
> A bare `cloudflared tunnel run`, `cloudflared tunnel route dns`, or `cloudflared tunnel info`
> (without `--config` and using just a tunnel *name*) reads `~/.cloudflared/config.yaml` and/or
> resolves the name against whatever tunnels exist in your account. If you already run **another**
> cloudflared tunnel on this machine (e.g. for a different app), a bare invocation can target the
> **wrong tunnel** — silently pointing DNS or traffic somewhere you didn't intend.
>
> Always operate on **this** tunnel explicitly: pass `--config <path-to-this-tunnel's-config>` (as
> the systemd unit below does), or address the tunnel by its **UUID**, not its name. This is exactly
> why the dedicated config file in step 4 is a separate file from `~/.cloudflared/config.yaml`, and
> why `cloudflared-redeploy.service` always passes `--config`.

## 4. The dedicated cloudflared config

Do **not** put this in `~/.cloudflared/config.yaml` (that file is the implicit default cloudflared
reads for bare `tunnel run`/`route dns`/`info` invocations — see the gotcha above). Instead install it
as its own file, e.g. `~/.cloudflared/redeploy-studio.yml`.

Template: [`deploy/always-on/redeploy-studio.yml.example`](../deploy/always-on/redeploy-studio.yml.example)

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: $HOME/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: <STUDIO_HOSTNAME>
    service: http://localhost:5173
    originRequest:
      httpHostHeader: localhost
  - service: http_status:404
```

Notes:
- `credentials-file` uses a literal `$HOME`-style absolute path (e.g. `/home/you/.cloudflared/...`),
  **not** the systemd `%h` token — this file is read directly by `cloudflared`, not by systemd, so
  `%h` would not be expanded. Substitute your real home directory and UUID.
- `originRequest.httpHostHeader: localhost` makes cloudflared send `Host: localhost` to the origin.
  Vite's dev-server `allowedHosts` guard only accepts requests whose `Host` header matches an allowed
  value; sending `localhost` satisfies it without any app-side config change. This is the same trick
  used by the ad-hoc quick-tunnel flow (`cloudflared tunnel --url ... --http-host-header localhost`,
  see `humanTest.launchPhone` in `.claude/gates.json`) — just applied to a persistent named tunnel
  instead of a one-off quick tunnel.
- The trailing catch-all `service: http_status:404` rejects any request for a hostname not explicitly
  listed above (cloudflared config requires a final catch-all rule).

Sanity-check the config before installing it as a service:

```
cloudflared tunnel --config ~/.cloudflared/redeploy-studio.yml ingress validate
```

## 5. Anvil-only env safety posture

Create a fixed, shared env file that the app service loads — **not** the repo's own `.env`, and
outside the repo entirely:

```
mkdir -p ~/.config/redeploy
cat > ~/.config/redeploy/env.anvil <<'EOF'
RPC_URL_SEPOLIA=http://127.0.0.1:8545
RPC_URL_MAINNET=http://127.0.0.1:8545
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ETHERSCAN_API_KEY=
EOF
```

`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` is Anvil's **well-known dev
account #0** — public and test-only, funded only on ephemeral local Anvil chains. It is safe to write
down; it controls no real funds anywhere.

Rules:
- `env.anvil` must point **only** at the local Anvil chain (`http://127.0.0.1:8545`) — never a real
  RPC endpoint.
- **Never** put a real private key in this file, ever.
- This file lives under `~/.config/redeploy/`, entirely outside the git repository, so it cannot be
  accidentally committed regardless of `.gitignore` contents. (The repo's own `.gitignore` already
  ignores `.env*` patterns for the in-repo `.env` used by normal local dev — this file is a separate,
  deliberately-outside-the-repo copy used only by the always-on service.)

## 6. The three systemd user units

Templates: [`deploy/always-on/systemd/`](../deploy/always-on/systemd/)

- **`redeploy-anvil.service`** — runs `anvil --host 127.0.0.1 --port 8545`. Local-only; never exposed
  through the tunnel.
- **`redeploy-app.service`** — runs the studio dev server (`:5173`, proxies `/api` to the
  deploy-server) and the deploy-server (`:8787`) in parallel. This is the tunnel's only published
  origin.
- **`cloudflared-redeploy.service`** — runs the named tunnel from step 3/4 via an explicit `--config`.

Install:

```
mkdir -p ~/.config/systemd/user
cp deploy/always-on/systemd/redeploy-anvil.service       ~/.config/systemd/user/
cp deploy/always-on/systemd/redeploy-app.service         ~/.config/systemd/user/
cp deploy/always-on/systemd/cloudflared-redeploy.service ~/.config/systemd/user/
# Edit the copies to substitute <STUDIO_HOSTNAME> / <NODE_BIN_DIR> placeholders.
$EDITOR ~/.config/systemd/user/redeploy-app.service
$EDITOR ~/.config/systemd/user/cloudflared-redeploy.service

systemctl --user daemon-reload
systemctl --user enable --now redeploy-anvil redeploy-app cloudflared-redeploy
loginctl enable-linger "$USER"
```

`loginctl enable-linger "$USER"` makes your user's systemd services start at boot and keep running
after you log out — **required** for "always-on" (without it, `systemctl --user` services stop the
moment your last login session ends).

> **GOTCHA — nvm-managed node is not on the systemd user-service PATH.**
> `systemd --user` services do not source your shell's `~/.bashrc`/`~/.zshrc`, so an nvm-managed
> `node`/`pnpm` (or a Foundry install added to `PATH` only in your shell profile) is invisible to
> them by default. `redeploy-app.service` pins a `PATH` explicitly:
> ```
> Environment=PATH=<NODE_BIN_DIR>:%h/.local/share/pnpm:%h/.foundry/bin:/usr/local/bin:/usr/bin:/bin
> ```
> Find your `<NODE_BIN_DIR>` with:
> ```
> dirname "$(which node)"
> ```
> If you later switch node versions via nvm, update this path — the old version's `bin` directory
> stops existing and the service will fail to start.

> **The `active` symlink model.** `redeploy-app.service` sets:
> ```
> WorkingDirectory=%h/.local/share/redeploy/active
> EnvironmentFile=%h/.config/redeploy/env.anvil
> ```
> `active` is a **stable symlink**, not a hardcoded repo path — the service always serves whatever
> checkout `active` currently points at. This lets you point the always-on studio at your main
> checkout normally, or temporarily at a PR worktree for review (see section 9), without ever editing
> the unit file. `env.anvil` (section 5) is a fixed, shared file outside any checkout, so it keeps
> working no matter what `active` points at.
>
> Initial setup:
> ```
> mkdir -p ~/.local/share/redeploy
> ln -sfn <path-to-your-main-checkout> ~/.local/share/redeploy/active
> ```

## 7. Cloudflare Access (the login page)

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an application → Self-hosted**.

- Application domain: `<STUDIO_HOSTNAME>`
- Session duration: your choice (e.g. 24h)
- Policy: **Allow**, Include → **Emails** → your email (one-time PIN), or wire up an identity
  provider (Google, GitHub, etc.)

Save. Now hitting `<STUDIO_HOSTNAME>` prompts a Cloudflare Access login before any request reaches the
tunnel/studio.

## 8. Use it

Open `https://<STUDIO_HOSTNAME>` on your phone → Cloudflare Access login → studio. Nothing needs to
stay open in a terminal; it all runs under `systemd --user` + linger.

## 9. Serving a PR through the always-on studio (`/test-pr --serve`)

The existing `/test-pr <n>` flow (`.claude/scripts/prepare-pr.sh`) prepares an isolated, detached
worktree for a PR for **local** human testing. `--serve` extends that so the **always-on** studio can
serve the PR too, without you needing a terminal open at all:

```
bash .claude/scripts/prepare-pr.sh --serve <n>
```

This runs the normal prepare flow (resolve branch, fetch, create/refresh the worktree, install/build)
and then repoints the `active` symlink at the PR's worktree and restarts `redeploy-app`, so
`https://<STUDIO_HOSTNAME>` now serves that PR.

To point it back at your main checkout:

```
bash .claude/scripts/prepare-pr.sh --reset
```

(`--serve-main` is accepted as an alias for `--reset`.)

Both commands read the `REDEPLOY_STUDIO_HOSTNAME` environment variable and print
`Open: https://$REDEPLOY_STUDIO_HOSTNAME` if it's set, so you get a direct link. Set it once in your
shell profile to your `<STUDIO_HOSTNAME>` value if you want that convenience.

See also `.claude/commands/test-pr.md` for the `/test-pr` command reference.

## 10. Operations

- **Pull + restart** (main checkout): `cd <checkout> && git pull && systemctl --user restart redeploy-app`
- **Stop everything**: `systemctl --user stop cloudflared-redeploy redeploy-app redeploy-anvil`
- **Disable at boot**:
  ```
  systemctl --user disable cloudflared-redeploy redeploy-app redeploy-anvil
  loginctl disable-linger "$USER"
  ```
- **Logs**: `journalctl --user -u <service> -e` (last entries) or `-f` (follow), e.g.
  `journalctl --user -u redeploy-app -f`.

## 11. Safety recap

- Only `:5173` (the studio dev server) is published through the tunnel.
- Anvil (`:8545`) and the deploy-server (`:8787`) are localhost-only — reachable only via the
  studio's `/api` proxy, never directly from the internet.
- `env.anvil` keeps every deploy on a throwaway local Anvil chain, so even a compromised or
  accidentally-shared link can't spend real funds or touch a real network.
- Cloudflare Access gates the entire hostname — no request reaches the tunnel without a passing
  identity check first.

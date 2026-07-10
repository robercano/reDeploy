# Always-on, authenticated reDeploy studio tunnel (WSL2 + systemd user services)

## 1. Overview

Goal: `https://<STUDIO_HOSTNAME>` reachable from your phone anytime the PC + WSL2 are up, behind a
Cloudflare Access login page, with the app pointed at a **local Anvil** chain (no real-money deploys
possible). The same named tunnel also publishes a second hostname, `https://<WEBSITE_HOSTNAME>`, which
routes to the marketing website's Vite dev server on `:5180` — also gated by Cloudflare Access.

This is built from four `systemd --user` services (Anvil, the studio + deploy-server, the marketing
website, and a named `cloudflared` tunnel), a `systemd --user` path unit + oneshot restart service (the
sentinel-driven restart mechanism, see section 6/9), plus a Cloudflare Access application in front of
each hostname. Nothing here requires `sudo` — everything runs as your own user via `systemd --user`.

Throughout this doc, substitute:

| Placeholder | Meaning |
|---|---|
| `<STUDIO_HOSTNAME>` | The hostname you want to expose for the studio, e.g. `studio.example.com` |
| `<WEBSITE_HOSTNAME>` | The hostname you want to expose for the marketing website, e.g. `www.example.com` |
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

Map DNS for the hostname to this tunnel. Since a single named tunnel can publish multiple hostnames
(see the two ingress rules in step 4), run this once per hostname — both `<STUDIO_HOSTNAME>` and
`<WEBSITE_HOSTNAME>` route to the same `<TUNNEL_UUID>`:

```
cloudflared tunnel route dns --overwrite-dns <TUNNEL_UUID> <STUDIO_HOSTNAME>
cloudflared tunnel route dns --overwrite-dns <TUNNEL_UUID> <WEBSITE_HOSTNAME>
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

```
cp deploy/always-on/redeploy-studio.yml.example ~/.cloudflared/redeploy-studio.yml
# Edit the copy to substitute <TUNNEL_UUID> / $HOME / <STUDIO_HOSTNAME> placeholders.
$EDITOR ~/.cloudflared/redeploy-studio.yml
```

Contents (for reference — this is what the template above contains):

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: $HOME/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: <STUDIO_HOSTNAME>
    service: http://localhost:5173
    originRequest:
      httpHostHeader: localhost
  - hostname: <WEBSITE_HOSTNAME>
    service: http://localhost:5180
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
- The `<WEBSITE_HOSTNAME>` rule routes to `localhost:5180` — the marketing website's Vite dev server
  (`redeploy-website.service`, see section 6). Same `httpHostHeader: localhost` trick applies, since
  it's also a Vite dev server with the same `allowedHosts` guard.
- The trailing catch-all `service: http_status:404` rejects any request for a hostname not explicitly
  listed above (cloudflared config requires a final catch-all rule) — it must stay **last**; ingress
  rules are matched top-to-bottom.

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
RPC_URL=http://127.0.0.1:8545
RPC_URL_SEPOLIA=http://127.0.0.1:8545
RPC_URL_MAINNET=http://127.0.0.1:8545
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ETHERSCAN_API_KEY=
EOF
```

`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` is Anvil's **well-known dev
account #0** — public and test-only, funded only on ephemeral local Anvil chains. It is safe to write
down; it controls no real funds anywhere.

`RPC_URL` is the variable the deploy-server actually reads (default `http://127.0.0.1:8545` if unset);
`RPC_URL_SEPOLIA`/`RPC_URL_MAINNET` are kept alongside it as belt-and-suspenders for any other tooling
that reads the per-chain names. Setting `RPC_URL` explicitly here — rather than relying on the
deploy-server's own default — keeps the "throwaway local Anvil chain" guarantee true even if the
deploy-server's default ever changes.

Rules:
- `env.anvil` must point **only** at the local Anvil chain (`http://127.0.0.1:8545`) — never a real
  RPC endpoint.
- **Never** put a real private key in this file, ever.
- This file lives under `~/.config/redeploy/`, entirely outside the git repository, so it cannot be
  accidentally committed regardless of `.gitignore` contents. (The repo's own `.gitignore` already
  ignores `.env*` patterns for the in-repo `.env` used by normal local dev — this file is a separate,
  deliberately-outside-the-repo copy used only by the always-on service.)

## 6. The systemd user units

Templates: [`deploy/always-on/systemd/`](../deploy/always-on/systemd/)

- **`redeploy-anvil.service`** — runs `anvil --host 127.0.0.1 --port 8545`. Local-only; never exposed
  through the tunnel.
- **`redeploy-app.service`** — runs the studio dev server (`:5173`, proxies `/api` to the
  deploy-server) and the deploy-server (`:8787`) in parallel. This is one of the tunnel's two published
  origins. Its `WorkingDirectory` is the repo-local `.serve/active` symlink (see "The active symlink
  model" below).
- **`redeploy-website.service`** — runs the marketing website's Vite dev server (`:5180`). This is the
  tunnel's other published origin. Its `WorkingDirectory` is the SAME repo-local `.serve/active`
  symlink `redeploy-app.service` uses, so `/test-pr --serve`/`--reset` repoint the served checkout for
  the website too (see section 9). Unlike `redeploy-app.service`, it has no `EnvironmentFile=` — the
  website is a static marketing site with no backend, no RPC, no keys.
- **`redeploy-app.path`** — a path unit that watches the repo-local `.serve/reload` sentinel file
  (`PathModified=`) and triggers `redeploy-app-restart.service` whenever it changes.
- **`redeploy-app-restart.service`** — a `Type=oneshot` unit, triggered only by `redeploy-app.path`,
  whose `ExecStart` runs `systemctl --user restart redeploy-app`.
- **`cloudflared-redeploy.service`** — runs the named tunnel from step 3/4 via an explicit `--config`.

The easiest way to install these is the provided script:

```
bash deploy/always-on/install.sh
```

It copies the unit templates into `~/.config/systemd/user/` (without overwriting any copy you've
already edited), creates the repo-local `.serve/` dir + `.serve/active` symlink (pointed at this
checkout) if missing, runs `daemon-reload`, and enables + starts `redeploy-app.path` (the sentinel
watcher — harmless to enable early, since it does nothing until the sentinel is touched). It then
prints the remaining manual steps below. Safe to re-run any time.

Equivalent manual steps, if you'd rather do it by hand (or to fill in the placeholders `install.sh`
leaves for you):

```
mkdir -p ~/.config/systemd/user
cp deploy/always-on/systemd/redeploy-anvil.service         ~/.config/systemd/user/
cp deploy/always-on/systemd/redeploy-app.service           ~/.config/systemd/user/
cp deploy/always-on/systemd/redeploy-website.service       ~/.config/systemd/user/
cp deploy/always-on/systemd/redeploy-app.path              ~/.config/systemd/user/
cp deploy/always-on/systemd/redeploy-app-restart.service   ~/.config/systemd/user/
cp deploy/always-on/systemd/cloudflared-redeploy.service   ~/.config/systemd/user/
# Edit the copies to substitute <STUDIO_HOSTNAME> / <WEBSITE_HOSTNAME> / <NODE_BIN_DIR> placeholders.
$EDITOR ~/.config/systemd/user/redeploy-app.service
$EDITOR ~/.config/systemd/user/redeploy-website.service
$EDITOR ~/.config/systemd/user/cloudflared-redeploy.service

# redeploy-app.service's WorkingDirectory is
# %h/Development/thesolidchain/reDeploy/.serve/active — a stable symlink LIVING
# INSIDE the repo checkout, not a hardcoded repo path (see "The active symlink
# model" below). It MUST exist before the app service is enabled/started, or the
# service will fail to find its WorkingDirectory.
mkdir -p <path-to-your-repo-checkout>/.serve
ln -sfn <path-to-your-repo-checkout> <path-to-your-repo-checkout>/.serve/active

systemctl --user daemon-reload
systemctl --user enable --now redeploy-anvil redeploy-app redeploy-website redeploy-app.path cloudflared-redeploy
loginctl enable-linger "$USER"
```

`loginctl enable-linger "$USER"` makes your user's systemd services start at boot and keep running
after you log out — **required** for "always-on" (without it, `systemctl --user` services stop the
moment your last login session ends).

> **GOTCHA — nvm-managed node is not on the systemd user-service PATH.**
> `systemd --user` services do not source your shell's `~/.bashrc`/`~/.zshrc`, so an nvm-managed
> `node`/`pnpm` (or a Foundry install added to `PATH` only in your shell profile) is invisible to
> them by default. `redeploy-app.service` (and `redeploy-website.service`, the same way) pins a `PATH`
> explicitly:
> ```
> Environment=PATH=<NODE_BIN_DIR>:%h/.local/share/pnpm:%h/.foundry/bin:/usr/local/bin:/usr/bin:/bin
> ```
> Find your `<NODE_BIN_DIR>` with:
> ```
> dirname "$(which node)"
> ```
> If you later switch node versions via nvm, update this path — the old version's `bin` directory
> stops existing and the service will fail to start.

> **The `active` symlink + `.serve/reload` sentinel model.** `redeploy-app.service` sets:
> ```
> WorkingDirectory=%h/Development/thesolidchain/reDeploy/.serve/active
> EnvironmentFile=%h/.config/redeploy/env.anvil
> ```
> `redeploy-website.service` sets the same `WorkingDirectory=` (it has no `EnvironmentFile=`, since the
> website needs no backend env).
> `active` is a **stable symlink**, not a hardcoded repo path — the service always serves whatever
> checkout `active` currently points at. This lets you point the always-on studio at your main
> checkout normally, or temporarily at a PR worktree for review (see section 9), without ever editing
> the unit file. `env.anvil` (section 5) is a fixed, shared file outside any checkout, so it keeps
> working no matter what `active` points at.
>
> Unlike the original design, `active` lives **inside the repo checkout** (`.serve/active`, gitignored)
> rather than under `~/.local/share/redeploy/`. This is deliberate: it makes the whole flip-and-restart
> flow drivable from inside the Claude Code sandbox, which mounts `$HOME` read-only and can't reach the
> systemd --user bus at all. Both control points `/test-pr --serve`/`--reset` touch —
> `.serve/active` (a symlink flip) and `.serve/reload` (a sentinel file touch) — are ordinary
> repo-local filesystem writes, so they work from the sandbox even though `systemctl` doesn't.
>
> The restart itself is delegated to systemd: `redeploy-app.path` (installed on the host, outside the
> sandbox) watches `.serve/reload` with `PathModified=` and triggers `redeploy-app-restart.service`
> (a oneshot `systemctl --user restart redeploy-app`) whenever the sentinel changes. Since systemd runs
> as a normal host process, it always has bus access — even when the process that touched the sentinel
> didn't. `prepare-pr.sh` still attempts a direct `systemctl --user restart redeploy-app` too, as a
> best-effort immediate fallback for anyone running it from a normal terminal, but that attempt is no
> longer required to succeed.
>
> The `.serve/active` symlink must exist **before** `redeploy-app` or `redeploy-website` is
> enabled/started — see the `ln -sfn` step in the Install block above (or just run
> `deploy/always-on/install.sh`, which creates it for you).

## 7. Cloudflare Access (the login page)

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an application → Self-hosted**.
Repeat this for **both** hostnames — `<STUDIO_HOSTNAME>` and `<WEBSITE_HOSTNAME>` — either as two
separate Access applications, or as a single application whose domain list includes both, so that
neither hostname is left ungated.

- Application domain: `<STUDIO_HOSTNAME>` (and, for the second application, `<WEBSITE_HOSTNAME>`)
- Session duration: your choice (e.g. 24h)
- Policy: **Allow**, Include → **Emails** → your email (one-time PIN), or wire up an identity
  provider (Google, GitHub, etc.)

Save. Now hitting `<STUDIO_HOSTNAME>` or `<WEBSITE_HOSTNAME>` prompts a Cloudflare Access login before
any request reaches the tunnel/studio/website.

## 8. Use it

Open `https://<STUDIO_HOSTNAME>` on your phone → Cloudflare Access login → studio. `https://<WEBSITE_HOSTNAME>`
works the same way for the marketing website. Nothing needs to stay open in a terminal; it all runs
under `systemd --user` + linger.

## 9. Serving a PR through the always-on studio (`/test-pr --serve`)

The existing `/test-pr <n>` flow (`.claude/scripts/prepare-pr.sh`) prepares an isolated, detached
worktree for a PR for **local** human testing. `--serve` extends that so the **always-on** studio can
serve the PR too, without you needing a terminal open at all:

```
bash .claude/scripts/prepare-pr.sh --serve <n>
```

> **Run `--serve`/`--reset` from your MAIN checkout, not a PR worktree.** The path unit's
> `PathModified=` watch and `redeploy-app.service`'s `WorkingDirectory` are hardcoded to
> `%h/Development/thesolidchain/reDeploy/.serve/...` (see section 6) — invoking `--serve`/`--reset`
> from the copy of this script inside a PR worktree would flip a `.serve/active` symlink and touch a
> `.serve/reload` sentinel that nothing is watching, a silent no-op.

This runs the normal prepare flow (resolve branch, fetch, create/refresh the worktree, install/build)
and then repoints the repo-local `.serve/active` symlink at the PR's worktree and touches the
`.serve/reload` sentinel file, so `https://<STUDIO_HOSTNAME>` ends up serving that PR once
`redeploy-app.path` (watching the sentinel) triggers `redeploy-app-restart.service` to restart
`redeploy-app`. Both the symlink flip and the sentinel touch are plain repo-local file writes — no
`$HOME` writes, no systemd --user bus calls required from the script itself — which is what makes
`--serve`/`--reset` **drivable from inside the Claude Code sandbox** (where `$HOME` is read-only
EROFS and the systemd --user bus is unreachable). The script also attempts a direct
`systemctl --user restart redeploy-app` as a best-effort immediate fallback (useful when run from a
normal terminal with bus access), but that attempt failing is expected and harmless in the sandbox —
the sentinel-driven restart via `redeploy-app.path` still happens.

To point it back at your main checkout:

```
bash .claude/scripts/prepare-pr.sh --reset
```

(`--serve-main` is accepted as an alias for `--reset`.)

Both commands read the `REDEPLOY_STUDIO_HOSTNAME` environment variable and print
`Open: https://$REDEPLOY_STUDIO_HOSTNAME` if it's set, so you get a direct link. Set it once in your
shell profile to your `<STUDIO_HOSTNAME>` value if you want that convenience.

See also `.claude/commands/test-pr.md` for the `/test-pr` command reference.

> **The website rides the same symlink.** `redeploy-website.service`'s `WorkingDirectory` is the SAME
> repo-local `.serve/active` symlink `redeploy-app.service` uses (see section 6), so `--serve`/`--reset`
> switch the checkout the website is served from too, not just the studio's. Note, though, that the
> sentinel-driven auto-restart (`redeploy-app.path` → `redeploy-app-restart.service`) only restarts
> `redeploy-app`; if you need `redeploy-website` itself to pick up the newly-pointed checkout
> immediately, restart it explicitly: `systemctl --user restart redeploy-website`.

## 10. Operations

- **Pull + restart** (main checkout): `cd <checkout> && git pull && systemctl --user restart redeploy-app`
  (or `touch .serve/reload` to trigger the same restart via the path unit).
- **Restarts are not instant.** Every restart of `redeploy-app` — whether via a direct
  `systemctl --user restart redeploy-app`, the sentinel-driven path (`touch .serve/reload` →
  `redeploy-app.path` → `redeploy-app-restart.service`), or `/test-pr --serve`/`--reset` (section 9,
  which does both) — re-runs the full `ExecStartPre` (`pnpm install` + the core/config/reader/deploy-server
  build) before the app comes back up. Expect tens of seconds to a couple of minutes, not an instant
  restart. This rebuild is intentional, not a bug: it guarantees there's never a stale `dist/` when
  `active` switches checkouts — whatever checkout `active` now points at is always compiled before it
  starts serving. `redeploy-app.service` sets `TimeoutStartSec=0` (see
  `deploy/always-on/systemd/redeploy-app.service`) specifically so this slower cold/PR-switch rebuild is
  never killed for taking "too long" to start.
- **The path unit is the restart mechanism now, not just a convenience.** `/test-pr --serve`/`--reset`
  no longer depend on a working systemd --user bus connection from wherever they're invoked; they only
  need to flip `.serve/active` and touch `.serve/reload`. `redeploy-app.path` (running on the host)
  notices the sentinel change and does the actual restart via `redeploy-app-restart.service`. A direct
  `systemctl --user restart redeploy-app` still works fine from a normal terminal and remains the
  fastest single command for a manual restart.
- **Stop everything**: `systemctl --user stop cloudflared-redeploy redeploy-app redeploy-website redeploy-app.path redeploy-anvil`
- **Disable at boot**:
  ```
  systemctl --user disable cloudflared-redeploy redeploy-app redeploy-website redeploy-app.path redeploy-anvil
  loginctl disable-linger "$USER"
  ```
- **Logs**: `journalctl --user -u <service> -e` (last entries) or `-f` (follow), e.g.
  `journalctl --user -u redeploy-app -f`, `journalctl --user -u redeploy-website -f`, or
  `journalctl --user -u redeploy-app-restart -e` (to confirm the sentinel-triggered restart actually ran).

## 11. Safety recap

- Only `:5173` (the studio dev server) and `:5180` (the marketing website dev server) are published
  through the tunnel, as two separate ingress rules on the same named tunnel.
- Anvil (`:8545`) and the deploy-server (`:8787`) are localhost-only — reachable only via the
  studio's `/api` proxy, never directly from the internet.
- `env.anvil` keeps every deploy on a throwaway local Anvil chain, so even a compromised or
  accidentally-shared link can't spend real funds or touch a real network.
- Cloudflare Access gates BOTH hostnames (`<STUDIO_HOSTNAME>` and `<WEBSITE_HOSTNAME>`) — no request
  reaches the tunnel without a passing
  identity check first.

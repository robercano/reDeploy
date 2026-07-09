# Runbook: local REAL deploy against Anvil

A step-by-step guide to running a **real** deploy (broadcast on-chain, via `POST /api/deploy`) against a local
Anvil node — using the deploy-server directly (curl) and via the studio's UI.

## 1. Prerequisites
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`anvil`, `forge`) on PATH.
- `pnpm` (workspace package manager).
- `pnpm install` from the repo root.

## 2. Build contract artifacts
From the repo root:
```bash
cd contracts && forge build
```
This produces `contracts/out`, the Foundry artifacts directory the deploy-server resolves contracts from
(`FOUNDRY_OUT`, default `<repo>/contracts/out`).

## 3. Start Anvil
```bash
anvil
```
Anvil listens on `http://127.0.0.1:8545` by default and prints a list of funded dev accounts along with their
private keys on startup. Leave it running in its own terminal.

## 4. Configure `.env`
Copy the example env file at the repo root and fill in the local-deploy values:
```bash
cp .env.example .env
```
Set (or confirm) in `.env`:
```
RPC_URL=http://127.0.0.1:8545
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

> **Security note:** `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` is Anvil's
> well-known **first dev account** private key. It is **publicly known and unfunded on any real network** —
> it is safe to use here for local testing only. **Never** use it (or any key copied from this file) on a real
> network, and never commit a real secret key to `.env` (it is gitignored; only `.env.example` is tracked).

`FOUNDRY_OUT` can stay unset — it defaults to `<repo>/contracts/out`, which matches the artifacts produced in
step 2.

The deploy-server loads this repo-root `.env` on startup. Real process environment variables always take
precedence over the file, so you can also export these instead of (or in addition to) editing `.env`.

## 5. Build and run the deploy-server (and, optionally, the studio)
The deploy-server's `dev` script runs a prebuilt `dist/index.js`, so build it first:
```bash
pnpm -F @redeploy/deploy-server build && pnpm -F @redeploy/deploy-server dev
```
It listens on `127.0.0.1:8787` by default (override with `PORT`/`HOST`).

Optionally, also run the studio (`:5173`; its Vite dev server proxies `/api` to `:8787`):
```bash
pnpm -F @redeploy/studio dev
```

Or run both together with the combined command:
```bash
pnpm -r --parallel --filter @redeploy/deploy-server --filter @redeploy/studio dev
```

## 6. Deploy via the studio
1. Open http://localhost:5173.
2. Author or select a `DeploymentSpec` on the canvas.
3. Click **`Deploy (simulate)`** to preview the plan (plan-only, no chain writes; shows `Simulating…` while in
   flight).
4. Click **`Deploy (real)`**, confirm in the modal that appears (this action is irreversible — it broadcasts
   transactions to Anvil), and watch the read-only Inspector render deployed contract addresses, constructor
   args, and config-step status once the deploy completes.

## 7. curl smoke test (headless / pre-studio)
You can exercise the deploy-server directly against its SSE endpoints without the studio. Create a
`spec.json` containing your `DeploymentSpec`, then:

**Simulate (plan-only, no chain writes):**
```bash
curl -N -X POST http://127.0.0.1:8787/api/simulate \
  -H 'Content-Type: application/json' \
  -d @spec.json
```

**Real deploy (broadcasts on Anvil):**
```bash
curl -N -X POST http://127.0.0.1:8787/api/deploy \
  -H 'Content-Type: application/json' \
  -d @spec.json
```

`-N` disables curl's output buffering so the SSE frames stream to your terminal as they're emitted rather than
all at once at the end.

Expected frames:
- `/api/simulate`: zero or more `event: step` frames (one per planned step, each augmented with
  `address: null`), then a terminal `event: done` frame — `data: {"success":true}` or
  `data: {"success":false,"errors":[...]}`.
- `/api/deploy`: an `event: progress` frame (`data: {"phase":"deploying"}`), then a terminal `event: done`
  frame — `data: {"success":true,"deployment":{...}}` (optionally with a `warning`) or
  `data: {"success":false,"errors":[{"message":"..."}]}`.

As noted in step 4, the deploy-server reads `.env` at repo root on startup, so `DEPLOYER_PRIVATE_KEY` and
`RPC_URL` come from there unless overridden by the real process environment.

**Optional extra checks:**
```bash
# Current deployment state (read-only; empty view if nothing deployed yet)
curl http://127.0.0.1:8787/api/deployment

# Liveness
curl http://127.0.0.1:8787/health
```

## 8. Troubleshooting & security
- **Never commit `.env`** — it's gitignored; only `.env.example` (with empty/placeholder values) is tracked.
- The Anvil dev key above is **public and unfunded on real chains** — deploying to a real network with it would
  be immediately unsafe; always use a dedicated secret for anything beyond local Anvil testing.
- The deploy-server **binds to loopback (`127.0.0.1`) by default** — it will hold RPC/key-derived state, so
  only set `HOST` to a non-loopback address deliberately and with care.
- If `POST /api/deploy` returns `done{success:false, errors:[{"message":"DEPLOYER_PRIVATE_KEY is not
  configured"}]}`, confirm `.env` is present at the repo root and `DEPLOYER_PRIVATE_KEY` is set (or exported in
  your shell).

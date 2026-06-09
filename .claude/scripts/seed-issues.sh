#!/usr/bin/env bash
# seed-issues.sh — create the reDeploy ticket backlog as GitHub Issues + labels.
# Idempotent: existing labels are reused; an issue whose exact title already
# exists is skipped, so re-running won't create duplicates.
#
# Prereq: `gh auth login` completed for robercano/reDeploy.
# Usage:  bash .claude/scripts/seed-issues.sh
set -uo pipefail

command -v gh >/dev/null 2>&1 || { echo "gh not on PATH. Try: export PATH=\"\$HOME/.local/bin:\$PATH\""; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not authenticated. Run: gh auth login"; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo robercano/reDeploy)"
echo "Seeding issues into $REPO"

# --- labels: name|color|description -----------------------------------------
labels=(
  "module:contracts|5319e7|Foundry sample/fixture contracts"
  "module:core|1d76db|@redeploy/core deployment engine"
  "module:config|0e8a16|@redeploy/config post-deploy configuration"
  "module:verify|fbca04|@redeploy/verify verification"
  "module:reader|d4c5f9|@redeploy/reader read-only state library"
  "module:studio|c2e0c6|@redeploy/studio visual tool"
  "type:infra|b60205|Repo-wide tooling/infra (touches root config)"
  "type:feature|0052cc|Feature work scoped to one module"
)
for l in "${labels[@]}"; do
  IFS='|' read -r name color desc <<<"$l"
  gh label create "$name" --color "$color" --description "$desc" --force >/dev/null 2>&1 \
    && echo "  label ✓ $name" || echo "  label … $name (exists)"
done

# --- helper: create an issue unless an exact-title match already exists ------
existing="$(gh issue list --repo "$REPO" --state all --limit 500 --json title -q '.[].title' 2>/dev/null)"
mkissue() {
  local title="$1" labels="$2" body="$3"
  if grep -Fxq "$title" <<<"$existing"; then
    echo "  skip (exists): $title"; return
  fi
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" >/dev/null \
    && echo "  created: $title" || echo "  FAILED: $title"
}

BOUND="**Module boundary:** stay within this module's path; do not edit other modules or root config (re-scope through the orchestrator if needed)."

# ============================ TICKETS =======================================

mkissue "[infra] Wire TS lint (eslint) + Solidity solhint into the lint gate" "type:infra" \
"Add eslint + typescript-eslint (flat config) for all TS packages and solhint for contracts. Update \`.claude/gates.json\` \`lint\` to run both alongside \`forge fmt --check\`.

This is a repo-wide infra task (touches root config) — run it as a single bootstrap task, not a module worker.

**Acceptance**
- \`pnpm -r lint\` runs eslint across packages/apps with zero warnings on the current skeleton.
- solhint runs over \`contracts/src\` and \`contracts/test\`.
- \`bash .claude/scripts/gate.sh lint\` passes and includes TS + Solidity linting."

mkissue "[contracts] Realistic interconnected fixture contracts + forge-std tests" "module:contracts,type:feature" \
"Replace the placeholder \`Registry\` with a small but realistic interconnected set (e.g. Token, Vault referencing Token, Registry wiring them) that exercises constructor links AND post-deploy configuration surface (setters / access-control roles). Install forge-std and migrate tests to \`forge-std/Test\`.

$BOUND

**Acceptance**
- forge-std installed; \`forge build\` and \`forge test\` green.
- Contracts expose both constructor dependencies and at least one post-deploy config step (setter/role).
- Tests cover the wiring and the config surface."

mkissue "[core] Declarative deployment spec schema + validation" "module:core,type:feature" \
"Define the TS types and a runtime validator (e.g. zod) for a deployment spec: contracts, constructor args, inter-contract links (output of A → constructor input of B), and explicit/implied ordering.

$BOUND

**Acceptance**
- Typed spec + validator with clear errors for cycles, missing refs, bad args.
- Unit tests covering valid specs and each failure mode; coverage ≥ 80%."

mkissue "[core] Compile a deployment spec into a Hardhat Ignition module" "module:core,type:feature" \
"Translate a validated spec into a Hardhat Ignition module (futures, \`m.contract\`, dependency wiring, ordering). Reuse Ignition's engine — don't reinvent ordering.

$BOUND

**Acceptance**
- Given a spec referencing the \`contracts\` fixtures, produce a valid Ignition module.
- Tests assert the generated module's futures/links/order match the spec."

mkissue "[core] Idempotent resume via Ignition's journal" "module:core,type:feature" \
"Expose a \`deploy()\` that runs the generated Ignition module and relies on Ignition's journal so an already-deployed contract is never re-deployed; a partial deployment resumes only the missing contracts.

$BOUND

**Acceptance**
- Against a local node (anvil/hardhat), running a partial deployment then re-running deploys only what's missing.
- Test simulates an interrupted deployment and asserts no re-deploys on resume."

mkissue "[config] Declarative post-deployment configuration steps + schema" "module:config,type:feature" \
"Define a typed, declarative schema for post-deploy configuration steps (e.g. setX, grantRole, wire A into B), referencing deployed contracts from a deployment.

$BOUND

**Acceptance**
- Typed config schema + validator (refs resolve to deployed contracts).
- Unit tests for valid configs and failure modes; coverage ≥ 80%."

mkissue "[config] Resumable, idempotent config execution with per-step state" "module:config,type:feature" \
"Execute config steps with per-step state tracking so re-running skips completed steps and resumes a broken/partial configuration. Mirror Ignition's journal idea for config state.

$BOUND

**Acceptance**
- Against a local node, interrupting mid-config then re-running completes only the remaining steps.
- Idempotent: a fully-applied config re-run is a no-op. Tested."

mkissue "[reader] Read-only API for deployment + config state" "module:reader,type:feature" \
"Provide a typed, read-only library that loads deployment state (addresses, constructor args, links) and per-step config status from the Ignition deployment dir / journal, and exposes it for external systems.

$BOUND

**Acceptance**
- Typed API returns contracts, addresses, links, and config-step status for a given deployment id.
- Tests run against a fixture deployment directory; coverage ≥ 80%."

mkissue "[verify] Source/bytecode verification (Etherscan/Sourcify)" "module:verify,type:feature" \
"Integrate source/bytecode verification for a deployment's contracts via Etherscan/Sourcify.

$BOUND

**Acceptance**
- A verify entry point that submits each deployed contract for verification.
- Tests mock the verifier API and assert correct payloads/handling of already-verified contracts."

mkissue "[verify] On-chain configuration verification (drift detection)" "module:verify,type:feature" \
"Assert that live on-chain configuration matches the declared config spec; report drift (expected vs actual) per step.

$BOUND

**Acceptance**
- Against a local node, a matching config verifies clean; a mutated value is reported as drift.
- Tests cover match and drift cases."

mkissue "[studio] Scaffold studio app (React + Vite + React Flow)" "module:studio,type:feature" \
"Replace the placeholder package with a React + Vite app using React Flow; wire \`build\`/\`test\`/\`typecheck\` scripts to match the gates; render an empty canvas.

$BOUND

**Acceptance**
- \`pnpm --filter @redeploy/studio build\` and \`test\` pass with the new toolchain.
- App renders an empty React Flow canvas; one component test."

mkissue "[studio] Drag-and-drop authoring → reDeploy spec file" "module:studio,type:feature" \
"Let users place contract nodes, connect an output to another contract's constructor/config input, edit config, and serialize the graph to a reDeploy spec file consumable by core/config.

$BOUND

**Acceptance**
- Connecting nodes and editing config produces a spec that validates against the core/config schemas.
- Round-trip test: graph → spec → (schema-valid)."

mkissue "[studio] Deployment inspector view" "module:studio,type:feature" \
"Load existing deployment + config state via \`@redeploy/reader\` and visualize contracts, links, and per-step config status.

$BOUND

**Acceptance**
- Given a fixture deployment, the inspector renders contracts, their links, and config status.
- Component test against the fixture."

echo "Done."

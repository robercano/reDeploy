/**
 * plan-diff.ts
 *
 * Pure, UI-agnostic dry-run plan/diff computation (issue #101): given the
 * studio's DESIRED spec (a `SpecPair` produced by `graphToSpec`) and the best
 * CURRENT state the studio has in memory (a `DeploymentView`, or `null` when
 * nothing is known), compute a Terraform-style plan describing, per contract
 * and per config step, whether it will be **create**d, **skip**ped (already
 * satisfied / idempotent no-op), or **change**d (differs from what's
 * currently deployed/completed).
 *
 * This module contains NO React/DOM code so it is trivially unit-testable in
 * isolation and reusable from both the confirm-modal (compact summary) and
 * the inspector (full plan view).
 *
 * ## Diff rules
 *
 * Contracts:
 *   - In `desired` but not in `current` (or `current` has that id with
 *     `address === null`, i.e. an initialized-but-never-completed partial
 *     deployment) ⇒ **create**.
 *   - In both, address present, `contract` (artifact name) and constructor
 *     args unchanged ⇒ **skip** (idempotent — already deployed as declared).
 *   - In both, but the artifact name or constructor args differ ⇒ **change**,
 *     with a human-readable `changes` list describing what differs.
 *
 * Config steps (both `config.steps` and `config.orderedSteps`, since both
 * represent steps the engine will attempt to run):
 *   - Completed in `current` ⇒ **skip**.
 *   - Not completed (or absent from `current`) ⇒ **create**.
 *
 * `current === null` (no known state — the common "Simulate from an empty
 * canvas" case, or no snapshot/deploy result loaded yet) ⇒ every contract and
 * config step defaults to **create**. `DeploymentPlan.noCurrentState` is set
 * so callers can render an explanatory note ("no known current state — this
 * plan assumes a fresh deployment") instead of silently looking identical to
 * a real diff.
 *
 * ## Orphans (present in `current`, absent from `desired`)
 *
 * A contract or config step that exists in `current` but is no longer
 * referenced by `desired` is NOT actioned by reDeploy (nothing in this system
 * ever deletes/undeploys a contract or reverts a config step) — it is neither
 * a create, a skip, nor a change. It is surfaced purely as INFORMATIONAL data
 * (`orphanContracts` / `orphanConfigSteps`) so the user can see that the
 * current state has entries the desired spec no longer describes, without
 * implying any action will be taken on them.
 *
 * ## Constructor-argument comparison — known v1 limitation
 *
 * `desired` constructor args are `ContractArg`s (`LiteralArg | RefArg |
 * ParamArg | ExprArg | ResolverArg`) — some of these (`ref` / `param` / `expr`
 * / `resolver`) only resolve to a concrete value at compile/deploy time via
 * infrastructure (the expression evaluator, resolver registry, Ignition
 * parameter substitution) that lives in `@redeploy/core`'s Node-only runtime
 * and is deliberately NOT available to this pure, browser-safe UI module.
 * `current` args (`ArgValue`) are always already-resolved concrete values.
 *
 * Only `LiteralArg` slots can be compared directly against the corresponding
 * resolved `ArgValue` (with bigint-aware normalization — a `BigIntValue`
 * `{ $bigint: "123" }` on the current side matches a literal `123` or "123"
 * on the desired side). `ref` / `param` / `expr` / `resolver` slots are
 * treated as "cannot verify statically" and are never flagged as changed —
 * this is a deliberate, documented v1 limitation (a live on-chain/journal
 * diff with full expression evaluation is a follow-up; see the module-level
 * comment in App.tsx's plan integration).
 */

import type { ContractArg, ContractEntry, DeploymentSpec, LiteralValue } from "@redeploy/core/spec";
import type { ConfigSpec, ConfigStep } from "@redeploy/config/steps";
import type { ArgValue, BigIntValue, ContractView, ConfigStepStatus, DeploymentView } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContractPlanAction = "create" | "skip" | "change";
export type ConfigStepPlanAction = "create" | "skip";

/** Per-contract plan entry. */
export interface ContractPlanEntry {
  readonly id: string;
  readonly contractName: string;
  readonly action: ContractPlanAction;
  /** Present only when `action === "change"` — human-readable diff notes. */
  readonly changes?: ReadonlyArray<string>;
}

/** Per-config-step plan entry. */
export interface ConfigStepPlanEntry {
  readonly id: string;
  readonly kind: string;
  readonly action: ConfigStepPlanAction;
}

/** A contract present in `current` but no longer referenced by `desired` — informational only. */
export interface OrphanContract {
  readonly id: string;
  readonly contractName: string;
  readonly address: string | null;
}

/** A config step present in `current` but no longer referenced by `desired` — informational only. */
export interface OrphanConfigStep {
  readonly id: string;
  readonly kind: string;
}

/** Compact counts for one-line summaries (e.g. the pre-deploy confirm modal). */
export interface DeploymentPlanSummary {
  readonly toCreate: number;
  readonly toSkip: number;
  readonly toChange: number;
  readonly configToCreate: number;
  readonly configToSkip: number;
}

/** The full computed dry-run plan. */
export interface DeploymentPlan {
  readonly contracts: ReadonlyArray<ContractPlanEntry>;
  readonly configSteps: ReadonlyArray<ConfigStepPlanEntry>;
  readonly orphanContracts: ReadonlyArray<OrphanContract>;
  readonly orphanConfigSteps: ReadonlyArray<OrphanConfigStep>;
  readonly summary: DeploymentPlanSummary;
  /**
   * True when `current` was `null` — i.e. no known prior state was available,
   * so every contract/config-step entry defaulted to "create". Callers should
   * render an explanatory note in this case rather than presenting the plan
   * as if it were a verified diff against known state.
   */
  readonly noCurrentState: boolean;
}

// ---------------------------------------------------------------------------
// Argument comparison
// ---------------------------------------------------------------------------

function isBigIntValue(v: ArgValue): v is BigIntValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "$bigint" in v &&
    typeof (v as BigIntValue).$bigint === "string"
  );
}

/**
 * Compare a resolved `LiteralValue` (desired) against a resolved `ArgValue`
 * (current), with bigint-aware normalization. Returns `true` when they
 * represent the same value.
 */
function literalEqualsArgValue(desired: LiteralValue, current: ArgValue): boolean {
  if (isBigIntValue(current)) {
    // A bigint on the current side matches a desired number/string literal
    // with the same decimal digits (studio literals never carry an explicit
    // bigint tag — see parseLiteralValue in graph-to-spec.ts).
    if (typeof desired === "number" || typeof desired === "string") {
      return String(desired) === current.$bigint;
    }
    return false;
  }

  if (Array.isArray(desired) || Array.isArray(current)) {
    if (!Array.isArray(desired) || !Array.isArray(current)) return false;
    if (desired.length !== current.length) return false;
    return desired.every((d, i) => literalEqualsArgValue(d, current[i] as ArgValue));
  }

  // Any other object shape (arbitrary Record<string, ArgValue>) has no
  // LiteralValue counterpart — never equal.
  if (typeof current === "object" && current !== null) return false;

  return desired === current;
}

/**
 * Diff a desired contract's constructor args against the resolved args
 * currently on record. Returns a list of human-readable change descriptions
 * (empty when unchanged, as far as this module can verify — see the
 * module-level "known v1 limitation" doc comment).
 */
function diffArgs(
  desiredArgs: ReadonlyArray<ContractArg> | undefined,
  currentArgs: ReadonlyArray<ArgValue>,
): string[] {
  const desired = desiredArgs ?? [];

  if (desired.length !== currentArgs.length) {
    return [`argument count changed (${currentArgs.length} -> ${desired.length})`];
  }

  const changes: string[] = [];
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    const c = currentArgs[i];
    if (d.kind === "literal") {
      if (!literalEqualsArgValue(d.value, c)) {
        changes.push(`args[${i}] changed`);
      }
    }
    // ref / param / expr / resolver: cannot be verified statically — skipped
    // (see the module-level "known v1 limitation" doc comment).
  }
  return changes;
}

// ---------------------------------------------------------------------------
// computePlan
// ---------------------------------------------------------------------------

/**
 * Compute a dry-run create/skip/change plan for `desired` (the studio's
 * current graph, serialized) against `current` (the best known deployed/
 * completed state, or `null` when nothing is known).
 */
export function computePlan(
  desired: DeploymentSpec,
  config: ConfigSpec,
  current: DeploymentView | null,
): DeploymentPlan {
  const currentContractsById = new Map<string, ContractView>();
  if (current !== null) {
    for (const c of current.contracts) currentContractsById.set(c.id, c);
  }

  const contracts: ContractPlanEntry[] = [];
  const desiredContractIds = new Set<string>();

  for (const entry of desired.contracts) {
    desiredContractIds.add(entry.id);
    contracts.push(planContractEntry(entry, currentContractsById.get(entry.id)));
  }

  const orphanContracts: OrphanContract[] = [];
  if (current !== null) {
    for (const c of current.contracts) {
      if (!desiredContractIds.has(c.id)) {
        orphanContracts.push({ id: c.id, contractName: c.contractName, address: c.address });
      }
    }
  }

  const currentStepsById = new Map<string, ConfigStepStatus>();
  if (current !== null) {
    for (const s of current.configSteps) currentStepsById.set(s.id, s);
  }

  const desiredSteps: ConfigStep[] = [...config.steps, ...(config.orderedSteps ?? [])];
  const configSteps: ConfigStepPlanEntry[] = [];
  const desiredStepIds = new Set<string>();

  for (const step of desiredSteps) {
    desiredStepIds.add(step.id);
    const cur = currentStepsById.get(step.id);
    const action: ConfigStepPlanAction = cur?.completed === true ? "skip" : "create";
    configSteps.push({ id: step.id, kind: step.kind, action });
  }

  const orphanConfigSteps: OrphanConfigStep[] = [];
  if (current !== null) {
    for (const s of current.configSteps) {
      if (!desiredStepIds.has(s.id)) {
        orphanConfigSteps.push({ id: s.id, kind: s.kind });
      }
    }
  }

  const summary: DeploymentPlanSummary = {
    toCreate: contracts.filter((c) => c.action === "create").length,
    toSkip: contracts.filter((c) => c.action === "skip").length,
    toChange: contracts.filter((c) => c.action === "change").length,
    configToCreate: configSteps.filter((s) => s.action === "create").length,
    configToSkip: configSteps.filter((s) => s.action === "skip").length,
  };

  return {
    contracts,
    configSteps,
    orphanContracts,
    orphanConfigSteps,
    summary,
    noCurrentState: current === null,
  };
}

function planContractEntry(entry: ContractEntry, cur: ContractView | undefined): ContractPlanEntry {
  if (cur === undefined || cur.address === null) {
    return { id: entry.id, contractName: entry.contract, action: "create" };
  }

  const changes: string[] = [];
  if (cur.contractName !== entry.contract) {
    changes.push(`contractName changed: "${cur.contractName}" -> "${entry.contract}"`);
  }
  changes.push(...diffArgs(entry.args, cur.args));

  if (changes.length > 0) {
    return { id: entry.id, contractName: entry.contract, action: "change", changes };
  }
  return { id: entry.id, contractName: entry.contract, action: "skip" };
}

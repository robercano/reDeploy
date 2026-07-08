/**
 * PlanView.tsx
 *
 * Terraform-style dry-run plan/diff view (issue #101): renders a
 * `DeploymentPlan` (from `../spec/plan-diff.ts`) as grouped Create / Skip
 * (already deployed) / Change sections for contracts, plus a matching
 * grouping for config steps, with per-group counts and an informational
 * "orphans" section for anything present in the current state but no longer
 * described by the desired spec.
 *
 * Purely presentational — takes an already-computed `DeploymentPlan`, no
 * disk/network I/O and no mutation of app state.
 */

import { memo } from "react";
import type {
  ContractPlanAction,
  ContractPlanEntry,
  ConfigStepPlanAction,
  ConfigStepPlanEntry,
  DeploymentPlan,
} from "../spec/plan-diff.js";

// ---------------------------------------------------------------------------
// Styles (mirrors SnapshotViewer.tsx / Inspector.tsx conventions)
// ---------------------------------------------------------------------------

const rootStyle: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  overflowY: "auto",
  padding: "72px 24px 24px",
  boxSizing: "border-box",
  color: "var(--color-text)",
};

const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--color-warning-text)",
  background: "var(--color-warning-bg)",
  border: "1px solid var(--color-warning-border)",
  borderRadius: 6,
  padding: "8px 12px",
  marginBottom: 16,
  maxWidth: 720,
};

const followUpNoteStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-secondary)",
  marginBottom: 20,
  maxWidth: 720,
};

const summaryBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 16,
  marginBottom: 20,
  flexWrap: "wrap",
};

const summaryPillStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: "4px 12px",
  borderRadius: 14,
};

const createPillStyle: React.CSSProperties = {
  ...summaryPillStyle,
  background: "var(--color-success-bg)",
  color: "var(--color-success-text)",
  border: "1px solid var(--color-success-border)",
};

const skipPillStyle: React.CSSProperties = {
  ...summaryPillStyle,
  background: "var(--color-bg-elevated)",
  color: "var(--color-text-secondary)",
  border: "1px solid var(--color-border)",
};

const changePillStyle: React.CSSProperties = {
  ...summaryPillStyle,
  background: "var(--color-warning-bg)",
  color: "var(--color-warning-text)",
  border: "1px solid var(--color-warning-border)",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 24,
  maxWidth: 720,
};

const sectionTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 8,
};

const entryCardStyle: React.CSSProperties = {
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: 10,
  marginBottom: 8,
};

const actionBadgeBaseStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: 10,
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: 10,
  textTransform: "uppercase",
  marginRight: 8,
};

const createBadgeStyle: React.CSSProperties = {
  ...actionBadgeBaseStyle,
  background: "var(--color-success-bg-strong)",
  color: "var(--color-success-text-strong)",
};

const skipBadgeStyle: React.CSSProperties = {
  ...actionBadgeBaseStyle,
  background: "var(--color-bg-panel)",
  color: "var(--color-text-secondary)",
};

const changeBadgeStyle: React.CSSProperties = {
  ...actionBadgeBaseStyle,
  background: "var(--color-warning-bg)",
  color: "var(--color-warning-text)",
};

const emptySectionStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-text-muted)",
  fontStyle: "italic",
};

const orphanNoteStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--color-text-muted)",
  marginTop: 8,
};

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function contractActionBadge(action: ContractPlanAction) {
  if (action === "create") return <span style={createBadgeStyle}>create</span>;
  if (action === "change") return <span style={changeBadgeStyle}>change</span>;
  return <span style={skipBadgeStyle}>skip</span>;
}

function configStepActionBadge(action: ConfigStepPlanAction) {
  if (action === "create") return <span style={createBadgeStyle}>create</span>;
  return <span style={skipBadgeStyle}>skip</span>;
}

// ---------------------------------------------------------------------------
// Contract group
// ---------------------------------------------------------------------------

function ContractGroup({
  title,
  entries,
}: {
  title: string;
  entries: ReadonlyArray<ContractPlanEntry>;
}) {
  return (
    <div style={sectionStyle} data-testid={`plan-contract-group-${title.toLowerCase()}`}>
      <div style={sectionTitleStyle}>
        {title} ({entries.length})
      </div>
      {entries.length === 0 ? (
        <div style={emptySectionStyle}>None.</div>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} style={entryCardStyle} data-testid={`plan-contract-${entry.id}`}>
            {contractActionBadge(entry.action)}
            <span style={{ fontWeight: 500, fontSize: 12 }}>{entry.id}</span>{" "}
            <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
              ({entry.contractName})
            </span>
            {entry.changes !== undefined && entry.changes.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 11 }}>
                {entry.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config step group
// ---------------------------------------------------------------------------

function ConfigStepGroup({
  title,
  entries,
}: {
  title: string;
  entries: ReadonlyArray<ConfigStepPlanEntry>;
}) {
  return (
    <div style={sectionStyle} data-testid={`plan-config-group-${title.toLowerCase()}`}>
      <div style={sectionTitleStyle}>
        {title} ({entries.length})
      </div>
      {entries.length === 0 ? (
        <div style={emptySectionStyle}>None.</div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            style={entryCardStyle}
            data-testid={`plan-config-step-${entry.id}`}
          >
            {configStepActionBadge(entry.action)}
            <span style={{ fontWeight: 500, fontSize: 12 }}>{entry.id}</span>{" "}
            <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
              ({entry.kind})
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanView component
// ---------------------------------------------------------------------------

export interface PlanViewProps {
  /** The computed dry-run plan to render (from computePlan()). */
  plan: DeploymentPlan;
}

function PlanViewImpl({ plan }: PlanViewProps) {
  const contractsByAction = {
    create: plan.contracts.filter((c) => c.action === "create"),
    skip: plan.contracts.filter((c) => c.action === "skip"),
    change: plan.contracts.filter((c) => c.action === "change"),
  };
  const configByAction = {
    create: plan.configSteps.filter((s) => s.action === "create"),
    skip: plan.configSteps.filter((s) => s.action === "skip"),
  };

  return (
    <div style={rootStyle} data-testid="plan-view">
      {plan.noCurrentState && (
        <div style={noteStyle} data-testid="plan-no-current-state-note">
          No known current state is loaded in the studio (no snapshot loaded and
          no prior real-deploy result) — every contract and config step below
          is shown as <strong>create</strong>, assuming a fresh deployment.
          Load a deployment snapshot, or run a real Deploy first, to see a
          verified create/skip/change diff against on-chain state.
        </div>
      )}
      <div style={followUpNoteStyle} data-testid="plan-live-diff-followup-note">
        This plan is computed from state already loaded in the studio (a
        loaded snapshot or the last real-deploy result). Fetching current
        on-chain/journal state on demand for a live diff is a follow-up.
      </div>

      <div style={summaryBarStyle} data-testid="plan-summary">
        <span style={createPillStyle}>{plan.summary.toCreate} to create</span>
        <span style={skipPillStyle}>{plan.summary.toSkip} unchanged</span>
        <span style={changePillStyle}>{plan.summary.toChange} to change</span>
        <span style={createPillStyle}>{plan.summary.configToCreate} config to run</span>
        <span style={skipPillStyle}>{plan.summary.configToSkip} config already done</span>
      </div>

      <ContractGroup title="Create" entries={contractsByAction.create} />
      <ContractGroup title="Skip" entries={contractsByAction.skip} />
      <ContractGroup title="Change" entries={contractsByAction.change} />

      <ConfigStepGroup title="Create" entries={configByAction.create} />
      <ConfigStepGroup title="Skip" entries={configByAction.skip} />

      {(plan.orphanContracts.length > 0 || plan.orphanConfigSteps.length > 0) && (
        <div style={sectionStyle} data-testid="plan-orphans">
          <div style={sectionTitleStyle}>
            Present in current state, not in this plan (informational only)
          </div>
          {plan.orphanContracts.map((c) => (
            <div
              key={c.id}
              style={entryCardStyle}
              data-testid={`plan-orphan-contract-${c.id}`}
            >
              <span style={{ fontWeight: 500, fontSize: 12 }}>{c.id}</span>{" "}
              <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
                ({c.contractName})
              </span>
              {c.address !== null && (
                <div
                  style={{ fontFamily: "monospace", fontSize: 11, marginTop: 4 }}
                >
                  {c.address}
                </div>
              )}
            </div>
          ))}
          {plan.orphanConfigSteps.map((s) => (
            <div
              key={s.id}
              style={entryCardStyle}
              data-testid={`plan-orphan-config-step-${s.id}`}
            >
              <span style={{ fontWeight: 500, fontSize: 12 }}>{s.id}</span>{" "}
              <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
                ({s.kind})
              </span>
            </div>
          ))}
          <div style={orphanNoteStyle}>
            reDeploy never deletes contracts or reverts config steps — these
            are shown for visibility only, no action will be taken on them.
          </div>
        </div>
      )}
    </div>
  );
}

// Wrapped in React.memo, matching SnapshotViewer.tsx: this renders a computed,
// already-immutable plan object inside the large <App> component, so it has
// no reason to re-render on unrelated App state changes as long as `plan`'s
// identity is unchanged.
export const PlanView = memo(PlanViewImpl);

export default PlanView;

/**
 * PlanView.test.tsx
 *
 * Render tests for the dry-run plan/diff view (issue #101): asserts group
 * counts, badge presence per action, the orphans section, and the
 * "no current state" note render correctly for representative plans.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PlanView } from "../src/components/PlanView.js";
import type { DeploymentPlan } from "../src/spec/plan-diff.js";

function makePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    contracts: [],
    configSteps: [],
    orphanContracts: [],
    orphanConfigSteps: [],
    summary: {
      toCreate: 0,
      toSkip: 0,
      toChange: 0,
      configToCreate: 0,
      configToSkip: 0,
    },
    noCurrentState: false,
    ...overrides,
  };
}

describe("PlanView — summary counts", () => {
  it("renders the summary pill counts matching the plan", () => {
    const plan = makePlan({
      contracts: [
        { id: "a", contractName: "A", action: "create" },
        { id: "b", contractName: "B", action: "skip" },
        { id: "c", contractName: "C", action: "change", changes: ["args[0] changed"] },
      ],
      configSteps: [
        { id: "step1", kind: "setX", action: "create" },
        { id: "step2", kind: "wire", action: "skip" },
      ],
      summary: {
        toCreate: 1,
        toSkip: 1,
        toChange: 1,
        configToCreate: 1,
        configToSkip: 1,
      },
    });

    render(<PlanView plan={plan} />);

    const summary = screen.getByTestId("plan-summary");
    expect(summary.textContent).toContain("1 to create");
    expect(summary.textContent).toContain("1 unchanged");
    expect(summary.textContent).toContain("1 to change");
    expect(summary.textContent).toContain("1 config to run");
    expect(summary.textContent).toContain("1 config already done");
  });

  it("renders each contract entry in its action group with a badge", () => {
    const plan = makePlan({
      contracts: [
        { id: "a", contractName: "A", action: "create" },
        { id: "b", contractName: "B", action: "skip" },
        { id: "c", contractName: "C", action: "change", changes: ["contractName changed: X -> Y"] },
      ],
    });

    render(<PlanView plan={plan} />);

    expect(screen.getByTestId("plan-contract-a")).toBeInTheDocument();
    expect(screen.getByTestId("plan-contract-a").textContent).toContain("create");
    expect(screen.getByTestId("plan-contract-b").textContent).toContain("skip");
    expect(screen.getByTestId("plan-contract-c").textContent).toContain("change");
    expect(screen.getByTestId("plan-contract-c").textContent).toContain(
      "contractName changed: X -> Y",
    );
  });

  it("renders config step entries with their action badge", () => {
    const plan = makePlan({
      configSteps: [
        { id: "set-fee", kind: "setX", action: "create" },
        { id: "grant-minter", kind: "grantRole", action: "skip" },
      ],
    });

    render(<PlanView plan={plan} />);

    expect(screen.getByTestId("plan-config-step-set-fee").textContent).toContain("create");
    expect(screen.getByTestId("plan-config-step-grant-minter").textContent).toContain("skip");
  });
});

describe("PlanView — noCurrentState note", () => {
  it("shows the explanatory note when noCurrentState is true", () => {
    render(<PlanView plan={makePlan({ noCurrentState: true })} />);
    expect(screen.getByTestId("plan-no-current-state-note")).toBeInTheDocument();
  });

  it("hides the note when current state was known", () => {
    render(<PlanView plan={makePlan({ noCurrentState: false })} />);
    expect(screen.queryByTestId("plan-no-current-state-note")).not.toBeInTheDocument();
  });
});

describe("PlanView — orphans section", () => {
  it("is absent when there are no orphans", () => {
    render(<PlanView plan={makePlan()} />);
    expect(screen.queryByTestId("plan-orphans")).not.toBeInTheDocument();
  });

  it("renders orphan contracts and config steps informationally", () => {
    const plan = makePlan({
      orphanContracts: [{ id: "old", contractName: "OldThing", address: "0xdead" }],
      orphanConfigSteps: [{ id: "old-step", kind: "setX" }],
    });

    render(<PlanView plan={plan} />);

    const orphans = screen.getByTestId("plan-orphans");
    expect(orphans).toBeInTheDocument();
    expect(screen.getByTestId("plan-orphan-contract-old")).toBeInTheDocument();
    expect(screen.getByTestId("plan-orphan-contract-old").textContent).toContain("0xdead");
    expect(screen.getByTestId("plan-orphan-config-step-old-step")).toBeInTheDocument();
  });
});

describe("PlanView — empty groups", () => {
  it("renders 'None.' placeholders for empty action groups", () => {
    render(<PlanView plan={makePlan()} />);
    expect(screen.getByTestId("plan-contract-group-create").textContent).toContain("None.");
    expect(screen.getByTestId("plan-contract-group-skip").textContent).toContain("None.");
    expect(screen.getByTestId("plan-contract-group-change").textContent).toContain("None.");
    expect(screen.getByTestId("plan-config-group-create").textContent).toContain("None.");
    expect(screen.getByTestId("plan-config-group-skip").textContent).toContain("None.");
  });
});

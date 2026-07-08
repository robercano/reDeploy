/**
 * App.plan.test.tsx
 *
 * Integration tests for the "Plan" dry-run diff feature wired into App.tsx
 * (issue #101):
 * - The "Plan" toolbar button is present alongside Simulate/Deploy.
 * - Clicking it is purely local (no fetch) and switches to inspector mode,
 *   rendering <PlanView> instead of the default <Inspector>.
 * - With no known current state, every contract shows as "create" and the
 *   "no current state" note is shown.
 * - The "Deploy (real)" confirm modal shows a compact plan summary.
 */

import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import App from "../src/App.js";

/**
 * Add a contract node by name through the Contracts Browser (mirrors the
 * helper in App.simulate.test.tsx / App.deploy.test.tsx).
 */
function addNodeByName(name: string) {
  if (!screen.queryByTestId("contracts-browser")) {
    fireEvent.click(screen.getByTestId("toggle-contracts-browser"));
  }
  const browser = screen.getByTestId("contracts-browser");
  fireEvent.click(within(browser).getByTestId(`contract-row-${name}`));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("App — Plan button", () => {
  it("renders the deploy-plan-button alongside simulate/deploy in the same toolbar", () => {
    render(<App />);
    const planBtn = screen.getByTestId("deploy-plan-button");
    expect(planBtn.textContent).toBe("Plan");

    const simulateBtn = screen.getByTestId("deploy-simulate-button");
    expect(planBtn.parentElement).toBe(simulateBtn.parentElement);
  });

  it("never calls fetch — Plan is a purely local computation", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("switches to inspector mode and renders PlanView instead of the default Inspector", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(screen.getByTestId("plan-view")).toBeInTheDocument();
    // The default sample Inspector canvas should not also be present.
    expect(screen.queryByTestId("inspector-config-panel")).not.toBeInTheDocument();
  });

  it("shows the 'no current state' note when nothing has been loaded/deployed yet", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(screen.getByTestId("plan-no-current-state-note")).toBeInTheDocument();
  });

  it("shows an empty-graph plan (all-zero summary) when the canvas has no nodes", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    const summary = screen.getByTestId("plan-summary");
    expect(summary.textContent).toContain("0 to create");
    expect(summary.textContent).toContain("0 unchanged");
    expect(summary.textContent).toContain("0 to change");
  });

  it("classifies a freshly added contract node as 'create' (no known current state)", () => {
    render(<App />);
    addNodeByName("Registry");

    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "registry" } });

    fireEvent.click(screen.getByTestId("deploy-plan-button"));

    expect(screen.getByTestId("plan-view")).toBeInTheDocument();
    const entry = screen.getByTestId("plan-contract-registry");
    expect(entry.textContent).toContain("create");
    expect(entry.textContent).toContain("Registry");

    const summary = screen.getByTestId("plan-summary");
    expect(summary.textContent).toContain("1 to create");
  });

  it("Esc dismisses the plan view back to authoring, mirroring Simulate/Deploy (issue #111)", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-plan-button"));
    expect(screen.getByTestId("plan-view")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByTestId("mode-authoring")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-view")).not.toBeInTheDocument();
  });
});

describe("App — Deploy (real) confirm modal plan preview", () => {
  it("shows a compact plan summary line in the confirm modal", () => {
    render(<App />);
    addNodeByName("Registry");
    const deployIdInput = screen.getByLabelText("deploy-id") as HTMLInputElement;
    fireEvent.change(deployIdInput, { target: { value: "registry" } });

    fireEvent.click(screen.getByTestId("deploy-real-button"));

    const summaryLine = screen.getByTestId("deploy-real-plan-summary");
    expect(summaryLine.textContent).toContain("1 to create");
    expect(summaryLine.textContent).toContain("0 unchanged");
    expect(summaryLine.textContent).toContain("0 to change");
  });

  it("does not block the Deploy button when the plan summary is computed", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("deploy-real-button"));

    // The confirm button remains present/clickable regardless of plan content.
    expect(screen.getByTestId("deploy-real-confirm")).not.toBeDisabled();
  });
});

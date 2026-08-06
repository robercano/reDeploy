/**
 * Inspector.test.tsx
 *
 * Tests for the Inspector component. Loads a real DeploymentView from the
 * committed fixture deployment directory (using readDeployment on the Node
 * side where fs is available), then renders <Inspector view={view} /> and
 * asserts the UI reflects the data correctly.
 *
 * Mirrors App.test.tsx and ConfigPanel.test.tsx patterns.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { Inspector } from "../src/components/Inspector.js";
import { readDeployment } from "../src/inspector/load-deployment.js";
import { deploymentViewToFlow } from "../src/inspector/view-to-flow.js";

// ---------------------------------------------------------------------------
// Fixture path (committed under test/fixtures/deployment/)
//
// Resolved from process.cwd() because import.meta.url may not have a
// "file://" scheme in the jsdom test environment (vitest transforms it
// to "http://localhost/..."). process.cwd() is the studio package root
// (apps/studio/) when running `pnpm --filter @redeploy/studio test`.
// ---------------------------------------------------------------------------

const fixtureDir = resolve(process.cwd(), "test/fixtures/deployment");

// ---------------------------------------------------------------------------
// Load the real DeploymentView from disk using readDeployment
// ---------------------------------------------------------------------------

// "grantRoles" is listed as an expected step that does NOT exist in
// config-state.jsonl, so it should appear with completed: false.
const view = readDeployment({
  deploymentDir: fixtureDir,
  expectedConfigStepIds: ["setFee", "setToken", "grantRoles"],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Inspector — contract rendering", () => {
  it("renders the inspector without crashing", () => {
    const { container } = render(<Inspector view={view} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders a React Flow canvas", () => {
    render(<Inspector view={view} />);
    const canvas = document.querySelector(".react-flow");
    expect(canvas).not.toBeNull();
  });

  it("renders inspector nodes for all three contracts", () => {
    render(<Inspector view={view} />);
    expect(screen.getByTestId("inspector-node-registry")).not.toBeNull();
    expect(screen.getByTestId("inspector-node-token")).not.toBeNull();
    expect(screen.getByTestId("inspector-node-vault")).not.toBeNull();
  });

  it("renders contract names for registry and token", () => {
    render(<Inspector view={view} />);
    // ContractNames should appear in the nodes
    const registryNode = screen.getByTestId("inspector-node-registry");
    expect(registryNode.textContent).toContain("Registry");

    const tokenNode = screen.getByTestId("inspector-node-token");
    expect(tokenNode.textContent).toContain("ERC20Token");
  });

  it("renders the deployed address for registry", () => {
    render(<Inspector view={view} />);
    const addressEl = screen.getByTestId("inspector-node-registry-address");
    expect(addressEl.textContent).toContain(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("renders the deployed address for token", () => {
    render(<Inspector view={view} />);
    const addressEl = screen.getByTestId("inspector-node-token-address");
    expect(addressEl.textContent).toContain(
      "0x2222222222222222222222222222222222222222",
    );
  });

  it("renders the deployed address for vault", () => {
    render(<Inspector view={view} />);
    const addressEl = screen.getByTestId("inspector-node-vault-address");
    expect(addressEl.textContent).toContain(
      "0x3333333333333333333333333333333333333333",
    );
  });
});

describe("Inspector — inter-contract edges", () => {
  it("vault has inter-contract links (token + registry dependencies)", () => {
    // Verify via the deployment view data (React Flow edge DOM rendering
    // depends on layout calculations not available in jsdom, so we assert
    // on the underlying data that drives the edges instead).
    const vault = view.contracts.find((c) => c.id === "vault");
    expect(vault).toBeDefined();
    expect(vault!.links.dependencies).toContain("token");
    expect(vault!.links.dependencies).toContain("registry");
  });

  it("deploymentViewToFlow produces dependency edges for vault's links", () => {
    // Assert that the adapter (already fully unit-tested in view-to-flow.test.ts)
    // produces edges from the real DeploymentView loaded from the fixture.
    const { edges } = deploymentViewToFlow(view);
    expect(edges.length).toBeGreaterThan(0);
    const depEdge = edges.find((e) => e.source === "token" && e.target === "vault");
    expect(depEdge).toBeDefined();
  });
});

describe("Inspector — config steps panel", () => {
  it("renders the config-step panel", () => {
    render(<Inspector view={view} />);
    expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
  });

  it("renders setFee as completed", () => {
    render(<Inspector view={view} />);
    const stepEl = screen.getByTestId("config-step-setFee");
    expect(stepEl).not.toBeNull();
    const statusEl = screen.getByTestId("config-step-setFee-status");
    expect(statusEl.textContent).toBe("completed");
  });

  it("renders setToken as completed", () => {
    render(<Inspector view={view} />);
    const statusEl = screen.getByTestId("config-step-setToken-status");
    expect(statusEl.textContent).toBe("completed");
  });

  it("renders grantRoles as pending (expected but not in journal)", () => {
    render(<Inspector view={view} />);
    const stepEl = screen.getByTestId("config-step-grantRoles");
    expect(stepEl).not.toBeNull();
    const statusEl = screen.getByTestId("config-step-grantRoles-status");
    expect(statusEl.textContent).toBe("pending");
  });

  it("distinguishes completed from pending step statuses", () => {
    render(<Inspector view={view} />);
    const completedBadges = document.querySelectorAll(
      "[data-testid$='-status']",
    );
    const textValues = Array.from(completedBadges).map(
      (el) => el.textContent,
    );
    expect(textValues).toContain("completed");
    expect(textValues).toContain("pending");
  });
});

describe("Inspector — BigInt args rendered", () => {
  it("renders the bigint string-form arg for token (1000000000000000000)", () => {
    render(<Inspector view={view} />);
    const tokenNode = screen.getByTestId("inspector-node-token");
    // Bigint string form "1000000000000000000n" → normalized to $bigint: "1000000000000000000"
    expect(tokenNode.textContent).toContain("1000000000000000000");
  });

  it("renders the bigint object-form arg for token (500)", () => {
    render(<Inspector view={view} />);
    const tokenNode = screen.getByTestId("inspector-node-token");
    // _kind bigint form { _kind: "bigint", value: "500" } → normalized to $bigint: "500"
    expect(tokenNode.textContent).toContain("500");
  });
});

// ---------------------------------------------------------------------------
// Inspector — contextLabel / dry-run badge
// ---------------------------------------------------------------------------

describe("Inspector — contextLabel badge", () => {
  it("renders the inspector-context-badge when contextLabel is provided", () => {
    render(<Inspector view={view} contextLabel="Simulated plan (dry run)" />);
    const badge = screen.queryByTestId("inspector-context-badge");
    expect(badge).not.toBeNull();
  });

  it("inspector-context-badge text matches the contextLabel prop", () => {
    render(<Inspector view={view} contextLabel="Simulated plan (dry run)" />);
    const badge = screen.getByTestId("inspector-context-badge");
    expect(badge.textContent).toBe("Simulated plan (dry run)");
  });

  it("inspector-context-badge is absent by default (no contextLabel prop)", () => {
    render(<Inspector view={view} />);
    expect(screen.queryByTestId("inspector-context-badge")).toBeNull();
  });

  it("inspector-context-badge is absent when contextLabel is undefined", () => {
    render(<Inspector view={view} contextLabel={undefined} />);
    expect(screen.queryByTestId("inspector-context-badge")).toBeNull();
  });

  it("renders a custom contextLabel text correctly", () => {
    render(<Inspector view={view} contextLabel="Live deployment" />);
    const badge = screen.getByTestId("inspector-context-badge");
    expect(badge.textContent).toBe("Live deployment");
  });

  it("existing contract nodes still render when contextLabel is set", () => {
    render(<Inspector view={view} contextLabel="Simulated plan (dry run)" />);
    expect(screen.getByTestId("inspector-node-registry")).not.toBeNull();
    expect(screen.getByTestId("inspector-node-token")).not.toBeNull();
    expect(screen.getByTestId("inspector-node-vault")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspector — config-drift badges (issue #138)
// ---------------------------------------------------------------------------

describe("Inspector — config-drift badges", () => {
  it("renders no drift badge for a step when driftResults is absent", () => {
    render(<Inspector view={view} />);
    expect(screen.queryByTestId("config-step-setFee-drift")).toBeNull();
  });

  it("renders a 'match' drift badge for a step present in driftResults", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "match", expected: 500, actual: 500 }]}
      />,
    );
    const badge = screen.getByTestId("config-step-setFee-drift");
    expect(badge.textContent).toBe("match");
  });

  it("renders a 'drift' badge distinctly for a mismatched step", () => {
    render(
      <Inspector
        view={view}
        driftResults={[
          { id: "setFee", status: "drift", expected: 500, actual: 999, message: "Expected 500 but got 999" },
        ]}
      />,
    );
    const badge = screen.getByTestId("config-step-setFee-drift");
    expect(badge.textContent).toBe("drift");
  });

  it("renders 'error' and 'skipped' drift statuses for their respective steps", () => {
    render(
      <Inspector
        view={view}
        driftResults={[
          { id: "setFee", status: "error", expected: null, actual: null, message: "boom" },
          { id: "setToken", status: "skipped", expected: null, actual: null, message: "no getter" },
        ]}
      />,
    );
    expect(screen.getByTestId("config-step-setFee-drift").textContent).toBe("error");
    expect(screen.getByTestId("config-step-setToken-drift").textContent).toBe("skipped");
  });

  it("does not render a drift badge for a step absent from driftResults", () => {
    render(
      <Inspector view={view} driftResults={[{ id: "setFee", status: "match", expected: 1, actual: 1 }]} />,
    );
    expect(screen.getByTestId("config-step-setFee-drift")).not.toBeNull();
    expect(screen.queryByTestId("config-step-setToken-drift")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspector — drift detail panel + Re-apply button (issue #153)
// ---------------------------------------------------------------------------

describe("Inspector — drift detail panel", () => {
  it("no detail panel is rendered before the drift badge is clicked", () => {
    render(
      <Inspector
        view={view}
        driftResults={[
          { id: "setFee", status: "drift", expected: 500, actual: 999, message: "mismatch" },
        ]}
      />,
    );
    expect(screen.queryByTestId("config-step-setFee-drift-detail")).toBeNull();
  });

  it("clicking the drift badge for a drifted step reveals expected/actual/message", () => {
    render(
      <Inspector
        view={view}
        driftResults={[
          { id: "setFee", status: "drift", expected: 500, actual: 999, message: "Expected 500 but got 999" },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));

    const detail = screen.getByTestId("config-step-setFee-drift-detail");
    expect(detail).not.toBeNull();
    expect(screen.getByTestId("config-step-setFee-drift-expected").textContent).toContain("500");
    expect(screen.getByTestId("config-step-setFee-drift-actual").textContent).toContain("999");
    expect(screen.getByTestId("config-step-setFee-drift-message").textContent).toContain(
      "Expected 500 but got 999",
    );
  });

  it("clicking the drift badge again collapses the detail panel", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500, actual: 999 }]}
      />,
    );

    const badge = screen.getByTestId("config-step-setFee-drift");
    fireEvent.click(badge);
    expect(screen.queryByTestId("config-step-setFee-drift-detail")).not.toBeNull();
    fireEvent.click(badge);
    expect(screen.queryByTestId("config-step-setFee-drift-detail")).toBeNull();
  });

  it("the badge is keyboard-activatable (Enter key toggles the panel)", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500, actual: 999 }]}
      />,
    );
    const badge = screen.getByTestId("config-step-setFee-drift");
    fireEvent.keyDown(badge, { key: "Enter" });
    expect(screen.queryByTestId("config-step-setFee-drift-detail")).not.toBeNull();
  });

  it("a detail panel is offered for a 'match' step too, but with no Re-apply button", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "match", expected: 500, actual: 500 }]}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.getByTestId("config-step-setFee-drift-detail")).not.toBeNull();
    expect(screen.queryByTestId("config-step-setFee-reapply")).toBeNull();
  });

  it("stringifies a non-string expected/actual value (object) as JSON, not [object Object]", () => {
    render(
      <Inspector
        view={view}
        driftResults={[
          {
            id: "setFee",
            status: "drift",
            expected: { role: "MINTER_ROLE", account: "0xabc" },
            actual: { role: "MINTER_ROLE", account: "0xdef" },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.getByTestId("config-step-setFee-drift-expected").textContent).toContain("0xabc");
    expect(screen.getByTestId("config-step-setFee-drift-actual").textContent).toContain("0xdef");
    expect(screen.getByTestId("config-step-setFee-drift-expected").textContent).not.toContain(
      "[object Object]",
    );
  });

  it("truncates a very long expected/actual value instead of rendering it in full", () => {
    const longValue = "x".repeat(5000);
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: longValue, actual: "short" }]}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    const expectedEl = screen.getByTestId("config-step-setFee-drift-expected");
    expect(expectedEl.textContent!.length).toBeLessThan(longValue.length);
    expect(expectedEl.textContent).toContain("truncated");
  });

  it("falls back to String() when JSON.stringify throws (e.g. a BigInt value)", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500n, actual: 999 }]}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    // JSON.stringify(500n) throws a TypeError; the fallback String(500n) is "500".
    expect(screen.getByTestId("config-step-setFee-drift-expected").textContent).toContain("500");
  });

  it("renders no message row when drift.message is undefined", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500, actual: 999 }]}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.queryByTestId("config-step-setFee-drift-message")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspector — Re-apply button (issue #153)
// ---------------------------------------------------------------------------

describe("Inspector — Re-apply button", () => {
  it("renders a Re-apply button for a 'drift' status step once the panel is expanded", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500, actual: 999 }]}
        onReapplyStep={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    const btn = screen.getByTestId("config-step-setFee-reapply");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Re-apply");
  });

  it("renders a Re-apply button for an 'error' status step", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "error", expected: null, actual: null, message: "boom" }]}
        onReapplyStep={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.getByTestId("config-step-setFee-reapply")).not.toBeNull();
  });

  it("does NOT render a Re-apply button for a 'match' status step", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "match", expected: 500, actual: 500 }]}
        onReapplyStep={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.queryByTestId("config-step-setFee-reapply")).toBeNull();
  });

  it("does NOT render a Re-apply button for a 'skipped' status step", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "skipped", expected: null, actual: null }]}
        onReapplyStep={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.queryByTestId("config-step-setFee-reapply")).toBeNull();
  });

  it("clicking Re-apply calls onReapplyStep with the step's id", () => {
    const onReapplyStep = vi.fn();
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500, actual: 999 }]}
        onReapplyStep={onReapplyStep}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    fireEvent.click(screen.getByTestId("config-step-setFee-reapply"));
    expect(onReapplyStep).toHaveBeenCalledTimes(1);
    expect(onReapplyStep).toHaveBeenCalledWith("setFee");
  });

  it("no Re-apply button is rendered at all when onReapplyStep is omitted, even for a drifted step", () => {
    render(
      <Inspector
        view={view}
        driftResults={[{ id: "setFee", status: "drift", expected: 500, actual: 999 }]}
      />,
    );
    fireEvent.click(screen.getByTestId("config-step-setFee-drift"));
    expect(screen.queryByTestId("config-step-setFee-reapply")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspector — source-verification badges (issue #138)
// ---------------------------------------------------------------------------

describe("Inspector — source-verification badges", () => {
  it("renders no verified badge for a node when sourceVerifyResults is absent", () => {
    render(<Inspector view={view} />);
    expect(screen.queryByTestId("inspector-node-token-verified")).toBeNull();
  });

  it("renders a 'verified' badge for a contract present in sourceVerifyResults", () => {
    render(
      <Inspector
        view={view}
        sourceVerifyResults={[{ id: "token", address: "0x2222222222222222222222222222222222222222", status: "verified" }]}
      />,
    );
    const badge = screen.getByTestId("inspector-node-token-verified");
    expect(badge.textContent).toBe("verified");
  });

  it("renders distinct statuses ('failed', 'skipped') for different contracts", () => {
    render(
      <Inspector
        view={view}
        sourceVerifyResults={[
          { id: "token", address: "0x2222222222222222222222222222222222222222", status: "failed", message: "no match" },
          { id: "vault", address: "0x3333333333333333333333333333333333333333", status: "skipped", message: "no source" },
        ]}
      />,
    );
    expect(screen.getByTestId("inspector-node-token-verified").textContent).toBe("failed");
    expect(screen.getByTestId("inspector-node-vault-verified").textContent).toBe("skipped");
  });

  it("does not render a verified badge for a contract absent from sourceVerifyResults", () => {
    render(
      <Inspector
        view={view}
        sourceVerifyResults={[{ id: "token", address: "0x2222222222222222222222222222222222222222", status: "verified" }]}
      />,
    );
    expect(screen.getByTestId("inspector-node-token-verified")).not.toBeNull();
    expect(screen.queryByTestId("inspector-node-vault-verified")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspector — apply-config failure badges (issue #151)
// ---------------------------------------------------------------------------

describe("Inspector — apply-config failure badges", () => {
  it("renders no apply-status badge for a step when applyConfigResults is absent", () => {
    render(<Inspector view={view} />);
    expect(screen.queryByTestId("config-step-setFee-apply-status")).toBeNull();
  });

  it("renders a 'failed' apply-status badge for a step with status 'failed', carrying the message as its title", () => {
    render(
      <Inspector
        view={view}
        applyConfigResults={[
          { stepId: "setFee", kind: "setX", status: "failed", message: "revert: fee too high" },
        ]}
      />,
    );
    const badge = screen.getByTestId("config-step-setFee-apply-status");
    expect(badge.textContent).toBe("failed");
    expect(badge.title).toBe("revert: fee too high");
  });

  it("does not render an apply-status badge for a step whose applyConfigResults entry is 'completed' (not 'failed')", () => {
    render(
      <Inspector
        view={view}
        applyConfigResults={[{ stepId: "setFee", kind: "setX", status: "completed" }]}
      />,
    );
    expect(screen.queryByTestId("config-step-setFee-apply-status")).toBeNull();
    // The pre-existing completed/pending badge is unaffected by applyConfigResults.
    expect(screen.getByTestId("config-step-setFee-status").textContent).toBe("completed");
  });

  it("does not render an apply-status badge for a step absent from applyConfigResults", () => {
    render(
      <Inspector
        view={view}
        applyConfigResults={[
          { stepId: "setToken", kind: "wire", status: "failed", message: "boom" },
        ]}
      />,
    );
    expect(screen.getByTestId("config-step-setToken-apply-status")).not.toBeNull();
    expect(screen.queryByTestId("config-step-setFee-apply-status")).toBeNull();
  });
});

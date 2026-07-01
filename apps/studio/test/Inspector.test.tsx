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

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
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

/**
 * SnapshotViewer.test.tsx
 *
 * Tests for the read-only SnapshotViewer component (issue #105). Renders a
 * realistic sample DeploymentSnapshot and asserts the metadata panel and
 * contracts list are visible via their data-testids, WITHOUT depending on
 * React Flow canvas layout (jsdom does not compute canvas layout reliably —
 * mirrors Inspector.test.tsx's approach of asserting on plain-DOM testids).
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SnapshotViewer } from "../src/components/SnapshotViewer.js";
import type { DeploymentSnapshot } from "@redeploy/reader";

const SAMPLE_SNAPSHOT: DeploymentSnapshot = {
  snapshotVersion: 1,
  takenAt: "2026-07-05T12:00:00.000Z",
  chainId: 11155111,
  network: "sepolia",
  toolVersion: "0.3.1",
  specHash: "abc123def456",
  contracts: [
    {
      id: "registry",
      contractName: "Registry",
      address: "0x1111111111111111111111111111111111111111",
      args: [],
      links: { dependencies: [], libraries: {} },
    },
    {
      id: "token",
      contractName: "ERC20Token",
      address: "0x2222222222222222222222222222222222222222",
      args: ["My Token", { $bigint: "1000000000000000000" }],
      links: { dependencies: [], libraries: {} },
    },
    {
      id: "vault",
      contractName: "Vault",
      address: null,
      args: [],
      links: { dependencies: ["token", "registry"], libraries: {} },
    },
  ],
  configSteps: [
    { id: "setFee", kind: "functionCall", completed: true, completedAt: "2024-01-01T00:00:00.000Z" },
    { id: "setToken", kind: "functionCall", completed: false, completedAt: null },
  ],
  warnings: [],
};

describe("SnapshotViewer — metadata panel", () => {
  it("renders without crashing", () => {
    const { container } = render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders the takenAt timestamp", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-taken-at").textContent).toBe(
      "2026-07-05T12:00:00.000Z",
    );
  });

  it("renders the chainId", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-chain-id").textContent).toBe("11155111");
  });

  it("renders the network when present", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-network").textContent).toBe("sepolia");
  });

  it("omits the network row when absent", () => {
    const withoutNetwork: DeploymentSnapshot = {
      ...SAMPLE_SNAPSHOT,
      network: undefined,
    };
    delete (withoutNetwork as { network?: string }).network;
    render(<SnapshotViewer snapshot={withoutNetwork} />);
    expect(screen.queryByTestId("snapshot-network")).toBeNull();
  });

  it("renders the toolVersion", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-tool-version").textContent).toBe("0.3.1");
  });

  it("renders the specHash", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-spec-hash").textContent).toBe("abc123def456");
  });
});

describe("SnapshotViewer — contracts panel", () => {
  it("renders the deployed address for registry", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-contract-registry-address").textContent).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("renders the deployed address for token", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-contract-token-address").textContent).toBe(
      "0x2222222222222222222222222222222222222222",
    );
  });

  it('renders "(not deployed)" for a null-address contract (vault)', () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-contract-vault-address").textContent).toBe(
      "(not deployed)",
    );
  });

  it("renders the string constructor arg for token", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-contract-token-arg-0").textContent).toContain(
      "My Token",
    );
  });

  it("renders the bigint constructor arg for token as its decimal string", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-contract-token-arg-1").textContent).toContain(
      "1000000000000000000",
    );
  });

  it("renders all three contracts' ids and names", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("snapshot-contract-registry").textContent).toContain("Registry");
    expect(screen.getByTestId("snapshot-contract-token").textContent).toContain("ERC20Token");
    expect(screen.getByTestId("snapshot-contract-vault").textContent).toContain("Vault");
  });
});

describe("SnapshotViewer — composes the underlying Inspector", () => {
  it("renders the Inspector's config-steps panel", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(screen.getByTestId("inspector-config-panel")).not.toBeNull();
  });

  it("renders the Inspector's saved-snapshot context badge", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    const badge = screen.getByTestId("inspector-context-badge");
    expect(badge.textContent).toBe(
      `Saved snapshot (${SAMPLE_SNAPSHOT.takenAt})`,
    );
  });

  it("renders the React Flow canvas", () => {
    render(<SnapshotViewer snapshot={SAMPLE_SNAPSHOT} />);
    expect(document.querySelector(".react-flow")).not.toBeNull();
  });
});

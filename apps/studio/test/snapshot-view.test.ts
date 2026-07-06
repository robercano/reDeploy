/**
 * snapshot-view.test.ts
 *
 * Tests for the pure, browser-safe snapshot-view helpers (issue #105):
 *   - `snapshotToDeploymentView`: maps a DeploymentSnapshot's
 *     contracts/configSteps/warnings straight through to a DeploymentView.
 *   - `parseSnapshot`: validates a JSON-parsed `unknown` into a
 *     DeploymentSnapshot, throwing a clear Error for each class of invalid
 *     input.
 */

import { describe, it, expect } from "vitest";
import {
  snapshotToDeploymentView,
  parseSnapshot,
} from "../src/inspector/snapshot-view.js";
import type { DeploymentSnapshot } from "@redeploy/reader";

// ---------------------------------------------------------------------------
// A realistic sample DeploymentSnapshot fixture
// ---------------------------------------------------------------------------

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
  warnings: ["skipped malformed journal line 12"],
};

function clone(snap: DeploymentSnapshot): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// snapshotToDeploymentView
// ---------------------------------------------------------------------------

describe("snapshotToDeploymentView", () => {
  it("maps contracts, configSteps, and warnings straight through", () => {
    const view = snapshotToDeploymentView(SAMPLE_SNAPSHOT);
    expect(view.contracts).toEqual(SAMPLE_SNAPSHOT.contracts);
    expect(view.configSteps).toEqual(SAMPLE_SNAPSHOT.configSteps);
    expect(view.warnings).toEqual(SAMPLE_SNAPSHOT.warnings);
  });

  it("does not include snapshot-only metadata fields", () => {
    const view = snapshotToDeploymentView(SAMPLE_SNAPSHOT);
    expect(view).not.toHaveProperty("takenAt");
    expect(view).not.toHaveProperty("chainId");
    expect(view).not.toHaveProperty("specHash");
  });

  it("handles an empty deployment", () => {
    const empty: DeploymentSnapshot = {
      ...SAMPLE_SNAPSHOT,
      contracts: [],
      configSteps: [],
      warnings: [],
    };
    const view = snapshotToDeploymentView(empty);
    expect(view.contracts).toEqual([]);
    expect(view.configSteps).toEqual([]);
    expect(view.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSnapshot — valid input
// ---------------------------------------------------------------------------

describe("parseSnapshot — valid input", () => {
  it("accepts a valid snapshot round-tripped through JSON", () => {
    const raw = JSON.parse(JSON.stringify(SAMPLE_SNAPSHOT)) as unknown;
    const parsed = parseSnapshot(raw);
    expect(parsed).toEqual(SAMPLE_SNAPSHOT);
  });

  it("accepts a valid snapshot without the optional `network` field", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    delete raw["network"];
    const parsed = parseSnapshot(raw);
    expect(parsed.network).toBeUndefined();
    expect(parsed.chainId).toBe(SAMPLE_SNAPSHOT.chainId);
  });

  it("accepts contracts with empty args/links and a null address", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    const parsed = parseSnapshot(raw);
    const vault = parsed.contracts.find((c) => c.id === "vault");
    expect(vault?.address).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSnapshot — invalid input, one case per required field
// ---------------------------------------------------------------------------

describe("parseSnapshot — invalid input", () => {
  it("throws when the input is not an object", () => {
    expect(() => parseSnapshot("not an object")).toThrow(/expected a JSON object/);
    expect(() => parseSnapshot(null)).toThrow();
    expect(() => parseSnapshot(42)).toThrow();
    expect(() => parseSnapshot(["array", "not", "object"])).toThrow();
  });

  it("throws when snapshotVersion is missing/wrong-typed", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["snapshotVersion"] = "1";
    expect(() => parseSnapshot(raw)).toThrow(/snapshotVersion/);
  });

  it("throws when takenAt is missing/wrong-typed", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    delete raw["takenAt"];
    expect(() => parseSnapshot(raw)).toThrow(/takenAt/);
  });

  it("throws when chainId is missing/wrong-typed", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["chainId"] = "11155111";
    expect(() => parseSnapshot(raw)).toThrow(/chainId/);
  });

  it("throws when network is present but wrong-typed", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["network"] = 42;
    expect(() => parseSnapshot(raw)).toThrow(/network/);
  });

  it("throws when toolVersion is missing/wrong-typed", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["toolVersion"] = 123;
    expect(() => parseSnapshot(raw)).toThrow(/toolVersion/);
  });

  it("throws when specHash is missing/wrong-typed", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    delete raw["specHash"];
    expect(() => parseSnapshot(raw)).toThrow(/specHash/);
  });

  it("throws when contracts is not an array", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["contracts"] = {};
    expect(() => parseSnapshot(raw)).toThrow(/contracts/);
  });

  it("throws when a contract entry has an invalid shape (missing id)", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    (raw["contracts"] as Array<Record<string, unknown>>)[0]!["id"] = 42;
    expect(() => parseSnapshot(raw)).toThrow(/contracts/);
  });

  it("throws when a contract's address is a non-string, non-null value", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    (raw["contracts"] as Array<Record<string, unknown>>)[0]!["address"] = 42;
    expect(() => parseSnapshot(raw)).toThrow(/contracts/);
  });

  it("throws when configSteps is not an array", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["configSteps"] = "nope";
    expect(() => parseSnapshot(raw)).toThrow(/configSteps/);
  });

  it("throws when a configStep entry has an invalid shape (completed not boolean)", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    (raw["configSteps"] as Array<Record<string, unknown>>)[0]!["completed"] = "yes";
    expect(() => parseSnapshot(raw)).toThrow(/configSteps/);
  });

  it("throws when warnings is not an array", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["warnings"] = "nope";
    expect(() => parseSnapshot(raw)).toThrow(/warnings/);
  });

  it("throws when warnings contains a non-string entry", () => {
    const raw = clone(SAMPLE_SNAPSHOT);
    raw["warnings"] = [42];
    expect(() => parseSnapshot(raw)).toThrow(/warnings/);
  });
});

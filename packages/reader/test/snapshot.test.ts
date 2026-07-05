import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  buildSnapshot,
  hashSpec,
  snapshotRelativePath,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOTS_DIR,
  readDeployment,
  type DeploymentView,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers (mirroring test/index.test.ts)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-reader-snapshot-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJournal(dir: string, records: object[]): void {
  const lines = records.map((r) => "\n" + JSON.stringify(r));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), lines.join(""), "utf8");
}

function writeConfigState(dir: string, records: object[]): void {
  const content = records.map((r) => JSON.stringify(r) + "\n").join("");
  fs.writeFileSync(path.join(dir, "config-state.jsonl"), content, "utf8");
}

function writeDeployedAddresses(dir: string, addresses: Record<string, string>): void {
  fs.writeFileSync(
    path.join(dir, "deployed_addresses.json"),
    JSON.stringify(addresses),
    "utf8",
  );
}

function seedFullFixture(dir: string): void {
  writeJournal(dir, [
    {
      type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
      futureId: "Deployment#registry",
      contractName: "Registry",
      constructorArgs: [],
      libraries: {},
      dependencies: [],
    },
    {
      type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
      futureId: "Deployment#registry",
      result: { type: "SUCCESS", address: "0x1111111111111111111111111111111111111111" },
    },
    {
      type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
      futureId: "Deployment#token",
      contractName: "Token",
      constructorArgs: ["My Token", "1000000000000000000n", { _kind: "bigint", value: "500" }],
      libraries: {},
      dependencies: ["Deployment#registry"],
    },
    {
      type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
      futureId: "Deployment#token",
      result: { type: "SUCCESS", address: "0x2222222222222222222222222222222222222222" },
    },
  ]);
  writeDeployedAddresses(dir, {
    "Deployment#registry": "0x1111111111111111111111111111111111111111",
    "Deployment#token": "0x2222222222222222222222222222222222222222",
  });
  writeConfigState(dir, [
    { id: "setFee", kind: "functionCall", completedAt: "2024-01-01T00:00:00.000Z" },
  ]);
}

const FIXED_TAKEN_AT = "2026-07-05T12:00:00.000Z";

// ---------------------------------------------------------------------------
// buildSnapshot: fully deployed + configured fixture
// ---------------------------------------------------------------------------

describe("buildSnapshot — fully deployed and configured fixture", () => {
  it("captures correct contracts (ids, addresses, args incl. bigint), links, and completed config steps", () => {
    seedFullFixture(tmpDir);

    const snap = buildSnapshot({
      read: { deploymentDir: tmpDir },
      chainId: 11155111,
      network: "sepolia",
      toolVersion: "1.2.3",
      spec: { spec: { modules: ["a", "b"] } },
      takenAt: FIXED_TAKEN_AT,
    });

    expect(snap.snapshotVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snap.takenAt).toBe(FIXED_TAKEN_AT);
    expect(snap.chainId).toBe(11155111);
    expect(snap.network).toBe("sepolia");
    expect(snap.toolVersion).toBe("1.2.3");
    expect(typeof snap.specHash).toBe("string");
    expect(snap.specHash).toHaveLength(64); // sha256 hex digest

    expect(snap.contracts).toHaveLength(2);
    const token = snap.contracts.find((c) => c.id === "token");
    expect(token).toBeDefined();
    expect(token!.contractName).toBe("Token");
    expect(token!.address).toBe("0x2222222222222222222222222222222222222222");
    expect(token!.args[0]).toBe("My Token");
    expect(token!.args[1]).toEqual({ $bigint: "1000000000000000000" });
    expect(token!.args[2]).toEqual({ $bigint: "500" });
    expect(token!.links.dependencies).toContain("registry");

    const registry = snap.contracts.find((c) => c.id === "registry");
    expect(registry!.address).toBe("0x1111111111111111111111111111111111111111");

    expect(snap.configSteps).toHaveLength(1);
    expect(snap.configSteps[0]).toEqual({
      id: "setFee",
      kind: "functionCall",
      completed: true,
      completedAt: "2024-01-01T00:00:00.000Z",
    });

    expect(snap.warnings).toHaveLength(0);
  });

  it("accepts a pre-read DeploymentView via the `deployment` option (no re-read)", () => {
    seedFullFixture(tmpDir);
    const view: DeploymentView = readDeployment({ deploymentDir: tmpDir });

    const snap = buildSnapshot({
      deployment: view,
      chainId: 1,
      toolVersion: "1.0.0",
      spec: { spec: {} },
      takenAt: FIXED_TAKEN_AT,
    });

    expect(snap.contracts).toEqual(view.contracts);
    expect(snap.configSteps).toEqual(view.configSteps);
    expect(snap.network).toBeUndefined();
  });

  it("throws when both `deployment` and `read` are provided", () => {
    const view: DeploymentView = { contracts: [], configSteps: [], warnings: [] };
    expect(() =>
      buildSnapshot({
        deployment: view,
        read: { deploymentDir: tmpDir },
        chainId: 1,
        toolVersion: "1.0.0",
        spec: { spec: {} },
      }),
    ).toThrow();
  });

  it("throws when neither `deployment` nor `read` are provided", () => {
    expect(() =>
      buildSnapshot({
        chainId: 1,
        toolVersion: "1.0.0",
        spec: { spec: {} },
      } as Parameters<typeof buildSnapshot>[0]),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("buildSnapshot — determinism", () => {
  it("produces deep-equal and JSON-string-equal output for identical inputs + fixed takenAt", () => {
    seedFullFixture(tmpDir);

    const build = () =>
      buildSnapshot({
        read: { deploymentDir: tmpDir },
        chainId: 42,
        network: "test",
        toolVersion: "9.9.9",
        spec: { spec: { a: 1, b: { c: 2 } } },
        takenAt: FIXED_TAKEN_AT,
      });

    const snap1 = build();
    const snap2 = build();

    expect(snap1).toEqual(snap2);
    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
  });

  it("defaults takenAt to the current time (ISO-8601) when omitted", () => {
    seedFullFixture(tmpDir);

    const before = Date.now();
    const snap = buildSnapshot({
      read: { deploymentDir: tmpDir },
      chainId: 1,
      toolVersion: "1.0.0",
      spec: { spec: {} },
    });
    const after = Date.now();

    const takenAtMs = new Date(snap.takenAt).getTime();
    expect(takenAtMs).toBeGreaterThanOrEqual(before);
    expect(takenAtMs).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip
// ---------------------------------------------------------------------------

describe("buildSnapshot — JSON round-trip", () => {
  it("JSON.parse(JSON.stringify(snap)) deep-equals snap", () => {
    seedFullFixture(tmpDir);

    const snap = buildSnapshot({
      read: { deploymentDir: tmpDir },
      chainId: 5,
      toolVersion: "1.0.0",
      spec: { spec: { x: [1, 2, { y: "z" }] } },
      takenAt: FIXED_TAKEN_AT,
    });

    const roundTripped = JSON.parse(JSON.stringify(snap)) as unknown;
    expect(roundTripped).toEqual(snap);
  });
});

// ---------------------------------------------------------------------------
// specHash stability
// ---------------------------------------------------------------------------

describe("hashSpec / specHash stability", () => {
  it("produces the same hash for the same spec content with reordered keys", () => {
    const specA = { modules: ["a"], config: { alpha: 1, beta: 2 }, chainId: 1 };
    const specB = { chainId: 1, config: { beta: 2, alpha: 1 }, modules: ["a"] };

    expect(hashSpec(specA)).toBe(hashSpec(specB));
  });

  it("produces a different hash for different spec content", () => {
    const specA = { modules: ["a"] };
    const specB = { modules: ["b"] };

    expect(hashSpec(specA)).not.toBe(hashSpec(specB));
  });

  it("is a sha256 hex digest of the canonical (sorted-key) JSON serialization", () => {
    const spec = { b: 2, a: 1 };
    const expected = crypto
      .createHash("sha256")
      .update(JSON.stringify({ a: 1, b: 2 }), "utf8")
      .digest("hex");

    expect(hashSpec(spec)).toBe(expected);
  });

  it("buildSnapshot uses a caller-precomputed hash verbatim when `spec.hash` is provided", () => {
    seedFullFixture(tmpDir);

    const snap = buildSnapshot({
      read: { deploymentDir: tmpDir },
      chainId: 1,
      toolVersion: "1.0.0",
      spec: { hash: "deadbeef" },
      takenAt: FIXED_TAKEN_AT,
    });

    expect(snap.specHash).toBe("deadbeef");
  });

  it("array order is significant (canonicalization does not reorder arrays)", () => {
    const specA = { list: [1, 2, 3] };
    const specB = { list: [3, 2, 1] };

    expect(hashSpec(specA)).not.toBe(hashSpec(specB));
  });
});

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

describe("snapshotRelativePath", () => {
  it("sanitizes colons in the timestamp and produces the expected shape", () => {
    const p = snapshotRelativePath("2026-07-05T12:00:00.000Z");
    expect(p).toBe(`${SNAPSHOTS_DIR}/2026-07-05T12-00-00.000Z.json`);
  });

  it("returns a path rooted at the snapshots/ directory ending in .json", () => {
    const p = snapshotRelativePath("2026-01-01T00:00:00.000Z");
    expect(p.startsWith("snapshots/")).toBe(true);
    expect(p.endsWith(".json")).toBe(true);
  });

  it("does not perform any filesystem access", () => {
    // Use a nonexistent path fragment; if this touched the filesystem it
    // would have no observable effect either way, but we assert no throw
    // occurs even for a directory that doesn't exist and is never created.
    const before = fs.readdirSync(tmpDir);
    const result = snapshotRelativePath("2026-01-01T00:00:00.000Z");
    const after = fs.readdirSync(tmpDir);

    expect(result).toBeTruthy();
    expect(after).toEqual(before);
  });

  it("is a pure function: identical input always yields identical output", () => {
    const a = snapshotRelativePath(FIXED_TAKEN_AT);
    const b = snapshotRelativePath(FIXED_TAKEN_AT);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty / partial deployment
// ---------------------------------------------------------------------------

describe("buildSnapshot — edge cases", () => {
  it("handles an empty deployment (no journal, no contracts) without throwing", () => {
    // tmpDir is empty — no journal.jsonl, no deployed_addresses.json, no config-state.jsonl
    const snap = buildSnapshot({
      read: { deploymentDir: tmpDir },
      chainId: 1,
      toolVersion: "1.0.0",
      spec: { spec: {} },
      takenAt: FIXED_TAKEN_AT,
    });

    expect(snap.contracts).toHaveLength(0);
    expect(snap.configSteps).toHaveLength(0);
    expect(snap.warnings).toHaveLength(0);
  });

  it("handles a partial deployment (address: null) without throwing", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#incomplete",
        contractName: "Incomplete",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
      // No COMPLETE record — contract never finished deploying.
    ]);
    writeDeployedAddresses(tmpDir, {});

    const snap = buildSnapshot({
      read: { deploymentDir: tmpDir },
      chainId: 1,
      toolVersion: "1.0.0",
      spec: { spec: {} },
      takenAt: FIXED_TAKEN_AT,
    });

    expect(snap.contracts).toHaveLength(1);
    expect(snap.contracts[0].address).toBeNull();
  });

  it("round-trips a fully empty deployment view through JSON", () => {
    const emptyView: DeploymentView = { contracts: [], configSteps: [], warnings: [] };
    const snap = buildSnapshot({
      deployment: emptyView,
      chainId: 1,
      toolVersion: "1.0.0",
      spec: { spec: {} },
      takenAt: FIXED_TAKEN_AT,
    });

    const roundTripped = JSON.parse(JSON.stringify(snap)) as unknown;
    expect(roundTripped).toEqual(snap);
  });
});

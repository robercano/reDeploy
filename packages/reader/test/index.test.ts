import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readDeployment,
  ReadError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-reader-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write Ignition's journal.jsonl format:
 * Each record is prepended with "\n" + JSON.stringify(record).
 * File starts with a blank line, no trailing newline.
 */
function writeJournal(dir: string, records: object[]): void {
  const lines = records.map((r) => "\n" + JSON.stringify(r));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), lines.join(""), "utf8");
}

/**
 * Write config-state.jsonl format: standard NDJSON, one record per line,
 * lines terminated by "\n".
 */
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

// ---------------------------------------------------------------------------
// Test 1: Fully deployed + fully configured fixture
// ---------------------------------------------------------------------------

describe("fully deployed and configured", () => {
  it("returns correct contracts with ids, addresses, args (including bigint), and links", () => {
    // Journal: registry (no args, no links), token (bigint arg + _kind bigint arg), vault (library + ref dep)
    writeJournal(tmpDir, [
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
        // constructorArgs: name (string) + initialSupply (bigint string form) + fee (_kind form)
        constructorArgs: ["My Token", "1000000000000000000n", { _kind: "bigint", value: "500" }],
        libraries: {},
        dependencies: [],
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
        futureId: "Deployment#token",
        result: { type: "SUCCESS", address: "0x2222222222222222222222222222222222222222" },
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#vault",
        contractName: "Vault",
        constructorArgs: [],
        // library link: SafeMath → another contract
        libraries: { SafeMath: "Deployment#mathLib" },
        // dependency: token (futureId form)
        dependencies: ["Deployment#token", "Deployment#registry"],
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
        futureId: "Deployment#vault",
        result: { type: "SUCCESS", address: "0x3333333333333333333333333333333333333333" },
      },
    ]);

    writeDeployedAddresses(tmpDir, {
      "Deployment#registry": "0x1111111111111111111111111111111111111111",
      "Deployment#token": "0x2222222222222222222222222222222222222222",
      "Deployment#vault": "0x3333333333333333333333333333333333333333",
    });

    writeConfigState(tmpDir, [
      { id: "setFee", kind: "functionCall", completedAt: "2024-01-01T00:00:00.000Z" },
      { id: "setToken", kind: "functionCall", completedAt: "2024-01-01T00:01:00.000Z" },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });

    // --- Contracts ---
    expect(view.contracts).toHaveLength(3);

    const registry = view.contracts.find((c) => c.id === "registry");
    expect(registry).toBeDefined();
    expect(registry!.contractName).toBe("Registry");
    expect(registry!.address).toBe("0x1111111111111111111111111111111111111111");
    expect(registry!.args).toHaveLength(0);
    expect(registry!.links.dependencies).toHaveLength(0);
    expect(Object.keys(registry!.links.libraries)).toHaveLength(0);

    const token = view.contracts.find((c) => c.id === "token");
    expect(token).toBeDefined();
    expect(token!.contractName).toBe("Token");
    expect(token!.address).toBe("0x2222222222222222222222222222222222222222");
    // First arg: string
    expect(token!.args[0]).toBe("My Token");
    // Second arg: bigint string form → BigIntValue
    expect(token!.args[1]).toEqual({ $bigint: "1000000000000000000" });
    // Third arg: _kind object form → BigIntValue
    expect(token!.args[2]).toEqual({ $bigint: "500" });

    const vault = view.contracts.find((c) => c.id === "vault");
    expect(vault).toBeDefined();
    expect(vault!.contractName).toBe("Vault");
    expect(vault!.address).toBe("0x3333333333333333333333333333333333333333");
    // Library link: SafeMath → "mathLib" (prefix stripped)
    expect(vault!.links.libraries["SafeMath"]).toBe("mathLib");
    // Dependencies: prefix-stripped
    expect(vault!.links.dependencies).toContain("token");
    expect(vault!.links.dependencies).toContain("registry");

    // --- Config steps ---
    expect(view.configSteps).toHaveLength(2);
    const setFee = view.configSteps.find((s) => s.id === "setFee");
    expect(setFee!.completed).toBe(true);
    expect(setFee!.completedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(setFee!.kind).toBe("functionCall");

    const setToken = view.configSteps.find((s) => s.id === "setToken");
    expect(setToken!.completed).toBe(true);

    // No warnings expected
    expect(view.warnings).toHaveLength(0);
  });

  it("round-trips nested array constructor args", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#multi",
        contractName: "Multi",
        constructorArgs: [[1, 2, 3], ["a", "b"]],
        libraries: {},
        dependencies: [],
      },
    ]);
    writeDeployedAddresses(tmpDir, {
      "Deployment#multi": "0xaaaa",
    });

    const view = readDeployment({ deploymentDir: tmpDir });
    const multi = view.contracts.find((c) => c.id === "multi");
    expect(multi!.args[0]).toEqual([1, 2, 3]);
    expect(multi!.args[1]).toEqual(["a", "b"]);
  });

  it("round-trips nested object constructor args", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#cfg",
        contractName: "Config",
        constructorArgs: [{ owner: "0xabcd", fee: "100n" }],
        libraries: {},
        dependencies: [],
      },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });
    const cfg = view.contracts.find((c) => c.id === "cfg");
    expect(cfg!.args[0]).toEqual({ owner: "0xabcd", fee: { $bigint: "100" } });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Partial configuration (some steps completed, some expected but absent)
// ---------------------------------------------------------------------------

describe("partial configuration", () => {
  it("reports completed steps from journal and absent expected steps as incomplete", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#token",
        contractName: "Token",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
    ]);
    writeDeployedAddresses(tmpDir, {
      "Deployment#token": "0x1234",
    });

    // Only "stepA" completed; "stepB" expected but absent
    writeConfigState(tmpDir, [
      { id: "stepA", kind: "functionCall", completedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    const view = readDeployment({
      deploymentDir: tmpDir,
      expectedConfigStepIds: ["stepA", "stepB", "stepC"],
    });

    const stepA = view.configSteps.find((s) => s.id === "stepA");
    expect(stepA!.completed).toBe(true);
    expect(stepA!.completedAt).toBe("2024-01-01T00:00:00.000Z");

    const stepB = view.configSteps.find((s) => s.id === "stepB");
    expect(stepB).toBeDefined();
    expect(stepB!.completed).toBe(false);
    expect(stepB!.completedAt).toBeNull();

    const stepC = view.configSteps.find((s) => s.id === "stepC");
    expect(stepC).toBeDefined();
    expect(stepC!.completed).toBe(false);
    expect(stepC!.completedAt).toBeNull();

    // Total: 3 steps (1 completed + 2 expected-but-absent)
    expect(view.configSteps).toHaveLength(3);
  });

  it("reports only journaled steps when expectedConfigStepIds is omitted", () => {
    writeJournal(tmpDir, []);
    writeConfigState(tmpDir, [
      { id: "stepA", kind: "functionCall", completedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.configSteps).toHaveLength(1);
    expect(view.configSteps[0].id).toBe("stepA");
    expect(view.configSteps[0].completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Missing deployment directory → throws ReadError
// ---------------------------------------------------------------------------

describe("missing deployment directory", () => {
  it("throws ReadError with code DEPLOYMENT_DIR_NOT_FOUND", () => {
    const missingDir = path.join(tmpDir, "does-not-exist");

    expect(() => readDeployment({ deploymentDir: missingDir })).toThrow(ReadError);

    try {
      readDeployment({ deploymentDir: missingDir });
    } catch (err) {
      expect(err instanceof ReadError).toBe(true);
      expect((err as ReadError).code).toBe("DEPLOYMENT_DIR_NOT_FOUND");
      expect((err as ReadError).name).toBe("ReadError");
    }
  });

  it("throws ReadError when deploymentDir is a file not a directory", () => {
    const filePath = path.join(tmpDir, "notadir");
    fs.writeFileSync(filePath, "hello");

    try {
      readDeployment({ deploymentDir: filePath });
      expect.fail("Expected ReadError to be thrown");
    } catch (err) {
      expect(err instanceof ReadError).toBe(true);
      expect((err as ReadError).code).toBe("DEPLOYMENT_DIR_NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Corrupt/malformed journal lines — defensive handling
// ---------------------------------------------------------------------------

describe("corrupt journal lines", () => {
  it("skips malformed lines and reports them in warnings, good records survive", () => {
    // Mix of valid, invalid JSON, and partial-write trailing line
    const content = [
      "", // leading blank (normal Ignition format)
      JSON.stringify({
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#good",
        contractName: "Good",
        constructorArgs: ["hello"],
        libraries: {},
        dependencies: [],
      }),
      "this is not valid json {{{",
      '{"type": "DEPLOYMENT_EXECUTION_STATE_INITIALIZE"', // truncated (partial write)
      JSON.stringify({
        type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
        futureId: "Deployment#good",
        result: { type: "SUCCESS", address: "0x9999" },
      }),
    ].join("\n");

    fs.writeFileSync(path.join(tmpDir, "journal.jsonl"), content, "utf8");

    const view = readDeployment({ deploymentDir: tmpDir });

    // Good contract survived
    expect(view.contracts).toHaveLength(1);
    expect(view.contracts[0].id).toBe("good");
    expect(view.contracts[0].address).toBe("0x9999");

    // Warnings collected for bad lines
    expect(view.warnings.length).toBeGreaterThan(0);
    // At least two warnings for the two bad lines
    expect(view.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("skips INIT message with missing required fields and warns", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        // Missing futureId
        contractName: "Orphan",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#ok",
        contractName: "Ok",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });

    // Only the valid one survives
    expect(view.contracts).toHaveLength(1);
    expect(view.contracts[0].id).toBe("ok");

    // Warning for the incomplete one
    expect(view.warnings.some((w) => w.includes("DEPLOYMENT_EXECUTION_STATE_INITIALIZE"))).toBe(true);
  });

  it("skips malformed config-state lines and warns, good records survive", () => {
    writeJournal(tmpDir, []);

    // Config journal with one valid record and one malformed line
    const content =
      JSON.stringify({ id: "stepGood", kind: "functionCall", completedAt: "2024-01-01T00:00:00.000Z" }) +
      "\n" +
      "not valid json" +
      "\n" +
      JSON.stringify({ id: "", kind: "x", completedAt: "x" }) + // empty id — invalid
      "\n";
    fs.writeFileSync(path.join(tmpDir, "config-state.jsonl"), content, "utf8");

    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.configSteps).toHaveLength(1);
    expect(view.configSteps[0].id).toBe("stepGood");
    expect(view.configSteps[0].completed).toBe(true);

    // Warnings for two bad lines
    expect(view.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Partial deployment — INITIALIZE present, no COMPLETE, not in deployed_addresses
// ---------------------------------------------------------------------------

describe("partial deployment (contract never completed)", () => {
  it("returns address: null for a contract that was initialized but never completed", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#incomplete",
        contractName: "Incomplete",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
      // No COMPLETE record
    ]);
    // deployed_addresses.json does NOT contain "Deployment#incomplete"
    writeDeployedAddresses(tmpDir, {});

    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.contracts).toHaveLength(1);
    expect(view.contracts[0].id).toBe("incomplete");
    expect(view.contracts[0].address).toBeNull();
  });

  it("uses COMPLETE message address as fallback when deployed_addresses.json is absent", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#c1",
        contractName: "C1",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
      {
        type: "DEPLOYMENT_EXECUTION_STATE_COMPLETE",
        futureId: "Deployment#c1",
        result: { type: "SUCCESS", address: "0xAAAA" },
      },
    ]);
    // No deployed_addresses.json

    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.contracts[0].address).toBe("0xAAAA");
  });
});

// ---------------------------------------------------------------------------
// Test 6: _kind bigint form in args (explicit test for that branch)
// ---------------------------------------------------------------------------

describe("bigint serialization forms", () => {
  it("handles _kind:bigint object form in args", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#c",
        contractName: "C",
        constructorArgs: [{ _kind: "bigint", value: "999999999999999999" }],
        libraries: {},
        dependencies: [],
      },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });
    expect(view.contracts[0].args[0]).toEqual({ $bigint: "999999999999999999" });
  });

  it("handles Nn string form in args", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#c",
        contractName: "C",
        constructorArgs: ["12345678901234567890n"],
        libraries: {},
        dependencies: [],
      },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });
    expect(view.contracts[0].args[0]).toEqual({ $bigint: "12345678901234567890" });
  });
});

// ---------------------------------------------------------------------------
// Test 7: explicit moduleId option
// ---------------------------------------------------------------------------

describe("explicit moduleId option", () => {
  it("respects explicitly provided moduleId for prefix stripping", () => {
    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "MyModule#myContract",
        contractName: "MyContract",
        constructorArgs: [],
        libraries: {},
        dependencies: ["MyModule#other"],
      },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir, moduleId: "MyModule" });

    expect(view.contracts[0].id).toBe("myContract");
    expect(view.contracts[0].links.dependencies).toContain("other");
  });
});

// ---------------------------------------------------------------------------
// Test 8: configStateDir option
// ---------------------------------------------------------------------------

describe("configStateDir option", () => {
  it("reads config state from a different directory when configStateDir is provided", () => {
    // Deployment dir has journal
    writeJournal(tmpDir, []);

    // Separate config state dir
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cfg-"));
    try {
      writeConfigState(configDir, [
        { id: "cfgStep1", kind: "functionCall", completedAt: "2024-01-01T00:00:00.000Z" },
      ]);

      const view = readDeployment({
        deploymentDir: tmpDir,
        configStateDir: configDir,
      });

      expect(view.configSteps).toHaveLength(1);
      expect(view.configSteps[0].id).toBe("cfgStep1");
      expect(view.configSteps[0].completed).toBe(true);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: Empty / missing files
// ---------------------------------------------------------------------------

describe("missing optional files", () => {
  it("returns empty contracts and configSteps when journal.jsonl is absent", () => {
    // Just an empty directory — no files
    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.contracts).toHaveLength(0);
    expect(view.configSteps).toHaveLength(0);
    expect(view.warnings).toHaveLength(0);
  });

  it("returns empty contracts when journal is empty (only blank lines)", () => {
    fs.writeFileSync(path.join(tmpDir, "journal.jsonl"), "\n\n", "utf8");

    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.contracts).toHaveLength(0);
    expect(view.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Non-object root in deployed_addresses.json
// ---------------------------------------------------------------------------

describe("malformed deployed_addresses.json", () => {
  it("adds a warning and continues without addresses when file is invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "deployed_addresses.json"), "not json", "utf8");

    writeJournal(tmpDir, [
      {
        type: "DEPLOYMENT_EXECUTION_STATE_INITIALIZE",
        futureId: "Deployment#c",
        contractName: "C",
        constructorArgs: [],
        libraries: {},
        dependencies: [],
      },
    ]);

    const view = readDeployment({ deploymentDir: tmpDir });

    expect(view.contracts[0].address).toBeNull();
    expect(view.warnings.some((w) => w.includes("deployed_addresses.json"))).toBe(true);
  });
});

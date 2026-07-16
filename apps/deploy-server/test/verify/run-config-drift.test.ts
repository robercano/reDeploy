/**
 * Tests for run-config-drift.ts.
 *
 * Exercises the REAL @redeploy/verify verifyConfig() (no mocking of that
 * package — it's a pure/injectable dependency) against a fake ChainReader,
 * so these tests double as an integration check of the wiring between
 * deploy-server's heuristic getter derivation and the real package.
 */

import { describe, it, expect } from "vitest";
import type { ConfigSpec } from "@redeploy/config";
import type { DeploymentView } from "@redeploy/reader";
import type { ChainReader } from "@redeploy/verify";
import { runConfigDrift, validateConfigSpecShape } from "../../src/verify/run-config-drift.js";

function makeDeployment(contracts: DeploymentView["contracts"]): DeploymentView {
  return { contracts, configSteps: [], warnings: [] };
}

const FEE_CONTROLLER = {
  id: "feeController",
  contractName: "FeeController",
  address: "0xFEE0000000000000000000000000000000FEE0",
  args: [],
  links: { dependencies: [], libraries: {} },
};
const TOKEN = {
  id: "token",
  contractName: "Token",
  address: "0xTOKEN0000000000000000000000000000TOKEN0",
  args: [],
  links: { dependencies: [], libraries: {} },
};
const VAULT = {
  id: "vault",
  contractName: "Vault",
  address: "0xVAULT0000000000000000000000000000VAULT0",
  args: [],
  links: { dependencies: [], libraries: {} },
};

describe("validateConfigSpecShape", () => {
  it("accepts a minimal valid shape", () => {
    expect(validateConfigSpecShape({ version: 1, steps: [] })).toBeNull();
  });

  it("accepts orderedSteps when present and an array", () => {
    expect(validateConfigSpecShape({ version: 1, steps: [], orderedSteps: [] })).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(validateConfigSpecShape("not an object")).toContain("JSON object");
    expect(validateConfigSpecShape(null)).toContain("JSON object");
    expect(validateConfigSpecShape([])).toContain("JSON object");
  });

  it("rejects a body missing a steps array", () => {
    expect(validateConfigSpecShape({ version: 1 })).toContain("steps");
  });

  it("rejects orderedSteps that isn't an array", () => {
    expect(validateConfigSpecShape({ version: 1, steps: [], orderedSteps: "nope" })).toContain("orderedSteps");
  });
});

describe("runConfigDrift", () => {
  it("returns clean:true with a 'match' result for a matching setX step", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };
    const reader: ChainReader = { call: async () => 500n };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([FEE_CONTROLLER]), reader });

    expect(result.clean).toBe(true);
    // bigint results are normalized to { $bigint: "<decimal>" } for JSON-safety
    // (JSON.stringify() throws on a raw bigint) — see run-config-drift.ts.
    expect(result.results).toEqual([
      { id: "set-fee", status: "match", expected: 500, actual: { $bigint: "500" } },
    ]);
  });

  it("returns clean:false with a 'drift' result when the on-chain value differs", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };
    const reader: ChainReader = { call: async () => 999n };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([FEE_CONTROLLER]), reader });

    expect(result.clean).toBe(false);
    expect(result.results[0]!.status).toBe("drift");
  });

  it("grantRole steps verify via hasRole without any derived read descriptor", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "grantRole",
          id: "grant-minter",
          target: "token",
          role: "0x1111111111111111111111111111111111111111111111111111111111111111",
          account: { kind: "literal", value: "0xACC0000000000000000000000000000000ACC0" },
        },
      ],
    };
    const reader: ChainReader = { call: async () => true };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([TOKEN]), reader });

    expect(result.clean).toBe(true);
    expect(result.results[0]!.status).toBe("match");
  });

  it("wire steps derive a getter and compare against the resolved source address", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [{ kind: "wire", id: "wire-token-into-vault", source: "token", into: "vault", function: "setToken" }],
    };
    const reader: ChainReader = { call: async () => TOKEN.address };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([TOKEN, VAULT]), reader });

    expect(result.clean).toBe(true);
    expect(result.results[0]!.status).toBe("match");
  });

  it("a step referencing an undeployed contract id becomes an 'error' result — never throws", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };
    const reader: ChainReader = { call: async () => 500n };

    // No contracts deployed at all — feeController is unresolved.
    const result = await runConfigDrift({ spec, deployment: makeDeployment([]), reader });

    expect(result.clean).toBe(false);
    expect(result.results).toEqual([
      {
        id: "set-fee",
        status: "error",
        expected: null,
        actual: null,
        message: expect.stringContaining("feeController"),
      },
    ]);
  });

  it("a setX step with no derivable getter becomes a 'skipped' result — never throws MISSING_GETTER_MAPPING", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "update-fee",
          target: "feeController",
          function: "updateFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };
    const reader: ChainReader = { call: async () => 500n };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([FEE_CONTROLLER]), reader });

    // "skipped" does not count against clean.
    expect(result.clean).toBe(true);
    expect(result.results).toEqual([
      { id: "update-fee", status: "skipped", expected: null, actual: null, message: expect.any(String) },
    ]);
  });

  it("a ChainReader.call failure becomes a per-step 'error' result (from verifyConfig itself)", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
    };
    const reader: ChainReader = {
      call: async () => {
        throw new Error("execution reverted");
      },
    };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([FEE_CONTROLLER]), reader });

    expect(result.clean).toBe(false);
    expect(result.results[0]!.status).toBe("error");
    expect(result.results[0]!.message).toContain("execution reverted");
  });

  it("merges orderedSteps with steps and checks every step exactly once, in original order", async () => {
    const spec: ConfigSpec = {
      version: 1,
      steps: [
        {
          kind: "setX",
          id: "set-fee",
          target: "feeController",
          function: "setFee",
          args: [{ kind: "literal", value: 500 }],
        },
      ],
      orderedSteps: [{ kind: "wire", id: "wire-token-into-vault", source: "token", into: "vault", function: "setToken" }],
    };
    const reader: ChainReader = {
      call: async ({ function: fn }) => (fn === "getFee" ? 500n : TOKEN.address),
    };

    const result = await runConfigDrift({
      spec,
      deployment: makeDeployment([FEE_CONTROLLER, TOKEN, VAULT]),
      reader,
    });

    expect(result.clean).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(["set-fee", "wire-token-into-vault"]);
  });

  it("returns clean:true with no results for an empty spec", async () => {
    const spec: ConfigSpec = { version: 1, steps: [] };
    const reader: ChainReader = { call: async () => null };

    const result = await runConfigDrift({ spec, deployment: makeDeployment([]), reader });

    expect(result).toEqual({ clean: true, results: [] });
  });
});

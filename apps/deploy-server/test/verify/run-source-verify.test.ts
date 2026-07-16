/**
 * Tests for run-source-verify.ts.
 *
 * Exercises the REAL @redeploy/verify verifyDeployment() + createEtherscanClient()
 * (no mocking of that package) against a fake `fetch`, so these tests double
 * as an integration check of the wiring. Foundry artifacts are real temp
 * files on disk (mirrors read-foundry-artifact.test.ts / source-input.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeploymentView } from "@redeploy/reader";
import type { FetchLike } from "@redeploy/verify";
import { runSourceVerify } from "../../src/verify/run-source-verify.js";

let outDir: string;
let contractsRoot: string;

beforeEach(() => {
  contractsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-source-verify-test-"));
  outDir = path.join(contractsRoot, "out");
  fs.mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(contractsRoot, { recursive: true, force: true });
});

function writeArtifact(name: string, sourceRelPath: string, sourceContent: string): void {
  const srcAbs = path.join(contractsRoot, sourceRelPath);
  fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
  fs.writeFileSync(srcAbs, sourceContent);

  const artifactDir = path.join(outDir, `${name}.sol`);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, `${name}.json`),
    JSON.stringify({
      abi: [],
      metadata: {
        language: "Solidity",
        compiler: { version: "0.8.28+commit.7893614a" },
        sources: { [sourceRelPath]: {} },
        settings: {},
      },
    }),
  );
}

function makeDeployment(contracts: DeploymentView["contracts"]): DeploymentView {
  return { contracts, configSteps: [], warnings: [] };
}

const TOKEN_CONTRACT = {
  id: "token",
  contractName: "Token",
  // Must be a valid 0x + 40-hex-char address — @redeploy/verify's
  // verifyDeployment() validates this format and throws MALFORMED_CONTRACT_ENTRY
  // (a setup error, not a per-contract result) for anything else.
  address: "0x1234567890123456789012345678901234567890",
  args: [],
  links: { dependencies: [], libraries: {} },
};

const ETHERSCAN_KEY = "sentinel-etherscan-api-key";

function makeFetchFn(response: { status: string; result: string }): FetchLike {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    }) as Awaited<ReturnType<FetchLike>>;
}

describe("runSourceVerify — graceful skip conditions", () => {
  it("skips when etherscan is null (no API key configured)", async () => {
    const result = await runSourceVerify({
      deployment: makeDeployment([TOKEN_CONTRACT]),
      outDir,
      contractsRoot,
      chainId: 1,
      etherscan: null,
      fetchFn: makeFetchFn({ status: "1", result: "guid" }),
    });

    expect(result).toEqual({
      success: false,
      skipped: true,
      reason: expect.stringContaining("ETHERSCAN_API_KEY"),
      results: [],
    });
  });

  it("skips on chainId 31337 (local Anvil), even with a configured API key", async () => {
    const result = await runSourceVerify({
      deployment: makeDeployment([TOKEN_CONTRACT]),
      outDir,
      contractsRoot,
      chainId: 31337,
      etherscan: { apiKey: ETHERSCAN_KEY },
      fetchFn: makeFetchFn({ status: "1", result: "guid" }),
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Anvil");
  });

  it("skips when there are no deployed contracts", async () => {
    const result = await runSourceVerify({
      deployment: makeDeployment([{ ...TOKEN_CONTRACT, address: null }]),
      outDir,
      contractsRoot,
      chainId: 1,
      etherscan: { apiKey: ETHERSCAN_KEY },
      fetchFn: makeFetchFn({ status: "1", result: "guid" }),
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("No deployed contracts");
  });
});

describe("runSourceVerify — submission", () => {
  it("submits a contract whose artifact has literal source content and reports 'pending' -> polled result", async () => {
    writeArtifact("Token", "src/Token.sol", "contract Token {}");

    const result = await runSourceVerify({
      deployment: makeDeployment([TOKEN_CONTRACT]),
      outDir,
      contractsRoot,
      chainId: 1,
      etherscan: { apiKey: ETHERSCAN_KEY },
      fetchFn: makeFetchFn({ status: "1", result: "already verified" }),
    });

    expect(result.skipped).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: "token", address: TOKEN_CONTRACT.address });
  });

  it("marks a contract 'skipped' when its artifact cannot yield a source input, without failing the whole batch", async () => {
    // Artifact JSON exists but has no metadata/sources -> buildStandardJsonInput() returns null.
    const artifactDir = path.join(outDir, "Token.sol");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "Token.json"), JSON.stringify({ abi: [] }));

    const result = await runSourceVerify({
      deployment: makeDeployment([TOKEN_CONTRACT]),
      outDir,
      contractsRoot,
      chainId: 1,
      etherscan: { apiKey: ETHERSCAN_KEY },
      fetchFn: makeFetchFn({ status: "1", result: "guid" }),
    });

    expect(result.skipped).toBe(false);
    expect(result.results).toEqual([
      { id: "token", address: TOKEN_CONTRACT.address, status: "skipped", message: expect.any(String) },
    ]);
  });

  it("SECURITY: the Etherscan API key never appears anywhere in the response", async () => {
    writeArtifact("Token", "src/Token.sol", "contract Token {}");

    const result = await runSourceVerify({
      deployment: makeDeployment([TOKEN_CONTRACT]),
      outDir,
      contractsRoot,
      chainId: 1,
      etherscan: { apiKey: ETHERSCAN_KEY },
      fetchFn: makeFetchFn({ status: "1", result: "already verified" }),
    });

    expect(JSON.stringify(result)).not.toContain(ETHERSCAN_KEY);
  });

  it("degrades to success:false with a reason (never throws) when the Etherscan client setup fails", async () => {
    writeArtifact("Token", "src/Token.sol", "contract Token {}");

    const result = await runSourceVerify({
      deployment: makeDeployment([TOKEN_CONTRACT]),
      outDir,
      contractsRoot,
      chainId: 1,
      // An empty apiKey makes createEtherscanClient() throw VerifyError("MISSING_API_KEY").
      etherscan: { apiKey: "" },
      fetchFn: makeFetchFn({ status: "1", result: "guid" }),
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toEqual(expect.any(String));
  });
});

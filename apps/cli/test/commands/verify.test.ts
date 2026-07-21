import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../src/commands/verify.js";
import { CliUsageError } from "../../src/args.js";
import { makeCtx } from "../helpers.js";

let tmpDir: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env["ETHERSCAN_API_KEY"];
  delete process.env["ETHERSCAN_API_KEY"];
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  if (savedApiKey === undefined) delete process.env["ETHERSCAN_API_KEY"];
  else process.env["ETHERSCAN_API_KEY"] = savedApiKey;
});

function writeJson(name: string, content: unknown): string {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-verify-test-"));
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

describe("verify command — target deployment", () => {
  it("throws CliUsageError when --manifest is missing", async () => {
    await expect(run([], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError for a malformed manifest (no contracts array)", async () => {
    const manifestPath = writeJson("manifest.json", { oops: true });
    await expect(run(["--manifest", manifestPath], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when etherscan has no api key", async () => {
    const manifestPath = writeJson("manifest.json", { contracts: [] });
    await expect(run(["--manifest", manifestPath], makeCtx())).rejects.toThrow(/api-key|API_KEY/);
  });

  it("submits to etherscan via createEtherscanClient + verifyDeployment", async () => {
    const manifestPath = writeJson("manifest.json", {
      contracts: [{ id: "a", address: "0xAAA", contractName: "A", sourceCode: "src", compilerVersion: "v1" }],
    });

    let etherscanConfig: unknown;
    let verifyOptions: { contracts: unknown; toSubmitRequest: (e: unknown) => unknown } | undefined;

    const ctx = makeCtx({
      deps: {
        createEtherscanClient: (config: unknown) => {
          etherscanConfig = config;
          return { submit: async () => ({ status: "verified" }) };
        },
        verifyDeployment: async (opts: { contracts: unknown; toSubmitRequest: (e: unknown) => unknown }) => {
          verifyOptions = opts;
          return { success: true, results: [] };
        },
      } as never,
    });

    const outcome = await run(["--manifest", manifestPath, "--api-key", "fake-key"], ctx);

    expect(outcome.success).toBe(true);
    expect(etherscanConfig).toMatchObject({ apiKey: "fake-key" });
    expect(verifyOptions?.toSubmitRequest({ address: "0xAAA", contractName: "A", sourceCode: "src" })).toMatchObject(
      { address: "0xAAA", contractName: "A", sourceCode: "src" },
    );
  });

  it("uses ETHERSCAN_API_KEY from the environment when --api-key is not passed", async () => {
    process.env["ETHERSCAN_API_KEY"] = "env-key";
    const manifestPath = writeJson("manifest.json", { contracts: [] });
    let etherscanConfig: unknown;
    const ctx = makeCtx({
      deps: {
        createEtherscanClient: (config: unknown) => {
          etherscanConfig = config;
          return { submit: async () => ({ status: "verified" }) };
        },
        verifyDeployment: async () => ({ success: true, results: [] }),
      } as never,
    });
    await run(["--manifest", manifestPath], ctx);
    expect(etherscanConfig).toMatchObject({ apiKey: "env-key" });
  });

  it("throws CliUsageError for sourcify without a chain id (flag or manifest)", async () => {
    const manifestPath = writeJson("manifest.json", { contracts: [] });
    await expect(run(["--manifest", manifestPath, "--provider", "sourcify"], makeCtx())).rejects.toThrow(
      CliUsageError,
    );
  });

  it("submits to sourcify via createSourcifyClient + verifyDeployment using the manifest chainId", async () => {
    const manifestPath = writeJson("manifest.json", {
      chainId: 31337,
      contracts: [{ id: "a", address: "0xAAA", contractName: "A", files: { "metadata.json": "{}" } }],
    });

    let submitRequest: unknown;
    const ctx = makeCtx({
      deps: {
        createSourcifyClient: () => ({ submit: async () => ({ status: "verified" }) }),
        verifyDeployment: async (opts: { toSubmitRequest: (e: unknown) => unknown; contracts: unknown[] }) => {
          submitRequest = opts.toSubmitRequest(opts.contracts[0]);
          return { success: true, results: [] };
        },
      } as never,
    });

    const outcome = await run(["--manifest", manifestPath, "--provider", "sourcify"], ctx);
    expect(outcome.success).toBe(true);
    expect(submitRequest).toMatchObject({ address: "0xAAA", chainId: 31337, files: { "metadata.json": "{}" } });
  });

  it("throws CliUsageError for an unknown --provider", async () => {
    const manifestPath = writeJson("manifest.json", { contracts: [] });
    await expect(
      run(["--manifest", manifestPath, "--provider", "bogus", "--api-key", "x"], makeCtx()),
    ).rejects.toThrow(CliUsageError);
  });

  it("returns success:false when verifyDeployment() reports overall failure", async () => {
    const manifestPath = writeJson("manifest.json", { contracts: [{ id: "a", address: "0xAAA", contractName: "A" }] });
    const ctx = makeCtx({
      deps: {
        createEtherscanClient: () => ({ submit: async () => ({ status: "failed", message: "nope" }) }),
        verifyDeployment: async () => ({
          success: false,
          results: [{ id: "a", address: "0xAAA", status: "failed", message: "nope" }],
        }),
      } as never,
    });
    const outcome = await run(["--manifest", manifestPath, "--api-key", "k"], ctx);
    expect(outcome.success).toBe(false);
  });
});

describe("verify command — target config", () => {
  it("throws CliUsageError when --config-spec is missing", async () => {
    await expect(run(["--target", "config"], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when --reads is missing", async () => {
    const configSpecPath = writeJson("config-spec.json", { steps: [] });
    await expect(
      run(["--target", "config", "--config-spec", configSpecPath], makeCtx()),
    ).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when no deployment dir is configured", async () => {
    const configSpecPath = writeJson("config-spec.json", { steps: [] });
    const readsPath = writeJson("reads.json", {});
    await expect(
      run(["--target", "config", "--config-spec", configSpecPath, "--reads", readsPath], makeCtx()),
    ).rejects.toThrow(CliUsageError);
  });

  it("builds deployedAddresses + a ChainReader from readDeployment() and calls verifyConfig()", async () => {
    const configSpecPath = writeJson("config-spec.json", { steps: [] });
    const readsPath = writeJson("reads.json", {});

    let verifyConfigOptions: Record<string, unknown> | undefined;
    const ctx = makeCtx({
      env: { deploymentDir: "/tmp/dep" },
      deps: {
        readDeployment: () => ({
          contracts: [
            { id: "a", contractName: "A", address: "0xAAA", args: [], links: { dependencies: [], libraries: {} } },
          ],
          configSteps: [],
          warnings: [],
        }),
        foundryArtifactResolver: () => ({}) as never,
        verifyConfig: async (opts: Record<string, unknown>) => {
          verifyConfigOptions = opts;
          return { clean: true, results: [] };
        },
      } as never,
    });

    const outcome = await run(
      ["--target", "config", "--config-spec", configSpecPath, "--reads", readsPath],
      ctx,
    );

    expect(outcome.success).toBe(true);
    expect(verifyConfigOptions?.["deployedAddresses"]).toEqual({ a: "0xAAA" });
    expect(verifyConfigOptions?.["reader"]).toBeDefined();
  });

  it("returns success:false when verifyConfig() reports drift", async () => {
    const configSpecPath = writeJson("config-spec.json", { steps: [] });
    const readsPath = writeJson("reads.json", {});
    const ctx = makeCtx({
      env: { deploymentDir: "/tmp/dep" },
      deps: {
        readDeployment: () => ({ contracts: [], configSteps: [], warnings: [] }),
        foundryArtifactResolver: () => ({}) as never,
        verifyConfig: async () => ({ clean: false, results: [{ id: "s", status: "drift" }] }),
      } as never,
    });
    const outcome = await run(["--target", "config", "--config-spec", configSpecPath, "--reads", readsPath], ctx);
    expect(outcome.success).toBe(false);
  });
});

describe("verify command — target validation", () => {
  it("throws CliUsageError for an unknown --target", async () => {
    await expect(run(["--target", "bogus"], makeCtx())).rejects.toThrow(CliUsageError);
  });
});

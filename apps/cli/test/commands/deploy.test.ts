import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../src/commands/deploy.js";
import { CliUsageError } from "../../src/args.js";
import { makeCtx } from "../helpers.js";

const FAKE_KEY = "aa".repeat(32);

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeSpec(content: unknown): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-deploy-test-"));
  const specPath = path.join(tmpDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(content), "utf8");
  return specPath;
}

describe("deploy command", () => {
  it("throws CliUsageError when --spec is missing", async () => {
    await expect(run([], makeCtx({ env: { deploymentDir: "/tmp/dep" } }))).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when no deployment dir is configured", async () => {
    const specPath = writeSpec({ contracts: [] });
    await expect(run(["--spec", specPath], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when DEPLOYER_PRIVATE_KEY is not configured", async () => {
    const specPath = writeSpec({ contracts: [] });
    const ctx = makeCtx({ env: { deploymentDir: "/tmp/dep", rawPrivateKey: undefined } });
    await expect(run(["--spec", specPath], ctx)).rejects.toThrow(/DEPLOYER_PRIVATE_KEY/);
  });

  it("deploys successfully: builds provider+resolver, mkdirs the deployment dir, and reports only the derived address", async () => {
    const specPath = writeSpec({ contracts: [{ id: "a", contract: "A" }] });
    const deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-deploy-dir-"));
    fs.rmSync(deploymentDir, { recursive: true, force: true }); // deploy must (re)create it

    let providerOptions: { rpcUrl: string; privateKey: string } | undefined;
    let deployOptions: Record<string, unknown> | undefined;

    const ctx = makeCtx({
      env: { deploymentDir, rawPrivateKey: FAKE_KEY, rpcUrl: "http://127.0.0.1:9999" },
      deps: {
        jsonRpcProvider: (opts) => {
          providerOptions = opts;
          return { request: async ({ method }: { method: string }) => (method === "eth_accounts" ? ["0xDEPLOYER"] : null) };
        },
        foundryArtifactResolver: () => ({ loadArtifact: async () => ({}) }) as never,
        deploy: async (opts: Record<string, unknown>) => {
          deployOptions = opts;
          return { success: true, deployedAddresses: { a: "0xAAA" }, ignitionResult: {} };
        },
      } as never,
    });

    const outcome = await run(["--spec", specPath], ctx);

    expect(fs.existsSync(deploymentDir)).toBe(true);
    expect(providerOptions?.rpcUrl).toBe("http://127.0.0.1:9999");
    expect(providerOptions?.privateKey).toBe(`0x${FAKE_KEY}`);
    expect(deployOptions?.["deploymentDir"]).toBe(deploymentDir);
    expect(deployOptions?.["accounts"]).toEqual(["0xDEPLOYER"]);

    expect(outcome.success).toBe(true);
    expect(outcome.data).toEqual({
      success: true,
      deployer: "0xDEPLOYER",
      deployedAddresses: { a: "0xAAA" },
    });

    fs.rmSync(deploymentDir, { recursive: true, force: true });

    // SECURITY: the raw private key must never appear anywhere in the returned data.
    expect(JSON.stringify(outcome.data)).not.toContain(FAKE_KEY);
  });

  it("returns success:false when deploy() reports success:false", async () => {
    const specPath = writeSpec({ contracts: [] });
    const deploymentDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-deploy-dir-"));
    const ctx = makeCtx({
      env: { deploymentDir, rawPrivateKey: FAKE_KEY },
      deps: {
        jsonRpcProvider: () => ({ request: async () => ["0xDEPLOYER"] }),
        foundryArtifactResolver: () => ({}) as never,
        deploy: async () => ({ success: false, deployedAddresses: {}, ignitionResult: {} }),
      } as never,
    });

    const outcome = await run(["--spec", specPath], ctx);
    expect(outcome.success).toBe(false);
    fs.rmSync(deploymentDir, { recursive: true, force: true });
  });
});

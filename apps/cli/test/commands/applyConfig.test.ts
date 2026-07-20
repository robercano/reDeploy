import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../src/commands/applyConfig.js";
import { CliUsageError } from "../../src/args.js";
import { makeCtx } from "../helpers.js";

const FAKE_KEY = "bb".repeat(32);

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeConfigSpec(content: unknown): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-apply-config-test-"));
  const specPath = path.join(tmpDir, "config-spec.json");
  fs.writeFileSync(specPath, JSON.stringify(content), "utf8");
  return specPath;
}

describe("apply-config command", () => {
  it("throws CliUsageError when --config-spec is missing", async () => {
    await expect(run([], makeCtx({ env: { deploymentDir: "/tmp/dep" } }))).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when no deployment dir is configured", async () => {
    const specPath = writeConfigSpec({ steps: [] });
    await expect(run(["--config-spec", specPath], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError when DEPLOYER_PRIVATE_KEY is not configured", async () => {
    const specPath = writeConfigSpec({ steps: [] });
    const ctx = makeCtx({ env: { deploymentDir: "/tmp/dep" } });
    await expect(run(["--config-spec", specPath], ctx)).rejects.toThrow(/DEPLOYER_PRIVATE_KEY/);
  });

  it("builds deployedAddresses from readDeployment() (skipping null addresses) and calls applyConfig()", async () => {
    const specPath = writeConfigSpec({ steps: [] });
    let applyConfigOptions: Record<string, unknown> | undefined;

    const ctx = makeCtx({
      env: { deploymentDir: "/tmp/dep", rawPrivateKey: FAKE_KEY },
      deps: {
        readDeployment: () => ({
          contracts: [
            { id: "a", contractName: "A", address: "0xAAA", args: [], links: { dependencies: [], libraries: {} } },
            { id: "b", contractName: "B", address: null, args: [], links: { dependencies: [], libraries: {} } },
          ],
          configSteps: [],
          warnings: [],
        }),
        jsonRpcProvider: () => ({ request: async () => [] }),
        foundryArtifactResolver: () => ({}) as never,
        applyConfig: async (opts: Record<string, unknown>) => {
          applyConfigOptions = opts;
          return { success: true, executedStepIds: [], skippedStepIds: [], completedStepIds: [] };
        },
      } as never,
    });

    const outcome = await run(["--config-spec", specPath], ctx);

    expect(applyConfigOptions?.["deployedAddresses"]).toEqual({ a: "0xAAA" });
    expect(applyConfigOptions?.["stateDir"]).toBe("/tmp/dep");
    expect(outcome.success).toBe(true);
  });

  it("uses --state-dir when provided instead of --deployment-dir", async () => {
    const specPath = writeConfigSpec({ steps: [] });
    let stateDirUsed: unknown;
    const ctx = makeCtx({
      env: { rawPrivateKey: FAKE_KEY },
      deps: {
        readDeployment: () => ({ contracts: [], configSteps: [], warnings: [] }),
        jsonRpcProvider: () => ({ request: async () => [] }),
        foundryArtifactResolver: () => ({}) as never,
        applyConfig: async (opts: Record<string, unknown>) => {
          stateDirUsed = opts["stateDir"];
          return { success: true, executedStepIds: [], skippedStepIds: [], completedStepIds: [] };
        },
      } as never,
    });

    await run(["--config-spec", specPath, "--deployment-dir", "/tmp/dep", "--state-dir", "/tmp/state"], ctx);
    expect(stateDirUsed).toBe("/tmp/state");
  });

  it("propagates applyConfig() failures (returned false, not thrown)", async () => {
    const specPath = writeConfigSpec({ steps: [] });
    const ctx = makeCtx({
      env: { deploymentDir: "/tmp/dep", rawPrivateKey: FAKE_KEY },
      deps: {
        readDeployment: () => ({ contracts: [], configSteps: [], warnings: [] }),
        jsonRpcProvider: () => ({ request: async () => [] }),
        foundryArtifactResolver: () => ({}) as never,
        applyConfig: async () => ({
          success: false,
          executedStepIds: [],
          skippedStepIds: [],
          completedStepIds: [],
        }),
      } as never,
    });

    const outcome = await run(["--config-spec", specPath], ctx);
    expect(outcome.success).toBe(false);
  });
});

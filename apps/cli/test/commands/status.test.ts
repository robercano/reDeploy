import { describe, it, expect } from "vitest";
import { run } from "../../src/commands/status.js";
import { CliUsageError } from "../../src/args.js";
import { makeCtx } from "../helpers.js";

describe("status command", () => {
  it("throws CliUsageError when neither --deployment-dir nor DEPLOYMENT_DIR is set", async () => {
    await expect(run([], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("reads via readDeployment() using the --deployment-dir flag", async () => {
    const view = { contracts: [], configSteps: [], warnings: [] };
    let receivedDir: string | undefined;
    const ctx = makeCtx({
      deps: {
        readDeployment: (opts: { deploymentDir: string }) => {
          receivedDir = opts.deploymentDir;
          return view;
        },
      },
    });

    const outcome = await run(["--deployment-dir", "/tmp/dep"], ctx);
    expect(receivedDir).toBe("/tmp/dep");
    expect(outcome).toEqual({ success: true, data: view });
  });

  it("falls back to the DEPLOYMENT_DIR env var when no flag is given", async () => {
    const view = { contracts: [], configSteps: [], warnings: [] };
    let receivedDir: string | undefined;
    const ctx = makeCtx({
      env: { deploymentDir: "/tmp/env-dep" },
      deps: {
        readDeployment: (opts: { deploymentDir: string }) => {
          receivedDir = opts.deploymentDir;
          return view;
        },
      },
    });

    await run([], ctx);
    expect(receivedDir).toBe("/tmp/env-dep");
  });

  it("propagates a thrown ReadError-like error", async () => {
    const ctx = makeCtx({
      deps: {
        readDeployment: () => {
          const err = new Error("no journal") as Error & { code: string };
          err.code = "DEPLOYMENT_DIR_NOT_FOUND";
          throw err;
        },
      },
    });
    await expect(run(["--deployment-dir", "/tmp/missing"], ctx)).rejects.toThrow("no journal");
  });
});

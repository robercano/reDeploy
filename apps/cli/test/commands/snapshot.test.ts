import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../src/commands/snapshot.js";
import { CliUsageError } from "../../src/args.js";
import { makeCtx } from "../helpers.js";

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeSpec(content: unknown): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-snapshot-test-"));
  const specPath = path.join(tmpDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(content), "utf8");
  return specPath;
}

describe("snapshot command", () => {
  it("throws CliUsageError when --spec is missing", async () => {
    await expect(run(["--chain-id", "1", "--deployment-dir", "/tmp/dep"], makeCtx())).rejects.toThrow(
      CliUsageError,
    );
  });

  it("throws CliUsageError when --chain-id is missing", async () => {
    const specPath = writeSpec({ contracts: [] });
    await expect(run(["--spec", specPath, "--deployment-dir", "/tmp/dep"], makeCtx())).rejects.toThrow(
      CliUsageError,
    );
  });

  it("throws CliUsageError when neither --deployment-dir nor DEPLOYMENT_DIR is set", async () => {
    const specPath = writeSpec({ contracts: [] });
    await expect(run(["--spec", specPath, "--chain-id", "1"], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("calls buildSnapshot() with a `read` option and the parsed spec", async () => {
    const specPath = writeSpec({ contracts: [{ id: "a" }] });
    let receivedOptions: unknown;
    const snapshot = { snapshotVersion: 1, takenAt: "now", chainId: 1, toolVersion: "0.0.0" };
    const ctx = makeCtx({
      deps: {
        buildSnapshot: (opts: unknown) => {
          receivedOptions = opts;
          return snapshot;
        },
      },
    });

    const outcome = await run(
      ["--spec", specPath, "--chain-id", "31337", "--deployment-dir", "/tmp/dep", "--network", "local"],
      ctx,
    );

    expect(outcome).toEqual({ success: true, data: snapshot });
    expect(receivedOptions).toMatchObject({
      read: { deploymentDir: "/tmp/dep" },
      chainId: 31337,
      network: "local",
      spec: { spec: { contracts: [{ id: "a" }] } },
    });
  });

  it("uses --tool-version when given instead of reading package.json", async () => {
    const specPath = writeSpec({ contracts: [] });
    let receivedToolVersion: string | undefined;
    const ctx = makeCtx({
      deps: {
        buildSnapshot: (opts: { toolVersion: string }) => {
          receivedToolVersion = opts.toolVersion;
          return { snapshotVersion: 1 };
        },
      },
    });

    await run(
      ["--spec", specPath, "--chain-id", "1", "--deployment-dir", "/tmp/dep", "--tool-version", "9.9.9"],
      ctx,
    );
    expect(receivedToolVersion).toBe("9.9.9");
  });
});

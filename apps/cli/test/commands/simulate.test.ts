import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../../src/commands/simulate.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-simulate-test-"));
  const specPath = path.join(tmpDir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(content), "utf8");
  return specPath;
}

describe("simulate command", () => {
  it("throws CliUsageError when --spec is missing", async () => {
    await expect(run([], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError for a missing spec file", async () => {
    await expect(run(["--spec", "/nonexistent/spec.json"], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("throws CliUsageError for invalid JSON in the spec file", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-simulate-test-"));
    const specPath = path.join(tmpDir, "spec.json");
    fs.writeFileSync(specPath, "{ not json", "utf8");
    await expect(run(["--spec", specPath], makeCtx())).rejects.toThrow(CliUsageError);
  });

  it("returns success:true with the simulate() result when the library call succeeds", async () => {
    const specPath = writeSpec({ contracts: [] });
    const ctx = makeCtx({
      deps: { simulate: () => ({ ok: true, steps: [] }) },
    });
    const outcome = await run(["--spec", specPath], ctx);
    expect(outcome.success).toBe(true);
    expect(outcome.data).toEqual({ ok: true, steps: [] });
  });

  it("returns success:false (without throwing) when simulate() reports ok:false", async () => {
    const specPath = writeSpec({ contracts: "not-an-array" });
    const ctx = makeCtx({
      deps: {
        simulate: () => ({ ok: false, errors: [{ code: "INVALID_SPEC", path: "", message: "bad" }] }),
      },
    });
    const outcome = await run(["--spec", specPath], ctx);
    expect(outcome.success).toBe(false);
    expect(outcome.data).toMatchObject({ ok: false });
  });
});

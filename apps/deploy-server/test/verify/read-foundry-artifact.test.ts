import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFoundryArtifactJson } from "../../src/verify/read-foundry-artifact.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-artifact-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeArtifact(outDir: string, name: string, json: unknown): void {
  const dir = path.join(outDir, `${name}.sol`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(json));
}

describe("readFoundryArtifactJson", () => {
  it("reads and parses a valid artifact file", async () => {
    writeArtifact(tmpDir, "Token", { abi: [], metadata: { compiler: { version: "0.8.28" } } });

    const result = await readFoundryArtifactJson(tmpDir, "Token");

    expect(result).toEqual({ abi: [], metadata: { compiler: { version: "0.8.28" } } });
  });

  it("returns null for a missing artifact", async () => {
    const result = await readFoundryArtifactJson(tmpDir, "DoesNotExist");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const dir = path.join(tmpDir, "Broken.sol");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Broken.json"), "{ not valid json");

    const result = await readFoundryArtifactJson(tmpDir, "Broken");
    expect(result).toBeNull();
  });

  it("returns null for an invalid contract name (path-traversal guard)", async () => {
    const result = await readFoundryArtifactJson(tmpDir, "../../etc/passwd");
    expect(result).toBeNull();
  });

  it("returns null for a contract name containing path separators", async () => {
    const result = await readFoundryArtifactJson(tmpDir, "foo/bar");
    expect(result).toBeNull();
  });
});

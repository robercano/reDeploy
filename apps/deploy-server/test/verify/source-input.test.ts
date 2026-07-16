import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildStandardJsonInput } from "../../src/verify/source-input.js";

let contractsRoot: string;

beforeEach(() => {
  contractsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-source-input-test-"));
});

afterEach(() => {
  fs.rmSync(contractsRoot, { recursive: true, force: true });
});

function writeSource(relPath: string, content: string): void {
  const abs = path.join(contractsRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("buildStandardJsonInput", () => {
  it("assembles a standard-json-input by reading every listed source file's literal content", () => {
    writeSource("src/Token.sol", "contract Token {}");
    writeSource("lib/openzeppelin-contracts/contracts/access/AccessControl.sol", "contract AccessControl {}");

    const artifactJson = {
      metadata: {
        language: "Solidity",
        compiler: { version: "0.8.28+commit.7893614a" },
        sources: {
          "src/Token.sol": { keccak256: "0xaaa", urls: [] },
          "lib/openzeppelin-contracts/contracts/access/AccessControl.sol": { keccak256: "0xbbb", urls: [] },
        },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    };

    const result = buildStandardJsonInput(artifactJson, contractsRoot);

    expect(result).not.toBeNull();
    expect(result!.codeFormat).toBe("solidity-standard-json-input");
    expect(result!.compilerVersion).toBe("v0.8.28+commit.7893614a");

    const parsed = JSON.parse(result!.sourceCode) as {
      language: string;
      sources: Record<string, { content: string }>;
      settings: unknown;
    };
    expect(parsed.language).toBe("Solidity");
    expect(parsed.sources["src/Token.sol"]!.content).toBe("contract Token {}");
    expect(parsed.sources["lib/openzeppelin-contracts/contracts/access/AccessControl.sol"]!.content).toBe(
      "contract AccessControl {}",
    );
    expect(parsed.settings).toEqual({ optimizer: { enabled: true, runs: 200 } });
  });

  it("prepends 'v' to a bare compiler version", () => {
    writeSource("src/Token.sol", "contract Token {}");
    const artifactJson = {
      metadata: {
        compiler: { version: "0.8.28+commit.7893614a" },
        sources: { "src/Token.sol": {} },
      },
    };
    const result = buildStandardJsonInput(artifactJson, contractsRoot);
    expect(result!.compilerVersion).toBe("v0.8.28+commit.7893614a");
  });

  it("leaves an already-'v'-prefixed compiler version unchanged", () => {
    writeSource("src/Token.sol", "contract Token {}");
    const artifactJson = {
      metadata: {
        compiler: { version: "v0.8.28+commit.7893614a" },
        sources: { "src/Token.sol": {} },
      },
    };
    const result = buildStandardJsonInput(artifactJson, contractsRoot);
    expect(result!.compilerVersion).toBe("v0.8.28+commit.7893614a");
  });

  it("returns null when the artifact has no metadata", () => {
    expect(buildStandardJsonInput({}, contractsRoot)).toBeNull();
    expect(buildStandardJsonInput(null, contractsRoot)).toBeNull();
    expect(buildStandardJsonInput("not an object", contractsRoot)).toBeNull();
  });

  it("returns null when metadata has no sources", () => {
    const artifactJson = { metadata: { compiler: { version: "0.8.28" } } };
    expect(buildStandardJsonInput(artifactJson, contractsRoot)).toBeNull();
  });

  it("returns null when metadata.sources is an empty object", () => {
    const artifactJson = { metadata: { compiler: { version: "0.8.28" }, sources: {} } };
    expect(buildStandardJsonInput(artifactJson, contractsRoot)).toBeNull();
  });

  it("returns null when metadata has no compiler version", () => {
    writeSource("src/Token.sol", "contract Token {}");
    const artifactJson = { metadata: { sources: { "src/Token.sol": {} } } };
    expect(buildStandardJsonInput(artifactJson, contractsRoot)).toBeNull();
  });

  it("returns null when a listed source file cannot be read from disk", () => {
    const artifactJson = {
      metadata: {
        compiler: { version: "0.8.28" },
        sources: { "src/DoesNotExist.sol": {} },
      },
    };
    expect(buildStandardJsonInput(artifactJson, contractsRoot)).toBeNull();
  });

  it("returns null (defense-in-depth) when a source path would resolve outside contractsRoot", () => {
    const artifactJson = {
      metadata: {
        compiler: { version: "0.8.28" },
        sources: { "../../../etc/passwd": {} },
      },
    };
    expect(buildStandardJsonInput(artifactJson, contractsRoot)).toBeNull();
  });
});

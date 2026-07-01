/**
 * Tests for foundryArtifactResolver().
 *
 * Creates a minimal Foundry out/ layout in a temporary directory and verifies
 * the resolver maps Foundry's JSON format correctly to Ignition's Artifact type.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foundryArtifactResolver } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers — fixture out/ layout in a temp dir
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-foundry-test-"));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write a valid Foundry artifact JSON at the conventional path:
 *   <outDir>/<contractName>.sol/<contractName>.json
 */
function writeArtifact(
  outDir: string,
  contractName: string,
  content: object,
): void {
  const artifactDir = path.join(outDir, `${contractName}.sol`);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, `${contractName}.json`),
    JSON.stringify(content),
  );
}

/** A minimal valid Foundry artifact matching the real out/ format. */
const SAMPLE_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "owner_", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
];

const SAMPLE_BYTECODE = "60806040526000805534801561001457600080fd5b50610100806100246000396000f3fe";
const SAMPLE_BYTECODE_WITH_PREFIX = "0x60806040526000805534801561001457600080fd5b50610100806100246000396000f3fe";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  rmTmpDir(tmpDir);
});

// ---------------------------------------------------------------------------
// loadArtifact — happy path
// ---------------------------------------------------------------------------

describe("foundryArtifactResolver — loadArtifact happy path", () => {
  it("returns correct abi from foundry artifact", async () => {
    writeArtifact(tmpDir, "Registry", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("Registry");

    expect(artifact.abi).toEqual(SAMPLE_ABI);
  });

  it("returns 0x-prefixed bytecode when foundry artifact has no prefix", async () => {
    writeArtifact(tmpDir, "Token", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE }, // no 0x prefix
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("Token");

    expect(artifact.bytecode).toBe(SAMPLE_BYTECODE_WITH_PREFIX);
    expect(artifact.bytecode.startsWith("0x")).toBe(true);
  });

  it("preserves 0x prefix when bytecode already has it", async () => {
    writeArtifact(tmpDir, "Vault", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE_WITH_PREFIX }, // already 0x-prefixed
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("Vault");

    expect(artifact.bytecode).toBe(SAMPLE_BYTECODE_WITH_PREFIX);
    // Should NOT double-prefix
    expect(artifact.bytecode.startsWith("0x0x")).toBe(false);
  });

  it("sets contractName to the requested name", async () => {
    writeArtifact(tmpDir, "MyContract", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("MyContract");

    expect(artifact.contractName).toBe("MyContract");
  });

  it("sets sourceName to <name>.sol", async () => {
    writeArtifact(tmpDir, "Registry", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("Registry");

    expect(artifact.sourceName).toBe("Registry.sol");
  });

  it("returns empty linkReferences ({})", async () => {
    writeArtifact(tmpDir, "Registry", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("Registry");

    expect(artifact.linkReferences).toEqual({});
  });

  it("handles a contract with an empty abi (e.g. interface)", async () => {
    writeArtifact(tmpDir, "IRegistry", {
      abi: [],
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    const artifact = await resolver.loadArtifact("IRegistry");

    expect(artifact.abi).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadArtifact — error cases
// ---------------------------------------------------------------------------

describe("foundryArtifactResolver — loadArtifact error cases", () => {
  it("throws with contract name in message when artifact file is missing", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    // No fixture written → file does not exist

    await expect(resolver.loadArtifact("NonExistent")).rejects.toThrow("NonExistent");
  });

  it("throws with path in message when artifact file is missing", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("NonExistent")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("NonExistent.sol"),
      }),
    );
  });

  it("throws with contract name in message when JSON is malformed", async () => {
    const artifactDir = path.join(tmpDir, "BadJson.sol");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "BadJson.json"), "{ NOT VALID JSON }}}");

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("BadJson")).rejects.toThrow("BadJson");
  });

  it("throws with descriptive message when abi field is missing", async () => {
    writeArtifact(tmpDir, "NoAbi", {
      // missing abi
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("NoAbi")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/abi|bytecode/i),
      }),
    );
  });

  it("throws with descriptive message when abi field is not an array (e.g. a string)", async () => {
    writeArtifact(tmpDir, "AbiNotArray", {
      abi: "not-an-array",
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("AbiNotArray")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringContaining("AbiNotArray"),
      }),
    );
  });

  it("throws with descriptive message when bytecode.object field is missing", async () => {
    writeArtifact(tmpDir, "NoBytecode", {
      abi: SAMPLE_ABI,
      // missing bytecode
    });

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("NoBytecode")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/abi|bytecode/i),
      }),
    );
  });

  it("throws with descriptive message when bytecode is present but object is empty string", async () => {
    writeArtifact(tmpDir, "EmptyBytecode", {
      abi: SAMPLE_ABI,
      bytecode: { object: "" },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("EmptyBytecode")).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/bytecode/i),
      }),
    );
  });

  it("names the contract in all error messages", async () => {
    const contractName = "SpecificContract";
    const resolver = foundryArtifactResolver(tmpDir);

    const err = await resolver.loadArtifact(contractName).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(contractName);
  });
});

// ---------------------------------------------------------------------------
// getBuildInfo — always returns undefined
// ---------------------------------------------------------------------------

describe("foundryArtifactResolver — getBuildInfo", () => {
  it("resolves to undefined for any contract name", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.getBuildInfo("Registry")).resolves.toBeUndefined();
    await expect(resolver.getBuildInfo("Token")).resolves.toBeUndefined();
    await expect(resolver.getBuildInfo("NonExistent")).resolves.toBeUndefined();
  });

  it("resolves to undefined even when no artifact file exists", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    // NOTE: missing artifact does NOT make getBuildInfo throw — only loadArtifact does.
    await expect(resolver.getBuildInfo("NoFile")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadArtifact — path traversal security
// ---------------------------------------------------------------------------

describe("foundryArtifactResolver — path traversal protection", () => {
  it("throws for a name with path separators (../)", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("../../etc/hosts")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a dot-only segment", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("..")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a forward slash", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("foo/bar")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a backslash", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("foo\\bar")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a null byte", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("foo\0bar")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for an empty name", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name that starts with a digit (invalid Solidity identifier)", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    await expect(resolver.loadArtifact("1Contract")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("does NOT throw for a valid contract name like 'MyContract_v2'", async () => {
    // Write a valid artifact so the read succeeds
    writeArtifact(tmpDir, "MyContract_v2", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    // Should resolve without throwing
    await expect(resolver.loadArtifact("MyContract_v2")).resolves.toBeDefined();
  });

  it("does NOT throw for a valid name starting with underscore", async () => {
    writeArtifact(tmpDir, "_HelperContract", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("_HelperContract")).resolves.toBeDefined();
  });

  it("does NOT throw for a valid name starting with $", async () => {
    writeArtifact(tmpDir, "$Token", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });

    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("$Token")).resolves.toBeDefined();
  });

  it("traversal attack does NOT read outside outDir", async () => {
    const resolver = foundryArtifactResolver(tmpDir);

    // The traversal should be blocked at name validation stage
    let threw = false;
    try {
      await resolver.loadArtifact("../../etc/hosts");
    } catch (err) {
      threw = true;
      // It must be the validation error, not a file-system read error
      expect((err as Error).message).toMatch(/Invalid contract name/);
    }
    expect(threw).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// loadArtifact -- path traversal security
// ---------------------------------------------------------------------------

describe("foundryArtifactResolver -- path traversal protection", () => {
  it("throws for a name with path separators (../)", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("../../etc/hosts")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a dot-only segment (..)", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("..")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a forward slash", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("foo/bar")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name with a backslash", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("foo\\bar")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for an empty name", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("throws for a name that starts with a digit (invalid Solidity identifier)", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("1Contract")).rejects.toThrow(
      /Invalid contract name/,
    );
  });

  it("does NOT throw for a valid contract name like 'MyContract_v2'", async () => {
    writeArtifact(tmpDir, "MyContract_v2", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("MyContract_v2")).resolves.toBeDefined();
  });

  it("does NOT throw for a valid name starting with underscore", async () => {
    writeArtifact(tmpDir, "_HelperContract", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("_HelperContract")).resolves.toBeDefined();
  });

  it("does NOT throw for a valid name starting with $", async () => {
    writeArtifact(tmpDir, "$Token", {
      abi: SAMPLE_ABI,
      bytecode: { object: SAMPLE_BYTECODE },
    });
    const resolver = foundryArtifactResolver(tmpDir);
    await expect(resolver.loadArtifact("$Token")).resolves.toBeDefined();
  });

  it("traversal attack throws Invalid contract name (not a fs read error)", async () => {
    const resolver = foundryArtifactResolver(tmpDir);
    let threw = false;
    try {
      await resolver.loadArtifact("../../etc/hosts");
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/Invalid contract name/);
    }
    expect(threw).toBe(true);
  });
});

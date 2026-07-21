/**
 * Tests for src/env.ts: parseEnv, loadRepoEnv, normalizePrivateKey, resolveEnv.
 *
 * SECURITY: only obviously-fake placeholder key material is used here
 * (e.g. "aa...", "0xaa..."). No real secrets appear in this file.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnv, loadRepoEnv, normalizePrivateKey, resolveEnv, DEFAULT_FOUNDRY_OUT } from "../src/env.js";

describe("parseEnv", () => {
  it("parses simple KEY=VALUE lines", () => {
    expect(parseEnv("FOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips blank lines and comments", () => {
    expect(parseEnv("# hi\nFOO=bar\n\n  # indented\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips lines without '='", () => {
    expect(parseEnv("not-a-line\nFOO=bar\n")).toEqual({ FOO: "bar" });
  });

  it("trims whitespace and strips matching quotes", () => {
    expect(parseEnv('  FOO  =  "bar baz"  \n')).toEqual({ FOO: "bar baz" });
    expect(parseEnv("FOO='bar baz'\n")).toEqual({ FOO: "bar baz" });
  });

  it("does not strip mismatched quotes", () => {
    expect(parseEnv("FOO=\"bar'\n")).toEqual({ FOO: "\"bar'" });
  });

  it("last duplicate key wins", () => {
    expect(parseEnv("FOO=first\nFOO=second\n")).toEqual({ FOO: "second" });
  });

  it("returns empty object for empty content", () => {
    expect(parseEnv("")).toEqual({});
  });

  it("handles CRLF", () => {
    expect(parseEnv("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("loadRepoEnv", () => {
  let tmpDir: string | undefined;
  const managedKeys = ["CLI_ENV_TEST_UNSET", "CLI_ENV_TEST_ALREADY_SET", "CLI_ENV_TEST_ONLY_FILE"];

  afterEach(() => {
    for (const key of managedKeys) delete process.env[key];
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeTmpEnvFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-cli-env-test-"));
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, content, "utf8");
    return envPath;
  }

  it("populates an unset var from the file", () => {
    const envPath = writeTmpEnvFile("CLI_ENV_TEST_UNSET=from-file\n");
    loadRepoEnv({ envPath });
    expect(process.env["CLI_ENV_TEST_UNSET"]).toBe("from-file");
  });

  it("does NOT override an already-set var (real env wins)", () => {
    process.env["CLI_ENV_TEST_ALREADY_SET"] = "from-real-env";
    const envPath = writeTmpEnvFile("CLI_ENV_TEST_ALREADY_SET=from-file\n");
    loadRepoEnv({ envPath });
    expect(process.env["CLI_ENV_TEST_ALREADY_SET"]).toBe("from-real-env");
  });

  it("is a silent no-op when the file is missing", () => {
    const missingPath = path.join(os.tmpdir(), "redeploy-cli-env-test-missing", ".env");
    expect(() => loadRepoEnv({ envPath: missingPath })).not.toThrow();
    expect(process.env["CLI_ENV_TEST_ONLY_FILE"]).toBeUndefined();
  });

  it("uses the repo-root default path when no envPath given (no throw)", () => {
    expect(() => loadRepoEnv()).not.toThrow();
  });
});

describe("normalizePrivateKey", () => {
  it("prepends 0x when missing", () => {
    const key = "aa".repeat(32);
    expect(normalizePrivateKey(key)).toBe(`0x${key}`);
  });

  it("leaves an already-prefixed key unchanged (lower and upper 0x)", () => {
    const key = `0x${"aa".repeat(32)}`;
    expect(normalizePrivateKey(key)).toBe(key);
    const upperKey = `0X${"aa".repeat(32)}`;
    expect(normalizePrivateKey(upperKey)).toBe(upperKey);
  });

  it("trims surrounding whitespace", () => {
    const key = "aa".repeat(32);
    expect(normalizePrivateKey(`  ${key}  `)).toBe(`0x${key}`);
  });
});

describe("resolveEnv", () => {
  const managedKeys = ["RPC_URL", "DEPLOYER_PRIVATE_KEY", "FOUNDRY_OUT", "DEPLOYMENT_DIR"];
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of managedKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  it("applies defaults when nothing is set", () => {
    for (const key of managedKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    const env = resolveEnv();
    expect(env.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(env.rawPrivateKey).toBeUndefined();
    expect(env.foundryOut).toBe(DEFAULT_FOUNDRY_OUT);
    expect(env.deploymentDir).toBeUndefined();
  });

  it("reads all four vars from process.env when set", () => {
    for (const key of managedKeys) saved[key] = process.env[key];
    process.env["RPC_URL"] = "http://example.invalid:8545";
    process.env["DEPLOYER_PRIVATE_KEY"] = "aa".repeat(32);
    process.env["FOUNDRY_OUT"] = "/tmp/some-out";
    process.env["DEPLOYMENT_DIR"] = "/tmp/some-deployment";

    const env = resolveEnv();
    expect(env.rpcUrl).toBe("http://example.invalid:8545");
    expect(env.rawPrivateKey).toBe("aa".repeat(32));
    expect(env.foundryOut).toBe("/tmp/some-out");
    expect(env.deploymentDir).toBe("/tmp/some-deployment");
  });
});

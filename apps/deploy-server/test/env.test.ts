/**
 * Tests for src/env.ts:
 *   - parseEnv(): pure KEY=VALUE parsing.
 *   - loadRepoEnv(): file loading with real-env-wins precedence and
 *     silent no-op on a missing file.
 *   - normalizePrivateKey(): "0x" prefix normalization.
 *
 * SECURITY: only obviously-fake placeholder key material is used here
 * (e.g. "aa...", "0xaa..."). No real secrets appear in this file.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnv, loadRepoEnv, normalizePrivateKey } from "../src/env.js";

// ---------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------

describe("parseEnv", () => {
  it("parses simple KEY=VALUE lines", () => {
    const result = parseEnv("FOO=bar\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips blank lines", () => {
    const result = parseEnv("FOO=bar\n\n\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comment lines starting with #", () => {
    const result = parseEnv("# this is a comment\nFOO=bar\n  # indented comment\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips lines without an '=' sign", () => {
    const result = parseEnv("not-a-valid-line\nFOO=bar\n");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around keys and values", () => {
    const result = parseEnv("  FOO  =  bar  \n");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("strips matching double quotes from values", () => {
    const result = parseEnv('FOO="bar baz"\n');
    expect(result).toEqual({ FOO: "bar baz" });
  });

  it("strips matching single quotes from values", () => {
    const result = parseEnv("FOO='bar baz'\n");
    expect(result).toEqual({ FOO: "bar baz" });
  });

  it("does not strip mismatched quotes", () => {
    const result = parseEnv("FOO=\"bar'\n");
    expect(result).toEqual({ FOO: "\"bar'" });
  });

  it("handles an empty value", () => {
    const result = parseEnv("FOO=\n");
    expect(result).toEqual({ FOO: "" });
  });

  it("handles values that themselves contain an '=' sign", () => {
    const result = parseEnv("FOO=a=b=c\n");
    expect(result).toEqual({ FOO: "a=b=c" });
  });

  it("last duplicate key in the file wins", () => {
    const result = parseEnv("FOO=first\nFOO=second\n");
    expect(result).toEqual({ FOO: "second" });
  });

  it("returns an empty object for empty content", () => {
    expect(parseEnv("")).toEqual({});
  });

  it("handles CRLF line endings", () => {
    const result = parseEnv("FOO=bar\r\nBAZ=qux\r\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

// ---------------------------------------------------------------------------
// loadRepoEnv
// ---------------------------------------------------------------------------

describe("loadRepoEnv", () => {
  let tmpDir: string | undefined;
  const managedKeys = ["ENV_TEST_UNSET_VAR", "ENV_TEST_ALREADY_SET_VAR", "ENV_TEST_ONLY_IN_FILE"];

  afterEach(() => {
    for (const key of managedKeys) {
      delete process.env[key];
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeTmpEnvFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-env-test-"));
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, content, "utf8");
    return envPath;
  }

  it("populates an unset process.env variable from the file", () => {
    expect(process.env["ENV_TEST_UNSET_VAR"]).toBeUndefined();
    const envPath = writeTmpEnvFile("ENV_TEST_UNSET_VAR=from-file\n");

    loadRepoEnv({ envPath });

    expect(process.env["ENV_TEST_UNSET_VAR"]).toBe("from-file");
  });

  it("does NOT override a variable already set in process.env (real env wins)", () => {
    process.env["ENV_TEST_ALREADY_SET_VAR"] = "from-real-env";
    const envPath = writeTmpEnvFile("ENV_TEST_ALREADY_SET_VAR=from-file\n");

    loadRepoEnv({ envPath });

    expect(process.env["ENV_TEST_ALREADY_SET_VAR"]).toBe("from-real-env");
  });

  it("is a silent no-op when the file does not exist", () => {
    const missingPath = path.join(os.tmpdir(), "redeploy-env-test-does-not-exist", ".env");
    expect(() => loadRepoEnv({ envPath: missingPath })).not.toThrow();
    expect(process.env["ENV_TEST_ONLY_IN_FILE"]).toBeUndefined();
  });

  it("uses the repo-root default path when no envPath is given (no throw even if absent)", () => {
    expect(() => loadRepoEnv()).not.toThrow();
  });

  it("loads multiple variables from a single file, respecting precedence per-key", () => {
    process.env["ENV_TEST_ALREADY_SET_VAR"] = "kept";
    const envPath = writeTmpEnvFile(
      "ENV_TEST_ALREADY_SET_VAR=overwritten-should-not-apply\nENV_TEST_ONLY_IN_FILE=populated\n",
    );

    loadRepoEnv({ envPath });

    expect(process.env["ENV_TEST_ALREADY_SET_VAR"]).toBe("kept");
    expect(process.env["ENV_TEST_ONLY_IN_FILE"]).toBe("populated");
  });
});

// ---------------------------------------------------------------------------
// normalizePrivateKey
// ---------------------------------------------------------------------------

describe("normalizePrivateKey", () => {
  it("prepends 0x when the key has no prefix", () => {
    const fakeKey = "aa".repeat(32);
    expect(normalizePrivateKey(fakeKey)).toBe(`0x${fakeKey}`);
  });

  it("leaves an already-0x-prefixed key unchanged", () => {
    const fakeKey = `0x${"aa".repeat(32)}`;
    expect(normalizePrivateKey(fakeKey)).toBe(fakeKey);
  });

  it("does not double-prefix an uppercase-0X-prefixed key", () => {
    const fakeKey = `0X${"aa".repeat(32)}`;
    expect(normalizePrivateKey(fakeKey)).toBe(fakeKey);
  });

  it("trims surrounding whitespace before checking/adding the prefix", () => {
    const fakeKey = "aa".repeat(32);
    expect(normalizePrivateKey(`  ${fakeKey}  `)).toBe(`0x${fakeKey}`);
  });

  it("trims surrounding whitespace on an already-prefixed key", () => {
    const fakeKey = `0x${"aa".repeat(32)}`;
    expect(normalizePrivateKey(`\t${fakeKey}\n`)).toBe(fakeKey);
  });
});

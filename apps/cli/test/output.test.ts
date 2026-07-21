/**
 * SECURITY-focused + formatting tests for src/output.ts.
 *
 * The redaction tests assert the fake private key value never appears
 * anywhere in rendered output, in either human or --json mode.
 */

import { describe, it, expect } from "vitest";
import { redact, formatHumanHeader, renderResult } from "../src/output.js";

const FAKE_SECRET = `0x${"cd".repeat(32)}`;

describe("redact", () => {
  it("returns input unchanged when secret is undefined or empty", () => {
    expect(redact("hello world", undefined)).toBe("hello world");
    expect(redact("hello world", "")).toBe("hello world");
    expect(redact("hello world", "   ")).toBe("hello world");
  });

  it("redacts an exact-match occurrence", () => {
    const input = `key is ${FAKE_SECRET} end`;
    const out = redact(input, FAKE_SECRET);
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts the un-prefixed variant when the secret was 0x-prefixed", () => {
    const bare = FAKE_SECRET.slice(2);
    const out = redact(`raw hex ${bare}`, FAKE_SECRET);
    expect(out).not.toContain(bare);
  });

  it("redacts the 0x-prefixed variant when the secret was bare", () => {
    const bare = FAKE_SECRET.slice(2);
    const out = redact(`prefixed ${FAKE_SECRET}`, bare);
    expect(out).not.toContain(FAKE_SECRET);
  });
});

describe("formatHumanHeader", () => {
  it("renders OK/FAILED prefixes", () => {
    expect(formatHumanHeader("deploy", true)).toBe("OK: redeploy deploy");
    expect(formatHumanHeader("deploy", false)).toBe("FAILED: redeploy deploy");
  });
});

describe("renderResult", () => {
  it("renders a successful human result to stdout", () => {
    const { text, stream } = renderResult("simulate", { ok: true, data: { steps: [] } }, false);
    expect(stream).toBe("stdout");
    expect(text).toContain("OK: redeploy simulate");
    expect(text).toContain('"steps"');
  });

  it("renders a successful --json result to stdout as a parseable envelope", () => {
    const { text, stream } = renderResult("simulate", { ok: true, data: { steps: [] } }, true);
    expect(stream).toBe("stdout");
    const parsed = JSON.parse(text) as { ok: boolean; command: string; data: unknown };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("simulate");
    expect(parsed.data).toEqual({ steps: [] });
  });

  it("renders a failure result to stderr in both modes", () => {
    const human = renderResult("deploy", { ok: false, error: { message: "boom", code: "X" } }, false);
    expect(human.stream).toBe("stderr");
    expect(human.text).toContain("FAILED: redeploy deploy");
    expect(human.text).toContain("[X] boom");

    const json = renderResult("deploy", { ok: false, error: { message: "boom", code: "X" } }, true);
    expect(json.stream).toBe("stderr");
    const parsed = JSON.parse(json.text) as { ok: boolean; error: { message: string; code?: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe("boom");
    expect(parsed.error.code).toBe("X");
  });

  it("serializes bigint payload values without throwing", () => {
    const { text } = renderResult("simulate", { ok: true, data: { amount: 500n } }, true);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).data.amount).toBe("500");
  });

  it("SECURITY: never includes a secret value in success or failure output, human or json", () => {
    const successHuman = renderResult(
      "deploy",
      { ok: true, data: { deployer: "0xabc", note: `leaked ${FAKE_SECRET}` } },
      false,
      FAKE_SECRET,
    );
    expect(successHuman.text).not.toContain(FAKE_SECRET);

    const successJson = renderResult(
      "deploy",
      { ok: true, data: { deployer: "0xabc", note: `leaked ${FAKE_SECRET}` } },
      true,
      FAKE_SECRET,
    );
    expect(successJson.text).not.toContain(FAKE_SECRET);

    const failureHuman = renderResult(
      "deploy",
      { ok: false, error: { message: `Invalid deployer configuration: ${FAKE_SECRET}` } },
      false,
      FAKE_SECRET,
    );
    expect(failureHuman.text).not.toContain(FAKE_SECRET);

    const failureJson = renderResult(
      "deploy",
      { ok: false, error: { message: `Invalid deployer configuration: ${FAKE_SECRET}` } },
      true,
      FAKE_SECRET,
    );
    expect(failureJson.text).not.toContain(FAKE_SECRET);
  });
});

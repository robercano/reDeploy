/**
 * field-errors.test.ts
 *
 * Unit tests for the error-path parser and per-node field error mapping
 * (issue #83).
 *
 * Covered:
 * - parseErrorPath: id / arg / bare-contract / after / unmappable paths.
 * - buildNodeFieldErrors: positional contractIndex → nodeId mapping,
 *   multiple errors on the same node, out-of-range indices, unmappable paths.
 */

import { describe, it, expect } from "vitest";
import {
  parseErrorPath,
  buildNodeFieldErrors,
} from "../src/deploy/field-errors.js";
import type { StructuredDeployError } from "../src/deploy/field-errors.js";

// ---------------------------------------------------------------------------
// parseErrorPath
// ---------------------------------------------------------------------------

describe("parseErrorPath", () => {
  it("parses a contracts[i].id path", () => {
    expect(parseErrorPath("contracts[0].id")).toEqual({ kind: "id", contractIndex: 0 });
    expect(parseErrorPath("contracts[3].id")).toEqual({ kind: "id", contractIndex: 3 });
  });

  it("parses a contracts[i].args[j] path", () => {
    expect(parseErrorPath("contracts[2].args[0]")).toEqual({
      kind: "arg",
      contractIndex: 2,
      argIndex: 0,
    });
  });

  it("parses a contracts[i].args[j].contract sub-path as the same arg slot", () => {
    // e.g. an invalid ref arg's target contract — still maps to the arg slot.
    expect(parseErrorPath("contracts[2].args[0].contract")).toEqual({
      kind: "arg",
      contractIndex: 2,
      argIndex: 0,
    });
  });

  it("parses a bare contracts[i] path as node-level", () => {
    expect(parseErrorPath("contracts[5]")).toEqual({ kind: "contract", contractIndex: 5 });
  });

  it("parses a contracts[i].after[k] path as node-level (no more specific field)", () => {
    expect(parseErrorPath("contracts[1].after[1]")).toEqual({
      kind: "contract",
      contractIndex: 1,
    });
  });

  it("returns null for an undefined path", () => {
    expect(parseErrorPath(undefined)).toBeNull();
  });

  it("returns null for an empty string path", () => {
    expect(parseErrorPath("")).toBeNull();
  });

  it("returns null for a path that doesn't start with contracts[", () => {
    expect(parseErrorPath("config.steps[0].function")).toBeNull();
    expect(parseErrorPath("some free-text description")).toBeNull();
  });

  it("prefers the .id classification over the generic contract-index match", () => {
    const parsed = parseErrorPath("contracts[7].id");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("id");
  });

  it("prefers the .args[] classification over the generic contract-index match", () => {
    const parsed = parseErrorPath("contracts[7].args[3]");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("arg");
    if (parsed!.kind === "arg") {
      expect(parsed!.argIndex).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// buildNodeFieldErrors
// ---------------------------------------------------------------------------

describe("buildNodeFieldErrors", () => {
  it("maps a contracts[0].id error to the deployId field of the first node", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].id", message: "contract entry id must be a non-empty string" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a", "node-b"]);

    expect(result.get("node-a")).toEqual({
      deployId: "contract entry id must be a non-empty string",
    });
    expect(result.has("node-b")).toBe(false);
  });

  it("maps a contracts[i].args[j] error to the correct arg slot of the correct node", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[1].args[2]", message: "arg must be a valid literal or ref" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a", "node-b", "node-c"]);

    expect(result.get("node-b")).toEqual({ args: { 2: "arg must be a valid literal or ref" } });
    expect(result.has("node-a")).toBe(false);
    expect(result.has("node-c")).toBe(false);
  });

  it("maps a node-only-mappable error (bare contracts[i]) to the node field", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0]", message: "duplicate deploy id across contracts" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({ node: "duplicate deploy id across contracts" });
  });

  it("maps a contracts[i].after[k] error to the node field (no more specific field)", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].after[1]", message: "after references an unknown contract id" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({ node: "after references an unknown contract id" });
  });

  it("skips errors with an unmappable/absent path (banner-only fallback)", () => {
    const errors: StructuredDeployError[] = [
      { message: "network error: connection refused" },
      { path: "some free-text path", message: "not a contract path" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.size).toBe(0);
  });

  it("skips errors whose contractIndex is out of range for the current nodes array", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[5].id", message: "id must be non-empty" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.size).toBe(0);
  });

  it("merges multiple errors that map to the same node into one entry", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].id", message: "id must be non-empty" },
      { path: "contracts[0].args[0]", message: "arg 0 is invalid" },
      { path: "contracts[0].args[1]", message: "arg 1 is invalid" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({
      deployId: "id must be non-empty",
      args: { 0: "arg 0 is invalid", 1: "arg 1 is invalid" },
    });
  });

  it("keeps the first node-level message when multiple errors map to the same node-level field", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0]", message: "first node-level error" },
      { path: "contracts[0].after[0]", message: "second node-level error" },
    ];
    const result = buildNodeFieldErrors(errors, ["node-a"]);

    expect(result.get("node-a")).toEqual({ node: "first node-level error" });
  });

  it("maps errors across multiple distinct nodes independently", () => {
    const errors: StructuredDeployError[] = [
      { path: "contracts[0].id", message: "token id invalid" },
      { path: "contracts[1].args[0]", message: "vault arg 0 invalid" },
    ];
    const result = buildNodeFieldErrors(errors, ["token", "vault"]);

    expect(result.get("token")).toEqual({ deployId: "token id invalid" });
    expect(result.get("vault")).toEqual({ args: { 0: "vault arg 0 invalid" } });
  });

  it("returns an empty map when given no errors", () => {
    const result = buildNodeFieldErrors([], ["node-a"]);
    expect(result.size).toBe(0);
  });
});

/**
 * Tests for src/spec-hash.ts: the stable, key-order-independent spec hash
 * used to key the simulate-first interlock (see simulate-state.ts).
 */

import { describe, it, expect } from "vitest";
import { specHash } from "../src/spec-hash.js";

describe("specHash", () => {
  it("produces a 64-character hex string (sha256 digest)", () => {
    const hash = specHash({ version: 1, contracts: [] });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across reordered top-level keys", () => {
    const a = { version: 1, contracts: [{ id: "token", contract: "Token" }] };
    const b = { contracts: [{ id: "token", contract: "Token" }], version: 1 };
    expect(specHash(a)).toBe(specHash(b));
  });

  it("is stable across reordered nested object keys", () => {
    const a = {
      version: 1,
      contracts: [{ id: "token", contract: "Token", args: [] }],
    };
    const b = {
      version: 1,
      contracts: [{ contract: "Token", args: [], id: "token" }],
    };
    expect(specHash(a)).toBe(specHash(b));
  });

  it("is stable regardless of deeply nested key order", () => {
    const a = { a: { b: { c: 1, d: 2 }, e: 3 } };
    const b = { a: { e: 3, b: { d: 2, c: 1 } } };
    expect(specHash(a)).toBe(specHash(b));
  });

  it("preserves array element ORDER as semantically meaningful (different order → different hash)", () => {
    const a = { contracts: ["token", "vault"] };
    const b = { contracts: ["vault", "token"] };
    expect(specHash(a)).not.toBe(specHash(b));
  });

  it("produces different hashes for structurally different specs", () => {
    const a = { version: 1, contracts: [{ id: "token", contract: "Token" }] };
    const b = { version: 1, contracts: [{ id: "vault", contract: "Vault" }] };
    expect(specHash(a)).not.toBe(specHash(b));
  });

  it("produces different hashes for a changed value on the same key", () => {
    const a = { version: 1 };
    const b = { version: 2 };
    expect(specHash(a)).not.toBe(specHash(b));
  });

  it("is deterministic across repeated calls with the same input", () => {
    const spec = { version: 1, contracts: [{ id: "token", contract: "Token" }] };
    expect(specHash(spec)).toBe(specHash(spec));
    expect(specHash(spec)).toBe(specHash(JSON.parse(JSON.stringify(spec))));
  });

  it("handles primitives, null, and arrays of objects", () => {
    expect(() => specHash(null)).not.toThrow();
    expect(() => specHash(42)).not.toThrow();
    expect(() => specHash("a string")).not.toThrow();
    expect(() => specHash([{ b: 1, a: 2 }, { d: 3, c: 4 }])).not.toThrow();
    expect(specHash([{ b: 1, a: 2 }])).toBe(specHash([{ a: 2, b: 1 }]));
  });
});

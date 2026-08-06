/**
 * Tests for buildSafeBatch() (propose/safeBatch.ts) — issue #154, point 3.
 *
 * Pure, offline, no network — buildSafeBatch() is a plain data transform.
 */

import { describe, it, expect } from "vitest";
import { buildSafeBatch, SafeBatchError } from "../src/index.js";
import type { ProposedTransaction } from "../src/index.js";

describe("buildSafeBatch() — call-only batches (fully supported)", () => {
  it("produces the Safe Transaction Builder batch JSON shape", () => {
    const transactions: ProposedTransaction[] = [
      { to: "0x1111111111111111111111111111111111111111", data: "0xabcdef", value: "0" },
      { to: "0x2222222222222222222222222222222222222222", data: "0x", value: "1000000000000000000" },
    ];

    const batch = buildSafeBatch(transactions, {
      chainId: 1,
      name: "My batch",
      description: "Post-deploy config",
      now: () => 1700000000000,
    });

    expect(batch).toEqual({
      version: "1.0",
      chainId: "1",
      createdAt: 1700000000000,
      meta: {
        name: "My batch",
        description: "Post-deploy config",
        txBuilderVersion: "1.16.5",
      },
      transactions: [
        { to: "0x1111111111111111111111111111111111111111", value: "0", data: "0xabcdef" },
        { to: "0x2222222222222222222222222222222222222222", value: "1000000000000000000", data: "0x" },
      ],
    });
  });

  it("preserves transaction order exactly (Safe executes batch entries in array order)", () => {
    const transactions: ProposedTransaction[] = [
      { to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", data: "0x01", value: "0" },
      { to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", data: "0x02", value: "0" },
      { to: "0xcccccccccccccccccccccccccccccccccccccccc".slice(0, 42), data: "0x03", value: "0" },
    ];

    const batch = buildSafeBatch(transactions, { chainId: 31337 });

    expect(batch.transactions.map((t) => t.data)).toEqual(["0x01", "0x02", "0x03"]);
  });

  it("defaults name/description when omitted", () => {
    const batch = buildSafeBatch([], { chainId: 1 });
    expect(batch.meta.name).toBe("reDeploy batch");
    expect(batch.meta.description).toBe("");
  });

  it("uses Date.now() when no `now` override is supplied", () => {
    const before = Date.now();
    const batch = buildSafeBatch([], { chainId: 1 });
    const after = Date.now();
    expect(batch.createdAt).toBeGreaterThanOrEqual(before);
    expect(batch.createdAt).toBeLessThanOrEqual(after);
  });

  it("stringifies chainId", () => {
    const batch = buildSafeBatch([], { chainId: 42161 });
    expect(batch.chainId).toBe("42161");
  });
});

describe("buildSafeBatch() — raw contract-creation steps are unsupported (documented seam)", () => {
  it("throws SafeBatchError with code UNSUPPORTED_CREATION when any tx has to: null", () => {
    const transactions: ProposedTransaction[] = [
      { to: "0x1111111111111111111111111111111111111111", data: "0xabcdef", value: "0" },
      { to: null, data: "0x60806040", value: "0" },
    ];

    let thrown: unknown;
    try {
      buildSafeBatch(transactions, { chainId: 1 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SafeBatchError);
    expect((thrown as SafeBatchError).code).toBe("UNSUPPORTED_CREATION");
    expect((thrown as SafeBatchError).message).toContain("index [1]");
  });

  it("reports ALL creation-step indexes when multiple are present", () => {
    const transactions: ProposedTransaction[] = [
      { to: null, data: "0x01", value: "0" },
      { to: "0x1111111111111111111111111111111111111111", data: "0x02", value: "0" },
      { to: null, data: "0x03", value: "0" },
    ];

    let thrown: unknown;
    try {
      buildSafeBatch(transactions, { chainId: 1 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SafeBatchError);
    expect((thrown as SafeBatchError).message).toContain("index [0, 2]");
  });

  it("does not throw for an all-call batch even if data looks like init code", () => {
    const transactions: ProposedTransaction[] = [
      { to: "0x1111111111111111111111111111111111111111", data: "0x608060", value: "0" },
    ];
    expect(() => buildSafeBatch(transactions, { chainId: 1 })).not.toThrow();
  });
});

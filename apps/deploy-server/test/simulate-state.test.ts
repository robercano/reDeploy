/**
 * Tests for src/simulate-state.ts: persisted "has this spec been
 * simulated?" state backing the simulate-first interlock (issue #156).
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordSimulated, hasSimulated } from "../src/simulate-state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-simulate-state-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordSimulated / hasSimulated", () => {
  it("hasSimulated returns false for a hash that was never recorded", () => {
    expect(hasSimulated(tmpDir, "deadbeef")).toBe(false);
  });

  it("hasSimulated returns false when deploymentDir does not exist at all", () => {
    const missingDir = path.join(tmpDir, "does-not-exist");
    expect(hasSimulated(missingDir, "deadbeef")).toBe(false);
  });

  it("after recordSimulated, hasSimulated returns true for that exact hash", () => {
    recordSimulated(tmpDir, "hash-a");
    expect(hasSimulated(tmpDir, "hash-a")).toBe(true);
  });

  it("hasSimulated returns false for an unrecorded hash even when others are recorded", () => {
    recordSimulated(tmpDir, "hash-a");
    expect(hasSimulated(tmpDir, "hash-b")).toBe(false);
  });

  it("creates deploymentDir (mkdir -p) when it does not yet exist", () => {
    const freshDir = path.join(tmpDir, "nested", "journal-dir");
    expect(fs.existsSync(freshDir)).toBe(false);
    recordSimulated(freshDir, "hash-a");
    expect(fs.existsSync(freshDir)).toBe(true);
    expect(hasSimulated(freshDir, "hash-a")).toBe(true);
  });

  it("recording the same hash twice does not duplicate it (idempotent)", () => {
    recordSimulated(tmpDir, "hash-a");
    recordSimulated(tmpDir, "hash-a");

    const stateFile = path.join(tmpDir, ".redeploy-simulated.json");
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { hashes: string[] };
    expect(parsed.hashes.filter((h) => h === "hash-a")).toHaveLength(1);
  });

  it("a missing state file → hasSimulated is false (treated as no record)", () => {
    // tmpDir exists but no .redeploy-simulated.json has ever been written.
    expect(hasSimulated(tmpDir, "any-hash")).toBe(false);
  });

  it("a corrupt (non-JSON) state file → hasSimulated is false, never throws", () => {
    const stateFile = path.join(tmpDir, ".redeploy-simulated.json");
    fs.writeFileSync(stateFile, "{ not valid json", "utf8");
    expect(() => hasSimulated(tmpDir, "any-hash")).not.toThrow();
    expect(hasSimulated(tmpDir, "any-hash")).toBe(false);
  });

  it("a state file with an unexpected JSON shape → hasSimulated is false, never throws", () => {
    const stateFile = path.join(tmpDir, ".redeploy-simulated.json");
    fs.writeFileSync(stateFile, JSON.stringify({ hashes: "not-an-array" }), "utf8");
    expect(hasSimulated(tmpDir, "any-hash")).toBe(false);

    fs.writeFileSync(stateFile, JSON.stringify(["a", "b"]), "utf8");
    expect(hasSimulated(tmpDir, "a")).toBe(false);

    fs.writeFileSync(stateFile, JSON.stringify(null), "utf8");
    expect(hasSimulated(tmpDir, "any-hash")).toBe(false);
  });

  it("recordSimulated never throws even when the target path cannot be created (best-effort)", () => {
    // Point deploymentDir at a path whose parent is actually a FILE, so
    // mkdirSync(..., {recursive:true}) fails with ENOTDIR — recordSimulated
    // must swallow this rather than throw (SUCCESS path of simulate must
    // never become an error because recording failed).
    const blockerFile = path.join(tmpDir, "blocker-file");
    fs.writeFileSync(blockerFile, "not a directory", "utf8");
    const impossibleDir = path.join(blockerFile, "journal");

    expect(() => recordSimulated(impossibleDir, "hash-a")).not.toThrow();
    // And the interlock check still fails closed for that path.
    expect(hasSimulated(impossibleDir, "hash-a")).toBe(false);
  });

  it("bounds growth: retains at most the most-recent N hashes", () => {
    // Record more than the internal cap (50) worth of distinct hashes.
    const total = 55;
    for (let i = 0; i < total; i++) {
      recordSimulated(tmpDir, `hash-${i}`);
    }

    const stateFile = path.join(tmpDir, ".redeploy-simulated.json");
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { hashes: string[] };
    expect(parsed.hashes.length).toBeLessThanOrEqual(50);

    // The most recently recorded hash must still be present...
    expect(hasSimulated(tmpDir, `hash-${total - 1}`)).toBe(true);
    // ...while the oldest ones were evicted.
    expect(hasSimulated(tmpDir, "hash-0")).toBe(false);
  });

  it("re-recording an existing hash moves it to the front, protecting it from the next eviction", () => {
    // Fill to exactly the cap (50), with hash-0 recorded first (so it is the
    // LEAST recently used entry, i.e. next in line for eviction).
    recordSimulated(tmpDir, "hash-0");
    for (let i = 1; i < 50; i++) {
      recordSimulated(tmpDir, `hash-${i}`);
    }
    expect(hasSimulated(tmpDir, "hash-0")).toBe(true);

    // Re-record hash-0: this refreshes it to the front WITHOUT growing the
    // set (it's a re-record, not a new hash), so nothing is evicted yet.
    recordSimulated(tmpDir, "hash-0");
    expect(hasSimulated(tmpDir, "hash-0")).toBe(true);
    expect(hasSimulated(tmpDir, "hash-1")).toBe(true);

    // Recording one brand-new hash now must evict the new least-recently-used
    // entry (hash-1, which became the oldest once hash-0 was refreshed to the
    // front) — NOT hash-0, which was just refreshed.
    recordSimulated(tmpDir, "hash-new");
    expect(hasSimulated(tmpDir, "hash-0")).toBe(true);
    expect(hasSimulated(tmpDir, "hash-new")).toBe(true);
    expect(hasSimulated(tmpDir, "hash-1")).toBe(false);
  });
});

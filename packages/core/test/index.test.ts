import { describe, it, expect } from "vitest";
import { validateSpec } from "../src/index.js";

describe("@redeploy/core — public API", () => {
  it("exposes validateSpec from the package root", () => {
    expect(typeof validateSpec).toBe("function");
  });

  it("returns ok:true for a minimal valid spec", () => {
    const result = validateSpec({ version: 1, contracts: [] });
    expect(result.ok).toBe(true);
  });
});

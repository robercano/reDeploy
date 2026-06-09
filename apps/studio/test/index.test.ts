import { describe, it, expect } from "vitest";
import { name, placeholder } from "../src/index.js";

describe("@redeploy/studio", () => {
  it("exposes its package name", () => {
    expect(placeholder()).toBe(name);
  });
});

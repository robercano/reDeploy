import { describe, it, expect } from "vitest";
import {
  parseCommandArgs,
  requireString,
  optionalString,
  optionalInt,
  flag,
  CliUsageError,
} from "../src/args.js";

describe("parseCommandArgs", () => {
  it("parses a known string flag plus the common --json/--help flags", () => {
    const { values } = parseCommandArgs(["--spec", "foo.json", "--json"], { spec: { type: "string" } });
    expect(values["spec"]).toBe("foo.json");
    expect(values["json"]).toBe(true);
    expect(values["help"]).toBeFalsy();
  });

  it("parses -h as the help alias", () => {
    const { values } = parseCommandArgs(["-h"], {});
    expect(values["help"]).toBe(true);
  });

  it("throws CliUsageError on an unknown flag", () => {
    expect(() => parseCommandArgs(["--nope"], {})).toThrow(CliUsageError);
  });

  it("captures positionals", () => {
    const { positionals } = parseCommandArgs(["extra", "--json"], {});
    expect(positionals).toEqual(["extra"]);
  });
});

describe("requireString", () => {
  it("returns the value when present and non-empty", () => {
    expect(requireString({ spec: "foo.json" }, "spec", "simulate")).toBe("foo.json");
  });

  it("throws CliUsageError when missing", () => {
    expect(() => requireString({}, "spec", "simulate")).toThrow(CliUsageError);
    expect(() => requireString({}, "spec", "simulate")).toThrow(/--spec/);
  });

  it("throws CliUsageError when present but blank", () => {
    expect(() => requireString({ spec: "   " }, "spec", "simulate")).toThrow(CliUsageError);
  });

  it("throws CliUsageError when the flag was passed as a boolean (wrong type)", () => {
    expect(() => requireString({ spec: true }, "spec", "simulate")).toThrow(CliUsageError);
  });
});

describe("optionalString", () => {
  it("returns the value when present", () => {
    expect(optionalString({ foo: "bar" }, "foo")).toBe("bar");
  });

  it("returns undefined when absent or non-string", () => {
    expect(optionalString({}, "foo")).toBeUndefined();
    expect(optionalString({ foo: true }, "foo")).toBeUndefined();
  });
});

describe("optionalInt", () => {
  it("returns undefined when absent", () => {
    expect(optionalInt({}, "chain-id", "snapshot")).toBeUndefined();
  });

  it("parses a valid integer string", () => {
    expect(optionalInt({ "chain-id": "31337" }, "chain-id", "snapshot")).toBe(31337);
  });

  it("throws CliUsageError for a non-integer value", () => {
    expect(() => optionalInt({ "chain-id": "abc" }, "chain-id", "snapshot")).toThrow(CliUsageError);
  });

  it("throws CliUsageError for a float value", () => {
    expect(() => optionalInt({ "chain-id": "1.5" }, "chain-id", "snapshot")).toThrow(CliUsageError);
  });
});

describe("flag", () => {
  it("returns true only when the value is exactly boolean true", () => {
    expect(flag({ json: true }, "json")).toBe(true);
    expect(flag({ json: false }, "json")).toBe(false);
    expect(flag({}, "json")).toBe(false);
    expect(flag({ json: "true" }, "json")).toBe(false);
  });
});

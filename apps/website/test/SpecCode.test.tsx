import { render } from "@testing-library/react";
import SpecCode, { tokenizeSpec } from "../src/components/SpecCode.js";
import { SPEC_JSON } from "../src/content.js";

describe("tokenizeSpec", () => {
  it("reassembles to the exact source text", () => {
    const tokens = tokenizeSpec(SPEC_JSON);
    expect(tokens.map((t) => t.text).join("")).toBe(SPEC_JSON);
  });

  it("classes {\"ref\": ...} objects as ref and {\"param\"/\"read\": ...} objects as par", () => {
    const tokens = tokenizeSpec(SPEC_JSON);
    const refTokens = tokens.filter((t) => t.cls === "ref");
    const parTokens = tokens.filter((t) => t.cls === "par");

    expect(refTokens.map((t) => t.text)).toEqual(['{"ref": "Token"}', '{"ref": "Vault"}']);
    expect(parTokens.map((t) => t.text)).toEqual(['{"param": "feeBps"}', '{"read": "Registry.opsAddress"}']);
  });

  it("classes object keys as k and plain string values as s", () => {
    const tokens = tokenizeSpec(SPEC_JSON);
    const keys = tokens.filter((t) => t.cls === "k").map((t) => t.text);
    const strings = tokens.filter((t) => t.cls === "s").map((t) => t.text);

    expect(keys).toEqual(
      expect.arrayContaining(['"contracts"', '"id"', '"args"', '"after"', '"config"', '"wire"', '"with"', '"grantRole"', '"on"', '"to"']),
    );
    expect(strings).toEqual(expect.arrayContaining(['"Token"', '"Registry"', '"Vault"', '"KEEPER"']));
  });

  it("classes JSON punctuation as pun and leaves whitespace unclassed", () => {
    const tokens = tokenizeSpec('{"a": 1}\n  ');
    expect(tokens.filter((t) => t.cls === "pun").map((t) => t.text)).toEqual(["{", ":", "}"]);
    expect(tokens.some((t) => !t.cls && /\s/.test(t.text))).toBe(true);
  });
});

describe("SpecCode", () => {
  it("renders the tokenized source inside a .code block", () => {
    const { container } = render(<SpecCode source={SPEC_JSON} />);

    const code = container.querySelector(".code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(SPEC_JSON);
    expect(code?.querySelectorAll(".ref")).toHaveLength(2);
    expect(code?.querySelectorAll(".par")).toHaveLength(2);
  });
});

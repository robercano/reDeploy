// Lightweight syntax highlighter for the tiny spec-JSON dialect shown in the
// hero split pane. Rather than hand-authoring a tree of colored <span>s (easy
// to typo and hard to keep in sync with content.ts), we tokenize the raw
// SPEC_JSON text at render time and color it the same way the approved design
// does: keys dim, plain string values ink, {"ref": …} lime, {"param"/"read": …}
// amber, and JSON punctuation a muted grey. Everything else (whitespace,
// newlines, indentation) is left uncolored.

type TokenClass = "k" | "s" | "ref" | "par" | "pun";

interface Token {
  text: string;
  cls?: TokenClass;
}

const TOKEN_RE = /\{"ref":\s*"[^"]*"\}|\{"(?:param|read)":\s*"[^"]*"\}|"[^"]*"|[{}[\]:,]/g;

export function tokenizeSpec(source: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(TOKEN_RE)) {
    const text = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      tokens.push({ text: source.slice(lastIndex, index) });
    }

    let cls: TokenClass;
    if (text.startsWith('{"ref"')) {
      cls = "ref";
    } else if (text.startsWith('{"param"') || text.startsWith('{"read"')) {
      cls = "par";
    } else if (text.startsWith('"')) {
      const after = source.slice(index + text.length);
      cls = /^\s*:/.test(after) ? "k" : "s";
    } else {
      cls = "pun";
    }

    tokens.push({ text, cls });
    lastIndex = index + text.length;
  }

  if (lastIndex < source.length) {
    tokens.push({ text: source.slice(lastIndex) });
  }

  return tokens;
}

export default function SpecCode({ source }: { source: string }) {
  const tokens = tokenizeSpec(source);

  return (
    <div className="code">
      {tokens.map((token, i) =>
        token.cls ? (
          <span key={i} className={token.cls}>
            {token.text}
          </span>
        ) : (
          <span key={i}>{token.text}</span>
        ),
      )}
    </div>
  );
}

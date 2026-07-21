/**
 * Output formatting for @redeploy/cli.
 *
 * Two output modes:
 *   - human (default): a short header line + a pretty-printed JSON body,
 *     written to stdout on success / stderr on failure.
 *   - --json: a single machine-readable JSON envelope, written to stdout on
 *     success / stderr on failure, so scripts/CI can parse it reliably.
 *
 * SECURITY: `redact()` is applied to every string this module ever formats.
 * It is defense-in-depth — commands must never put a raw or normalized
 * private key into a result payload in the first place (only derived
 * addresses), but redact() ensures that if one ever leaked in, it would not
 * reach stdout/stderr verbatim.
 */

/** The uniform result shape every subcommand's dispatch resolves to. */
export interface CommandResult {
  readonly ok: boolean;
  /** Present when ok:true (or for a domain-level ok:false, e.g. a failed simulation). */
  readonly data?: unknown;
  /** Present for a thrown/setup error (bad flags, missing env, unexpected library error). */
  readonly error?: { readonly message: string; readonly code?: string };
}

/** The envelope shape written in --json mode. */
export interface JsonEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: { readonly message: string; readonly code?: string };
}

/**
 * Redact a secret value out of an arbitrary string.
 *
 * Replaces every occurrence of `secret` (when non-empty) with `[REDACTED]`.
 * Also checks a bare-hex / "0x"-prefixed variant of the same key so a
 * normalized or un-normalized copy is caught either way.
 */
export function redact(input: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") return input;

  const trimmed = secret.trim();
  if (trimmed === "") return input;

  const variants = new Set<string>([
    trimmed,
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed,
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed : `0x${trimmed}`,
  ]);

  let out = input;
  for (const variant of variants) {
    if (variant === "") continue;
    out = out.split(variant).join("[REDACTED]");
  }
  return out;
}

/** JSON.stringify replacer that renders bigint values (e.g. constructor args) as decimal strings. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** JSON.stringify with bigint support. Never throws on bigint-containing payloads. */
function safeStringify(value: unknown, pretty = true): string {
  return JSON.stringify(value, jsonReplacer, pretty ? 2 : undefined);
}

/** Format a human-readable header line for a command result. */
export function formatHumanHeader(command: string, ok: boolean): string {
  return `${ok ? "OK" : "FAILED"}: redeploy ${command}`;
}

/**
 * Render a CommandResult for output.
 *
 * @returns `{ text, stream }` — `stream` is "stdout" for ok:true, "stderr" for ok:false.
 */
export function renderResult(
  command: string,
  result: CommandResult,
  json: boolean,
  secret?: string,
): { text: string; stream: "stdout" | "stderr" } {
  const stream: "stdout" | "stderr" = result.ok ? "stdout" : "stderr";

  if (json) {
    const envelope: JsonEnvelope = { ok: result.ok, command, data: result.data, error: result.error };
    return { text: redact(safeStringify(envelope), secret), stream };
  }

  const header = formatHumanHeader(command, result.ok);
  const bodyParts: string[] = [];
  if (result.error !== undefined) {
    bodyParts.push(`${result.error.code ? `[${result.error.code}] ` : ""}${result.error.message}`);
  }
  if (result.data !== undefined) {
    bodyParts.push(safeStringify(result.data));
  }
  const text = [header, ...bodyParts].join("\n");
  return { text: redact(text, secret), stream };
}

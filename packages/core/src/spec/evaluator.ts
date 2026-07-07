/**
 * Safe expression evaluator for computed argument values in deployment specs.
 *
 * Supports:
 * - BigInt arithmetic: +, -, *, /
 * - Comparison operators: <, >, <=, >=, ==, !=
 * - Functions: min(), max(), keccak256(), abi.encode(), concat(), CREATE2()
 * - References: params.<name>, ${<contractId>}
 * - Conditionals: if(condition, thenValue, elseValue)
 *
 * This evaluator is safe: no eval(), no external I/O, deterministic results.
 */

import { keccak256, encodePacked, encodeAbiParameters, type AbiParameter } from "viem";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context passed to the evaluator: parameter values and deployed contract
 * addresses for reference resolution.
 *
 * contractAddresses can contain either hex addresses (strings) or other values
 * like Ignition Futures at compile time.
 */
export interface EvaluationContext {
  /** Parameter name → BigInt value for params.* references. */
  readonly params: Record<string, bigint>;
  /** Contract id → address (string) or other value (e.g., Future) for ${contractId} references. */
  readonly contractAddresses: Record<string, bigint | string | unknown>;
}

/**
 * Thrown when expression evaluation fails (invalid syntax, unknown references,
 * type errors, etc.).
 */
export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationError";
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | "number" // BigInt literal like 5n (stored without 'n')
  | "hex" // Hex literal like 0x1234
  | "string" // String literal like "hello"
  | "ident" // Identifier like min, max, params
  | "dollar" // $ for ${...} references
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "comma"
  | "dot"
  | "lt" // <
  | "gt" // >
  | "lte" // <=
  | "gte" // >=
  | "eq" // ==
  | "ne" // !=
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

class Tokenizer {
  private input: string;
  private pos: number = 0;

  constructor(input: string) {
    this.input = input;
  }

  private peek(): string {
    return this.pos < this.input.length ? this.input[this.pos] : "";
  }

  private peekN(n: number): string {
    return this.input.slice(this.pos, this.pos + n);
  }

  private advance(): string {
    const ch = this.peek();
    this.pos++;
    return ch;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek())) {
      this.advance();
    }
  }

  next(): Token {
    this.skipWhitespace();

    if (this.pos >= this.input.length) {
      return { kind: "eof", value: "", pos: this.pos };
    }

    const startPos = this.pos;
    const ch = this.peek();

    // String literals
    if (ch === '"') {
      this.advance(); // skip opening quote
      let str = "";
      while (this.peek() && this.peek() !== '"') {
        if (this.peek() === "\\") {
          this.advance();
          const escaped = this.advance();
          str += escaped;
        } else {
          str += this.advance();
        }
      }
      if (!this.peek()) {
        throw new EvaluationError(`Unterminated string literal at position ${startPos}`);
      }
      this.advance(); // skip closing quote
      return { kind: "string", value: str, pos: startPos };
    }

    // Numbers (BigInt and hex)
    if (/\d/.test(ch) || (ch === "0" && /[xX]/.test(this.peekN(2)[1]))) {
      if (ch === "0" && /[xX]/.test(this.peekN(2)[1])) {
        // Hex literal: 0x...
        this.advance(); // 0
        this.advance(); // x
        let hex = "";
        while (/[0-9a-fA-F]/.test(this.peek())) {
          hex += this.advance();
        }
        if (!hex) {
          throw new EvaluationError(`Invalid hex literal at position ${startPos}`);
        }
        return { kind: "hex", value: "0x" + hex, pos: startPos };
      } else {
        // Decimal number (must be followed by 'n' for BigInt)
        let num = "";
        while (/\d/.test(this.peek())) {
          num += this.advance();
        }
        if (this.peek() === "n") {
          this.advance(); // consume 'n'
          // Store just the number part without 'n'
          return { kind: "number", value: num, pos: startPos };
        } else {
          throw new EvaluationError(
            `Decimal number must be suffixed with 'n' for BigInt at position ${startPos}`,
          );
        }
      }
    }

    // Dollar sign for ${...}
    if (ch === "$") {
      this.advance();
      return { kind: "dollar", value: "$", pos: startPos };
    }

    // Operators and punctuation
    if (ch === "+") {
      this.advance();
      return { kind: "plus", value: "+", pos: startPos };
    }
    if (ch === "-") {
      this.advance();
      return { kind: "minus", value: "-", pos: startPos };
    }
    if (ch === "*") {
      this.advance();
      return { kind: "star", value: "*", pos: startPos };
    }
    if (ch === "/") {
      this.advance();
      return { kind: "slash", value: "/", pos: startPos };
    }
    if (ch === "(") {
      this.advance();
      return { kind: "lparen", value: "(", pos: startPos };
    }
    if (ch === ")") {
      this.advance();
      return { kind: "rparen", value: ")", pos: startPos };
    }
    if (ch === "{") {
      this.advance();
      return { kind: "lbrace", value: "{", pos: startPos };
    }
    if (ch === "}") {
      this.advance();
      return { kind: "rbrace", value: "}", pos: startPos };
    }
    if (ch === ",") {
      this.advance();
      return { kind: "comma", value: ",", pos: startPos };
    }
    if (ch === ".") {
      this.advance();
      return { kind: "dot", value: ".", pos: startPos };
    }

    // Comparison operators
    if (ch === "<") {
      this.advance();
      if (this.peek() === "=") {
        this.advance();
        return { kind: "lte", value: "<=", pos: startPos };
      }
      return { kind: "lt", value: "<", pos: startPos };
    }
    if (ch === ">") {
      this.advance();
      if (this.peek() === "=") {
        this.advance();
        return { kind: "gte", value: ">=", pos: startPos };
      }
      return { kind: "gt", value: ">", pos: startPos };
    }
    if (ch === "=" && this.peekN(2) === "==") {
      this.advance();
      this.advance();
      return { kind: "eq", value: "==", pos: startPos };
    }
    if (ch === "!" && this.peekN(2) === "!=") {
      this.advance();
      this.advance();
      return { kind: "ne", value: "!=", pos: startPos };
    }

    // Identifiers
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = "";
      while (/[a-zA-Z0-9_]/.test(this.peek())) {
        ident += this.advance();
      }
      return { kind: "ident", value: ident, pos: startPos };
    }

    throw new EvaluationError(`Unexpected character '${ch}' at position ${startPos}`);
  }
}

// ---------------------------------------------------------------------------
// AST Nodes
// ---------------------------------------------------------------------------

type ASTNode =
  | { kind: "number"; value: bigint }
  | { kind: "hex"; value: string }
  | { kind: "string"; value: string }
  | { kind: "param"; name: string }
  | { kind: "contract"; id: string }
  | { kind: "binary"; op: BinaryOp; left: ASTNode; right: ASTNode }
  | { kind: "comparison"; op: ComparisonOp; left: ASTNode; right: ASTNode }
  | { kind: "call"; name: string; args: ASTNode[] }
  | { kind: "if"; condition: ASTNode; then: ASTNode; else: ASTNode };

type BinaryOp = "+" | "-" | "*" | "/";
type ComparisonOp = "<" | ">" | "<=" | ">=" | "==" | "!=";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokenizer: Tokenizer;
  protected current: Token;

  constructor(input: string) {
    this.tokenizer = new Tokenizer(input);
    this.current = this.tokenizer.next();
  }

  parse(): ASTNode {
    const node = this.parseExpression();
    if (this.current.kind !== "eof") {
      throw new EvaluationError(`Unexpected token '${this.current.value}' after expression`);
    }
    return node;
  }

  protected advance(): Token {
    const prev = this.current;
    this.current = this.tokenizer.next();
    return prev;
  }

  protected expect(kind: TokenKind): Token {
    if (this.current.kind !== kind) {
      throw new EvaluationError(
        `Expected ${kind}, got ${this.current.kind} (${this.current.value})`,
      );
    }
    return this.advance();
  }

  protected parseExpression(): ASTNode {
    return this.parseConditional();
  }

  protected parseConditional(): ASTNode {
    // if(condition, thenValue, elseValue)
    if (this.current.kind === "ident" && this.current.value === "if") {
      this.advance(); // consume 'if'
      this.expect("lparen");
      const condition = this.parseComparison();
      this.expect("comma");
      const thenNode = this.parseExpression();
      this.expect("comma");
      const elseNode = this.parseExpression();
      this.expect("rparen");
      return { kind: "if", condition, then: thenNode, else: elseNode };
    }
    return this.parseComparison();
  }

  private parseComparison(): ASTNode {
    let left = this.parseAdditive();

    while (
      this.current.kind === "lt" ||
      this.current.kind === "gt" ||
      this.current.kind === "lte" ||
      this.current.kind === "gte" ||
      this.current.kind === "eq" ||
      this.current.kind === "ne"
    ) {
      const opToken = this.advance();
      const op = opToken.value as ComparisonOp;
      const right = this.parseAdditive();
      left = { kind: "comparison", op, left, right };
    }

    return left;
  }

  private parseAdditive(): ASTNode {
    let left = this.parseMultiplicative();

    while (this.current.kind === "plus" || this.current.kind === "minus") {
      const opToken = this.advance();
      const op = (opToken.kind === "plus" ? "+" : "-") as BinaryOp;
      const right = this.parseMultiplicative();
      left = { kind: "binary", op, left, right };
    }

    return left;
  }

  private parseMultiplicative(): ASTNode {
    let left = this.parseUnary();

    while (this.current.kind === "star" || this.current.kind === "slash") {
      const opToken = this.advance();
      const op = (opToken.kind === "star" ? "*" : "/") as BinaryOp;
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }

    return left;
  }

  private parseUnary(): ASTNode {
    if (this.current.kind === "minus") {
      this.advance();
      const operand = this.parseUnary();
      // Implement unary minus as 0 - operand
      return { kind: "binary", op: "-", left: { kind: "number", value: 0n }, right: operand };
    }

    return this.parsePrimary();
  }

  protected parsePrimary(): ASTNode {
    // Check for params.<name>
    if (this.current.kind === "ident" && this.current.value === "params") {
      const nextIsLookahead = this.peekNext();
      if (nextIsLookahead?.kind === "dot") {
        // After peekNext, current is '.', advance moves past it
        this.advance(); // consume '.' and move to next token
        if (this.current.kind !== "ident") {
          throw new EvaluationError(`Expected parameter name after 'params.'`);
        }
        const paramName = this.current.value;
        this.advance();
        return { kind: "param", name: paramName };
      }
    }

    // Function call or identifier
    if (this.current.kind === "ident") {
      const identValue = this.current.value;
      const pos = this.current.pos;

      // Check if it's a function call
      const nextToken = this.peekNext();
      if (nextToken?.kind === "lparen") {
        // After peekNext, current is '(', advance moves past it
        this.advance(); // consume '(' and move to first argument
        const args: ASTNode[] = [];

        // @ts-expect-error after advance, type narrows
        if (this.current.kind !== "rparen") {
          args.push(this.parseConditional()); // Use parseConditional to stop at commas
          let nextKind = this.current.kind;
          while ((nextKind as TokenKind) === "comma") {
            this.advance(); // consume comma
            args.push(this.parseConditional()); // Use parseConditional to stop at commas
            nextKind = this.current.kind;
          }
        }

        this.expect("rparen");
        return { kind: "call", name: identValue, args };
      }

      throw new EvaluationError(
        `Unexpected identifier '${identValue}' at position ${pos}. Did you mean a function call?`,
      );
    }

    // String literal
    if (this.current.kind === "string") {
      const value = this.current.value;
      this.advance();
      return { kind: "string", value };
    }

    // BigInt number
    if (this.current.kind === "number") {
      const value = BigInt(this.current.value);
      this.advance();
      return { kind: "number", value };
    }

    // Hex literal
    if (this.current.kind === "hex") {
      const value = this.current.value;
      this.advance();
      return { kind: "hex", value };
    }

    // Contract reference: ${contractId}
    if (this.current.kind === "dollar") {
      this.advance(); // consume $
      this.expect("lbrace");
      // @ts-expect-error type narrowing across advance call
      if (this.current.kind !== "ident") {
        throw new EvaluationError(`Expected contract id in \${...}`);
      }
      const contractId = this.current.value;
      this.advance();
      this.expect("rbrace");
      return { kind: "contract", id: contractId };
    }

    // Parenthesized expression
    if (this.current.kind === "lparen") {
      this.advance(); // consume (
      const node = this.parseExpression();
      this.expect("rparen");
      return node;
    }

    throw new EvaluationError(
      `Unexpected token '${this.current.value}' (kind: ${this.current.kind})`,
    );
  }

  protected peekNext(): Token | null {
    // Simple one-token lookahead
    const saved = this.current;
    this.advance();
    const next = this.current;
    this.current = saved;
    return next;
  }
}

// Custom parser that handles abi.encode() with dot notation
class ParserWithAbiEncode extends Parser {
  protected override parsePrimary(): ASTNode {
    // Check for abi.encode() first
    if (!(this.current.kind === "ident" && this.current.value === "abi")) {
      return super.parsePrimary();
    }

    const nextIsLookahead = this.peekNext();
    if (nextIsLookahead?.kind !== "dot") {
      // Not "abi." - let parent handle it
      return super.parsePrimary();
    }

    // After peekNext, current is '.', advance moves past it
    this.advance(); // consume '.' and move to next token

    // @ts-expect-error type narrowing from lookahead
    if (!(this.current.kind === "ident" && this.current.value === "encode")) {
      throw new EvaluationError(`Expected abi.encode(...) syntax`);
    }

    this.advance(); // consume 'encode'

    // @ts-expect-error type narrowing from lookahead
    if (this.current.kind !== "lparen") {
      throw new EvaluationError(`Expected abi.encode(...) syntax`);
    }

    // After advance, current should be '('
    this.advance(); // consume '(' and move to first argument
    const args: ASTNode[] = [];

    while (this.current.kind !== "rparen") {
      args.push(this.parseConditional()); // Use parseConditional to stop at commas
      if (this.current.kind === "comma") {
        this.advance();
      } else {
        break;
      }
    }

    this.expect("rparen");
    return { kind: "call", name: "abi.encode", args };
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function evaluateNode(node: ASTNode, context: EvaluationContext): bigint | string | unknown;
function evaluateNode(node: ASTNode, context: EvaluationContext): bigint | string | unknown {
  switch (node.kind) {
    case "number":
      return node.value;

    case "hex":
      return node.value;

    case "string":
      return node.value;

    case "param": {
      const value = context.params[node.name];
      if (value === undefined) {
        throw new EvaluationError(`Unknown parameter: ${node.name}`);
      }
      return value;
    }

    case "contract": {
      const addr = context.contractAddresses[node.id];
      if (addr === undefined) {
        throw new EvaluationError(`Unknown contract reference: ${node.id}`);
      }
      // Return the value as-is, which might be a string address or a Future
      return addr;
    }

    case "binary": {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);

      if (typeof left !== "bigint" || typeof right !== "bigint") {
        throw new EvaluationError(
          `Binary operation '${node.op}' requires BigInt operands, got ${typeof left} and ${typeof right}`,
        );
      }

      // Narrow type for type-safe switch
      const binaryOp: BinaryOp = node.op;
      switch (binaryOp) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0n) {
            throw new EvaluationError("Division by zero");
          }
          return left / right;
      }
      throw new EvaluationError(`Unknown binary operator: ${(binaryOp as BinaryOp)}`);
    }

    case "comparison": {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);

      if (typeof left !== "bigint" || typeof right !== "bigint") {
        throw new EvaluationError(
          `Comparison '${node.op}' requires BigInt operands, got ${typeof left} and ${typeof right}`,
        );
      }

      // Narrow type for type-safe switch
      const comparisonOp: ComparisonOp = node.op;
      let result: boolean;
      switch (comparisonOp) {
        case "<":
          result = left < right;
          break;
        case ">":
          result = left > right;
          break;
        case "<=":
          result = left <= right;
          break;
        case ">=":
          result = left >= right;
          break;
        case "==":
          result = left === right;
          break;
        case "!=":
          result = left !== right;
          break;
      }
      return result ? 1n : 0n;
    }

    case "if": {
      const condValue = evaluateNode(node.condition, context);
      const isTruthy =
        typeof condValue === "bigint"
          ? condValue !== 0n
          : typeof condValue === "string" && (condValue as string).length > 0;
      return evaluateNode(isTruthy ? node.then : node.else, context);
    }

    case "call":
      return evaluateCall(node.name, node.args, context);
  }
}

function evaluateCall(
  name: string,
  args: ASTNode[],
  context: EvaluationContext,
): bigint | string | unknown {
  switch (name) {
    case "min": {
      if (args.length < 2) {
        throw new EvaluationError(`min() requires at least 2 arguments, got ${args.length}`);
      }
      const values = args.map((arg) => evaluateNode(arg, context));
      if (values.some((v) => typeof v !== "bigint")) {
        throw new EvaluationError("min() requires all BigInt arguments");
      }
      return (values as bigint[]).reduce((a, b) => (a < b ? a : b));
    }

    case "max": {
      if (args.length < 2) {
        throw new EvaluationError(`max() requires at least 2 arguments, got ${args.length}`);
      }
      const values = args.map((arg) => evaluateNode(arg, context));
      if (values.some((v) => typeof v !== "bigint")) {
        throw new EvaluationError("max() requires all BigInt arguments");
      }
      return (values as bigint[]).reduce((a, b) => (a > b ? a : b));
    }

    case "keccak256": {
      if (args.length !== 1) {
        throw new EvaluationError(`keccak256() requires exactly 1 argument, got ${args.length}`);
      }
      const value = evaluateNode(args[0], context);
      if (typeof value !== "string") {
        throw new EvaluationError(`keccak256() requires a string argument, got ${typeof value}`);
      }
      return keccak256(value as `0x${string}`);
    }

    case "abi.encode": {
      if (args.length === 0) {
        throw new EvaluationError(`abi.encode() requires at least 1 argument`);
      }

      const values = args.map((arg) => evaluateNode(arg, context));

      // Convert to ABI-encodable values
      const abiValues: unknown[] = [];
      const abiTypes: AbiParameter[] = [];

      for (const val of values) {
        if (typeof val === "bigint") {
          abiValues.push(val);
          abiTypes.push({ type: "uint256" });
        } else if (typeof val === "string") {
          if (val.startsWith("0x")) {
            // Assume it's an address or bytes32
            if (val.length === 42) {
              // 0x + 40 hex chars
              abiValues.push(val);
              abiTypes.push({ type: "address" });
            } else {
              // Assume bytes32 or similar
              abiValues.push(val);
              abiTypes.push({ type: "bytes32" });
            }
          } else {
            // Plain string
            abiValues.push(val);
            abiTypes.push({ type: "string" });
          }
        } else {
          throw new EvaluationError(`abi.encode() received unsupported type: ${typeof val}`);
        }
      }

      return encodeAbiParameters(abiTypes, abiValues);
    }

    case "concat": {
      if (args.length < 2) {
        throw new EvaluationError(
          `concat() requires at least 2 arguments, got ${args.length}`,
        );
      }
      const values = args.map((arg) => evaluateNode(arg, context));
      if (values.some((v) => typeof v !== "string")) {
        throw new EvaluationError("concat() requires all hex string arguments");
      }

      // Simple hex concatenation: strip 0x, concatenate, add back 0x
      const hexStrings = values as string[];
      const normalized = hexStrings.map((h) => {
        if (!h.startsWith("0x")) {
          throw new EvaluationError(`concat() requires hex strings (0x prefix), got: ${h}`);
        }
        return h.slice(2);
      });

      // Pad all to the same length as the longest
      const maxLen = Math.max(...normalized.map((h) => h.length));
      const padded = normalized.map((h) => h.padStart(maxLen, "0"));

      return "0x" + padded.join("");
    }

    case "CREATE2": {
      if (args.length !== 4) {
        throw new EvaluationError(
          `CREATE2() requires exactly 4 arguments (deployer, salt, initCodeHash), got ${args.length}`,
        );
      }

      const deployer = evaluateNode(args[0], context);
      const saltValue = evaluateNode(args[1], context);
      const saltNum = evaluateNode(args[2], context);
      const initCodeHash = evaluateNode(args[3], context);

      if (typeof deployer !== "string" || !deployer.startsWith("0x")) {
        throw new EvaluationError(`CREATE2() deployer must be a hex address (0x prefix)`);
      }
      if (typeof saltValue !== "string" || !saltValue.startsWith("0x")) {
        throw new EvaluationError(`CREATE2() salt must be a hex value (0x prefix)`);
      }
      if (typeof saltNum !== "bigint") {
        throw new EvaluationError(`CREATE2() salt (3rd arg) must be a BigInt`);
      }
      if (typeof initCodeHash !== "string" || initCodeHash.length !== 66) {
        // 0x + 64 hex chars
        throw new EvaluationError(`CREATE2() initCodeHash must be a 32-byte keccak256 hash`);
      }

      // Compute CREATE2: keccak256(0xff || deployer || salt || initCodeHash)
      const packed = encodePacked(
        ["bytes1", "address", "uint256", "bytes32"],
        ["0xff", deployer as `0x${string}`, saltNum, initCodeHash as `0x${string}`],
      );
      const hash = keccak256(packed);
      // Take last 20 bytes (40 hex chars) and prepend 0x
      return "0x" + hash.slice(-40);
    }

    default:
      throw new EvaluationError(`Unknown function: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates a safe expression string and returns the computed value.
 *
 * Supported operations:
 * - BigInt arithmetic: +, -, *, /
 * - Comparison: <, >, <=, >=, ==, !=
 * - Functions: min(), max(), keccak256(), abi.encode(), concat(), CREATE2()
 * - References: params.<name>, ${<contractId>}
 * - Conditionals: if(condition, thenValue, elseValue)
 *
 * @param expression The expression string to evaluate.
 * @param context    Evaluation context with parameter and contract address values.
 * @returns          The computed BigInt or hex string result.
 *
 * @throws EvaluationError if the expression is invalid or references are missing.
 */
export function evaluateExpression(
  expression: string,
  context: EvaluationContext,
): bigint | string | unknown {
  if (!expression || !expression.trim()) {
    throw new EvaluationError("Expression cannot be empty");
  }

  const parser = new ParserWithAbiEncode(expression);
  const ast = parser.parse();

  return evaluateNode(ast, context);
}

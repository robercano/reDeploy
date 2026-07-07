import { describe, it, expect } from "vitest";
import {
  evaluateExpression,
  type EvaluationContext,
} from "../src/spec/evaluator.js";

describe("Expression Evaluator", () => {
  // Test helpers
  const createContext = (
    overrides?: Partial<EvaluationContext>,
  ): EvaluationContext => ({
    params: {},
    contractAddresses: {},
    ...overrides,
  });

  // =========================================================================
  // BigInt Arithmetic Tests
  // =========================================================================

  describe("BigInt arithmetic", () => {
    it("adds two numbers", () => {
      const result = evaluateExpression("5n + 3n", createContext());
      expect(result).toBe(8n);
    });

    it("subtracts two numbers", () => {
      const result = evaluateExpression("10n - 3n", createContext());
      expect(result).toBe(7n);
    });

    it("multiplies two numbers", () => {
      const result = evaluateExpression("6n * 7n", createContext());
      expect(result).toBe(42n);
    });

    it("divides two numbers", () => {
      const result = evaluateExpression("20n / 4n", createContext());
      expect(result).toBe(5n);
    });

    it("handles integer division correctly", () => {
      const result = evaluateExpression("10n / 3n", createContext());
      expect(result).toBe(3n);
    });

    it("handles large numbers", () => {
      const result = evaluateExpression(
        "115792089237316195423570985008687907853269984665640564039457584007913129639935n + 1n",
        createContext(),
      );
      expect(result).toBe(115792089237316195423570985008687907853269984665640564039457584007913129639936n);
    });

    it("supports grouping with parentheses", () => {
      const result = evaluateExpression("(5n + 3n) * 2n", createContext());
      expect(result).toBe(16n);
    });

    it("respects operator precedence", () => {
      const result = evaluateExpression("2n + 3n * 4n", createContext());
      expect(result).toBe(14n);
    });

    it("allows whitespace in expressions", () => {
      const result = evaluateExpression("  10n  +  5n  ", createContext());
      expect(result).toBe(15n);
    });

    it("throws on division by zero", () => {
      expect(() => evaluateExpression("5n / 0n", createContext())).toThrow(
        /division by zero/i,
      );
    });

    it("throws on invalid syntax", () => {
      expect(() => evaluateExpression("5n ++", createContext())).toThrow();
      expect(() => evaluateExpression("5n +", createContext())).toThrow();
      expect(() => evaluateExpression("* 5n", createContext())).toThrow();
    });
  });

  // =========================================================================
  // min/max Function Tests
  // =========================================================================

  describe("min/max functions", () => {
    it("computes min of two values", () => {
      const result = evaluateExpression("min(5n, 3n)", createContext());
      expect(result).toBe(3n);
    });

    it("computes max of two values", () => {
      const result = evaluateExpression("max(5n, 3n)", createContext());
      expect(result).toBe(5n);
    });

    it("computes min with multiple arguments", () => {
      const result = evaluateExpression("min(10n, 3n, 7n, 1n)", createContext());
      expect(result).toBe(1n);
    });

    it("computes max with multiple arguments", () => {
      const result = evaluateExpression("max(10n, 3n, 7n, 20n)", createContext());
      expect(result).toBe(20n);
    });

    it("allows nested expressions in min", () => {
      const result = evaluateExpression("min(2n + 3n, 4n * 1n)", createContext());
      expect(result).toBe(4n);
    });

    it("allows nested expressions in max", () => {
      const result = evaluateExpression("max(2n + 3n, 4n * 1n)", createContext());
      expect(result).toBe(5n);
    });

    it("throws on min with no arguments", () => {
      expect(() => evaluateExpression("min()", createContext())).toThrow();
    });

    it("throws on max with no arguments", () => {
      expect(() => evaluateExpression("max()", createContext())).toThrow();
    });

    it("throws on min with one argument", () => {
      expect(() => evaluateExpression("min(5n)", createContext())).toThrow();
    });
  });

  // =========================================================================
  // Conditional (if/then/else) Tests
  // =========================================================================

  describe("conditionals", () => {
    it("evaluates if/then/else with true condition", () => {
      const result = evaluateExpression("if(1n > 0n, 10n, 20n)", createContext());
      expect(result).toBe(10n);
    });

    it("evaluates if/then/else with false condition", () => {
      const result = evaluateExpression("if(1n < 0n, 10n, 20n)", createContext());
      expect(result).toBe(20n);
    });

    it("supports equality comparison", () => {
      const result = evaluateExpression("if(5n == 5n, 100n, 200n)", createContext());
      expect(result).toBe(100n);
    });

    it("supports inequality comparison", () => {
      const result = evaluateExpression("if(5n != 3n, 100n, 200n)", createContext());
      expect(result).toBe(100n);
    });

    it("supports less-than or equal", () => {
      const result = evaluateExpression("if(5n <= 5n, 100n, 200n)", createContext());
      expect(result).toBe(100n);
    });

    it("supports greater-than or equal", () => {
      const result = evaluateExpression("if(5n >= 6n, 100n, 200n)", createContext());
      expect(result).toBe(200n);
    });

    it("supports nested conditions", () => {
      const result = evaluateExpression(
        "if(10n > 5n, if(2n > 1n, 100n, 200n), 300n)",
        createContext(),
      );
      expect(result).toBe(100n);
    });

    it("throws on invalid comparison operator", () => {
      expect(() => evaluateExpression("if(5n >>> 3n, 10n, 20n)", createContext())).toThrow();
    });
  });

  // =========================================================================
  // Parameter Reference Tests
  // =========================================================================

  describe("parameter references", () => {
    it("resolves params.name to a bigint literal", () => {
      const result = evaluateExpression("params.initialAmount", createContext({
        params: { initialAmount: 1000n },
      }));
      expect(result).toBe(1000n);
    });

    it("resolves params.name in expressions", () => {
      const result = evaluateExpression("params.amount + 10n", createContext({
        params: { amount: 50n },
      }));
      expect(result).toBe(60n);
    });

    it("throws on unknown parameter", () => {
      expect(() => evaluateExpression("params.unknownParam", createContext())).toThrow(
        /unknown parameter/i,
      );
    });

    it("throws on missing parameter in context", () => {
      expect(() => evaluateExpression("params.amount", createContext({
        params: { other: 100n },
      }))).toThrow(/unknown parameter/i);
    });
  });

  // =========================================================================
  // Contract Address Reference Tests
  // =========================================================================

  describe("contract address references", () => {
    it("resolves ${contractId} to a hex address", () => {
      const result = evaluateExpression("${tokenAddress}", createContext({
        contractAddresses: { tokenAddress: "0x1234567890123456789012345678901234567890" },
      }));
      expect(result).toBe("0x1234567890123456789012345678901234567890");
    });

    it("throws on unknown contract reference", () => {
      expect(() => evaluateExpression("${unknownContract}", createContext())).toThrow(
        /unknown contract/i,
      );
    });

    it("throws on missing contract in context", () => {
      expect(() => evaluateExpression("${token}", createContext({
        contractAddresses: { other: "0x1234567890123456789012345678901234567890" },
      }))).toThrow(/unknown contract/i);
    });
  });

  // =========================================================================
  // keccak256 Tests
  // =========================================================================

  describe("keccak256 hashing", () => {
    it("hashes a simple string", () => {
      const result = evaluateExpression('keccak256("hello")', createContext());
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]{64}$/i);
    });

    it("hashes a parameter reference", () => {
      const result = evaluateExpression("keccak256(params.data)", createContext({
        params: { data: "test" },
      }));
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]{64}$/i);
    });

    it("consistently hashes the same input", () => {
      const ctx = createContext();
      const hash1 = evaluateExpression('keccak256("test")', ctx);
      const hash2 = evaluateExpression('keccak256("test")', ctx);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", () => {
      const ctx = createContext();
      const hash1 = evaluateExpression('keccak256("test1")', ctx);
      const hash2 = evaluateExpression('keccak256("test2")', ctx);
      expect(hash1).not.toBe(hash2);
    });

    it("throws on non-string arguments", () => {
      expect(() => evaluateExpression("keccak256(5n)", createContext())).toThrow();
    });
  });

  // =========================================================================
  // abi.encode Tests
  // =========================================================================

  describe("abi.encode", () => {
    it("encodes a single string", () => {
      const result = evaluateExpression('abi.encode("hello")', createContext());
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]+$/i);
    });

    it("encodes multiple values", () => {
      const result = evaluateExpression(
        'abi.encode("test", 100n, 0x1234567890123456789012345678901234567890)',
        createContext(),
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]+$/i);
    });

    it("encodes with parameter references", () => {
      const result = evaluateExpression("abi.encode(params.value)", createContext({
        params: { value: "encoded" },
      }));
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]+$/i);
    });

    it("encodes contract addresses", () => {
      const result = evaluateExpression(
        "abi.encode(${token})",
        createContext({
          contractAddresses: { token: "0x1234567890123456789012345678901234567890" },
        }),
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]+$/i);
    });

    it("throws on abi.encode with no arguments", () => {
      expect(() => evaluateExpression("abi.encode()", createContext())).toThrow();
    });
  });

  // =========================================================================
  // concat Tests
  // =========================================================================

  describe("concat", () => {
    it("concatenates hex strings", () => {
      const result = evaluateExpression('concat("0x1234", "0x5678")', createContext());
      expect(result).toBe("0x12345678");
    });

    it("concatenates multiple values", () => {
      const result = evaluateExpression(
        'concat("0x11", "0x22", "0x33")',
        createContext(),
      );
      expect(result).toBe("0x112233");
    });

    it("concatenates keccak256 outputs", () => {
      const result = evaluateExpression(
        'concat(keccak256("a"), keccak256("b"))',
        createContext(),
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]+$/i);
    });

    it("pads shorter hex to match longest", () => {
      const result = evaluateExpression('concat("0x1", "0x22")', createContext());
      // Should pad 0x1 to 0x0001 and concat with 0x22
      expect(result.length).toBeGreaterThan(4); // At least 0x + 4 hex chars
    });

    it("throws on concat with no arguments", () => {
      expect(() => evaluateExpression("concat()", createContext())).toThrow();
    });

    it("throws on concat with one argument", () => {
      expect(() => evaluateExpression('concat("0x1234")', createContext())).toThrow();
    });
  });

  // =========================================================================
  // CREATE2 Address Prediction Tests
  // =========================================================================

  describe("CREATE2 address prediction", () => {
    it("predicts CREATE2 address with all parameters", () => {
      const result = evaluateExpression(
        `CREATE2(
          0x0000000000000000000000000000000000000001,
          0x0000000000000000000000000000000000000000,
          100n,
          keccak256("bytecode")
        )`,
        createContext(),
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]{40}$/i);
    });

    it("throws on missing arguments", () => {
      expect(() => evaluateExpression(
        `CREATE2(
          0x0000000000000000000000000000000000000001,
          0x0000000000000000000000000000000000000000
        )`,
        createContext(),
      )).toThrow();
    });

    it("throws on non-address deployer", () => {
      expect(() => evaluateExpression(
        `CREATE2(
          "not-an-address",
          0x0000000000000000000000000000000000000000,
          100n,
          keccak256("bytecode")
        )`,
        createContext(),
      )).toThrow();
    });

    it("throws on non-bigint salt", () => {
      expect(() => evaluateExpression(
        `CREATE2(
          0x0000000000000000000000000000000000000001,
          0x0000000000000000000000000000000000000000,
          "not-a-number",
          keccak256("bytecode")
        )`,
        createContext(),
      )).toThrow();
    });

    it("throws on non-hash initCodeHash", () => {
      expect(() => evaluateExpression(
        `CREATE2(
          0x0000000000000000000000000000000000000001,
          0x0000000000000000000000000000000000000000,
          100n,
          "not-a-hash"
        )`,
        createContext(),
      )).toThrow();
    });
  });

  // =========================================================================
  // Integration Tests
  // =========================================================================

  describe("integration scenarios", () => {
    it("combines parameters with arithmetic", () => {
      const result = evaluateExpression(
        "params.baseAmount * 2n + params.bonus",
        createContext({
          params: { baseAmount: 100n, bonus: 50n },
        }),
      );
      expect(result).toBe(250n);
    });

    it("uses conditionals with parameters", () => {
      const result = evaluateExpression(
        "if(params.isInitial > 0n, params.initialSupply, params.maxSupply)",
        createContext({
          params: { isInitial: 1n, initialSupply: 1000n, maxSupply: 10000n },
        }),
      );
      expect(result).toBe(1000n);
    });

    it("nests function calls", () => {
      const result = evaluateExpression(
        'keccak256(concat(abi.encode(params.data), ${tokenId}))',
        createContext({
          params: { data: "metadata" },
          contractAddresses: { tokenId: "0x1234567890123456789012345678901234567890" },
        }),
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^0x[a-f0-9]{64}$/i);
    });

    it("computes with large numbers and operations", () => {
      const result = evaluateExpression(
        "max(params.cap, params.baseAmount * 10n) + params.bonus",
        createContext({
          params: {
            cap: 5000n,
            baseAmount: 100n,
            bonus: 250n,
          },
        }),
      );
      expect(result).toBe(5250n);
    });
  });

  // =========================================================================
  // Error Handling Tests
  // =========================================================================

  describe("error handling", () => {
    it("throws a descriptive error for empty expression", () => {
      expect(() => evaluateExpression("", createContext())).toThrow();
    });

    it("throws on unmatched parentheses", () => {
      expect(() => evaluateExpression("(5n + 3n", createContext())).toThrow();
      expect(() => evaluateExpression("5n + 3n)", createContext())).toThrow();
    });

    it("throws on invalid function names", () => {
      expect(() => evaluateExpression("unknown(5n)", createContext())).toThrow(
        /unknown function/i,
      );
    });

    it("throws on invalid literals", () => {
      expect(() => evaluateExpression('0x"invalid"', createContext())).toThrow();
    });

    it("provides context in error messages", () => {
      expect(() => evaluateExpression("params.missing", createContext())).toThrow(
        /missing/i,
      );
    });
  });
});

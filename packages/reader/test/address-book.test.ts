import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  exportAddressBook,
  type ExportAddressBookOptions,
  type DeploymentSnapshot,
  type ContractView,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-reader-address-book-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeContract(overrides: Partial<ContractView> = {}): ContractView {
  return {
    id: "MyContract",
    contractName: "MyContract",
    address: "0x1111111111111111111111111111111111111111",
    args: [],
    links: { dependencies: [], libraries: {} },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<DeploymentSnapshot> = {}): DeploymentSnapshot {
  return {
    snapshotVersion: 1,
    takenAt: "2026-07-21T00:00:00.000Z",
    chainId: 1,
    toolVersion: "1.0.0",
    specHash: "deadbeef",
    contracts: [makeContract()],
    configSteps: [],
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path — single snapshot
// ---------------------------------------------------------------------------

describe("exportAddressBook — happy path (single snapshot)", () => {
  it("produces the expected JSON structure, sorted keys, and a trailing newline", () => {
    const snapshot = makeSnapshot({
      chainId: 1,
      network: "mainnet",
      takenAt: "2026-07-21T00:00:00.000Z",
      contracts: [
        makeContract({
          id: "MyContract",
          contractName: "MyContract",
          address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      ],
    });

    const artifact = exportAddressBook({ snapshots: [snapshot] });

    expect(artifact.json.endsWith("\n")).toBe(true);
    expect(artifact.json.endsWith("\n\n")).toBe(false);

    const parsed = JSON.parse(artifact.json) as unknown;
    expect(parsed).toEqual({
      "1": {
        MyContract: {
          address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          contractName: "MyContract",
          chainId: 1,
          network: "mainnet",
          deployedAt: "2026-07-21T00:00:00.000Z",
        },
      },
    });

    // Fixed field order within an entry: address, contractName, chainId, network, deployedAt.
    const entryKeyOrderIdx = [
      artifact.json.indexOf('"address"'),
      artifact.json.indexOf('"contractName"'),
      artifact.json.indexOf('"chainId"'),
      artifact.json.indexOf('"network"'),
      artifact.json.indexOf('"deployedAt"'),
    ];
    for (let i = 1; i < entryKeyOrderIdx.length; i++) {
      expect(entryKeyOrderIdx[i]).toBeGreaterThan(entryKeyOrderIdx[i - 1]);
    }

    expect(artifact.warnings).toHaveLength(0);
  });

  it("omits the `network` field entirely when the snapshot has none", () => {
    const snapshot = makeSnapshot({ network: undefined });
    const artifact = exportAddressBook({ snapshots: [snapshot] });
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, unknown>>;
    expect(parsed["1"]!["MyContract"]).not.toHaveProperty("network");
  });

  it("respects a custom `indent` option", () => {
    const snapshot = makeSnapshot();
    const artifact = exportAddressBook({ snapshots: [snapshot], indent: 4 });
    expect(artifact.json).toContain('\n    "1"');
  });
});

// ---------------------------------------------------------------------------
// Acceptance: multiple networks
// ---------------------------------------------------------------------------

describe("exportAddressBook — acceptance: multiple networks", () => {
  it("merges two snapshots of the same spec on two chainIds into one artifact with both chainIds", () => {
    const mainnet = makeSnapshot({
      chainId: 1,
      network: "mainnet",
      contracts: [
        makeContract({
          id: "MyContract",
          contractName: "MyContract",
          address: "0x1111111111111111111111111111111111111111",
        }),
      ],
    });
    const sepolia = makeSnapshot({
      chainId: 11155111,
      network: "sepolia",
      contracts: [
        makeContract({
          id: "MyContract",
          contractName: "MyContract",
          address: "0x2222222222222222222222222222222222222222",
        }),
      ],
    });

    const artifact = exportAddressBook({ snapshots: [mainnet, sepolia] });
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, unknown>>;

    expect(Object.keys(parsed)).toEqual(["1", "11155111"]);
    expect(parsed["1"]!["MyContract"]).toMatchObject({
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
      network: "mainnet",
    });
    expect(parsed["11155111"]!["MyContract"]).toMatchObject({
      address: "0x2222222222222222222222222222222222222222",
      chainId: 11155111,
      network: "sepolia",
    });
    expect(artifact.warnings).toHaveLength(0);
  });

  it("sorts chainId keys ascending numerically even when input order is descending", () => {
    const artifact = exportAddressBook({
      snapshots: [
        makeSnapshot({ chainId: 137 }),
        makeSnapshot({ chainId: 1 }),
        makeSnapshot({ chainId: 42161 }),
      ],
    });
    const parsed = JSON.parse(artifact.json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["1", "137", "42161"]);
  });

  it("sorts contractId keys ascending via localeCompare within a chain", () => {
    const artifact = exportAddressBook({
      snapshots: [
        makeSnapshot({
          contracts: [
            makeContract({ id: "Zeta", contractName: "Zeta" }),
            makeContract({ id: "Alpha", contractName: "Alpha" }),
            makeContract({ id: "Mid", contractName: "Mid" }),
          ],
        }),
      ],
    });
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed["1"]!)).toEqual(["Alpha", "Mid", "Zeta"]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("exportAddressBook — determinism", () => {
  it("produces byte-identical json and ts for identical inputs across two builds", () => {
    const options: ExportAddressBookOptions = {
      snapshots: [
        makeSnapshot({ chainId: 5, contracts: [makeContract({ id: "B" }), makeContract({ id: "A" })] }),
      ],
    };

    const a = exportAddressBook(options);
    const b = exportAddressBook(options);

    expect(a.json).toBe(b.json);
    expect(a.ts).toBe(b.ts);
    expect(a.dts).toBe(b.dts);
  });

  it("yields sorted output regardless of unsorted input ordering", () => {
    const artifactUnsorted = exportAddressBook({
      snapshots: [
        makeSnapshot({
          chainId: 10,
          contracts: [makeContract({ id: "Z" }), makeContract({ id: "A" })],
        }),
        makeSnapshot({
          chainId: 1,
          contracts: [makeContract({ id: "Y" }), makeContract({ id: "B" })],
        }),
      ],
    });
    const artifactSorted = exportAddressBook({
      snapshots: [
        makeSnapshot({
          chainId: 1,
          contracts: [makeContract({ id: "B" }), makeContract({ id: "Y" })],
        }),
        makeSnapshot({
          chainId: 10,
          contracts: [makeContract({ id: "A" }), makeContract({ id: "Z" })],
        }),
      ],
    });

    expect(artifactUnsorted.json).toBe(artifactSorted.json);
    expect(artifactUnsorted.ts).toBe(artifactSorted.ts);
  });
});

// ---------------------------------------------------------------------------
// ABI embedding
// ---------------------------------------------------------------------------

describe("exportAddressBook — ABI embedding", () => {
  const fakeAbi = [{ type: "function", name: "foo", inputs: [], outputs: [] }];

  it("embeds the ABI verbatim when supplied via options.abis, keyed by contractName", () => {
    const artifact = exportAddressBook({
      snapshots: [makeSnapshot({ contracts: [makeContract({ contractName: "MyContract" })] })],
      abis: { MyContract: fakeAbi },
    });
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, { abi?: unknown }>>;
    expect(parsed["1"]!["MyContract"]!.abi).toEqual(fakeAbi);
    expect(artifact.ts).toContain('"foo"');
  });

  it("omits the abi field entirely (not null/empty) when no ABI is supplied", () => {
    const artifact = exportAddressBook({
      snapshots: [makeSnapshot()],
    });
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, unknown>>;
    expect(parsed["1"]!["MyContract"]).not.toHaveProperty("abi");
    expect(artifact.json).not.toContain('"abi"');
  });

  it("omits the abi field for contracts whose contractName is not present in options.abis", () => {
    const artifact = exportAddressBook({
      snapshots: [makeSnapshot({ contracts: [makeContract({ contractName: "Other" })] })],
      abis: { MyContract: fakeAbi },
    });
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, unknown>>;
    expect(parsed["1"]!["MyContract"]).not.toHaveProperty("abi");
  });
});

// ---------------------------------------------------------------------------
// Null-address contracts
// ---------------------------------------------------------------------------

describe("exportAddressBook — null-address contracts", () => {
  it("skips contracts with address: null and records a warning listing what was skipped", () => {
    const artifact = exportAddressBook({
      snapshots: [
        makeSnapshot({
          contracts: [
            makeContract({ id: "Deployed", address: "0x1111111111111111111111111111111111111111" }),
            makeContract({ id: "Pending", address: null }),
          ],
        }),
      ],
    });

    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed["1"]!)).toEqual(["Deployed"]);
    expect(artifact.warnings).toHaveLength(1);
    expect(artifact.warnings[0]).toContain("Pending");
    expect(artifact.warnings[0]).toContain("chain 1");
  });

  it("returns an empty address book (not an error) when every contract has a null address", () => {
    const artifact = exportAddressBook({
      snapshots: [makeSnapshot({ contracts: [makeContract({ address: null })] })],
    });
    expect(JSON.parse(artifact.json)).toEqual({});
    expect(artifact.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe("exportAddressBook — conflicting vs. identical duplicate entries", () => {
  it("keeps the first occurrence and warns when the same (chainId, contractId) has conflicting addresses", () => {
    const artifact = exportAddressBook({
      snapshots: [
        makeSnapshot({
          chainId: 1,
          contracts: [makeContract({ id: "X", address: "0x1111111111111111111111111111111111111111" })],
        }),
        makeSnapshot({
          chainId: 1,
          contracts: [makeContract({ id: "X", address: "0x2222222222222222222222222222222222222222" })],
        }),
      ],
    });

    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, { address: string }>>;
    expect(parsed["1"]!["X"]!.address).toBe("0x1111111111111111111111111111111111111111");
    expect(artifact.warnings).toHaveLength(1);
    expect(artifact.warnings[0]).toContain("Conflicting address");
    expect(artifact.warnings[0]).toContain("X");
  });

  it("does not warn when the same (chainId, contractId) appears twice with an identical address", () => {
    const artifact = exportAddressBook({
      snapshots: [
        makeSnapshot({
          chainId: 1,
          contracts: [makeContract({ id: "X", address: "0x1111111111111111111111111111111111111111" })],
        }),
        makeSnapshot({
          chainId: 1,
          contracts: [makeContract({ id: "X", address: "0x1111111111111111111111111111111111111111" })],
        }),
      ],
    });

    expect(artifact.warnings).toHaveLength(0);
    const parsed = JSON.parse(artifact.json) as Record<string, Record<string, { address: string }>>;
    expect(parsed["1"]!["X"]!.address).toBe("0x1111111111111111111111111111111111111111");
  });
});

// ---------------------------------------------------------------------------
// Package scaffold
// ---------------------------------------------------------------------------

describe("exportAddressBook — package scaffold", () => {
  it("does not include packageFiles when packageName is not set", () => {
    const artifact = exportAddressBook({ snapshots: [makeSnapshot()] });
    expect(artifact.packageFiles).toBeUndefined();
  });

  it("emits a package.json + index.js + index.d.ts scaffold when packageName is set", () => {
    const artifact = exportAddressBook({
      snapshots: [makeSnapshot()],
      packageName: "@acme/address-book",
    });

    expect(artifact.packageFiles).toBeDefined();
    const files = artifact.packageFiles!;
    expect(Object.keys(files).sort()).toEqual(["index.d.ts", "index.js", "package.json"]);

    const pkg = JSON.parse(files["package.json"]!) as Record<string, unknown>;
    expect(pkg["name"]).toBe("@acme/address-book");
    expect(pkg["type"]).toBe("module");
    expect(pkg["main"]).toBe("./index.js");
    expect(pkg["types"]).toBe("./index.d.ts");

    expect(files["index.js"]).toContain("export const addresses = {");
    expect(files["index.js"]).not.toContain("as const");
    expect(files["index.d.ts"]).toContain("export declare const addresses:");
  });

  it("produces deterministic packageFiles across two identical builds", () => {
    const options: ExportAddressBookOptions = {
      snapshots: [makeSnapshot()],
      packageName: "@acme/address-book",
    };
    const a = exportAddressBook(options);
    const b = exportAddressBook(options);
    expect(a.packageFiles).toEqual(b.packageFiles);
  });
});

// ---------------------------------------------------------------------------
// Empty snapshots
// ---------------------------------------------------------------------------

describe("exportAddressBook — empty snapshots", () => {
  it("returns a valid, empty-but-well-formed artifact for an empty snapshots array", () => {
    const artifact = exportAddressBook({ snapshots: [] });

    expect(JSON.parse(artifact.json)).toEqual({});
    expect(artifact.json).toBe("{}\n");
    expect(artifact.ts).toBe(
      "export const addresses = {} as const;\n\nexport type AddressBook = typeof addresses;\n",
    );
    expect(artifact.dts).toContain("export declare const addresses:");
    expect(artifact.warnings).toHaveLength(0);
  });

  it("treats a snapshot with an empty contracts array the same as no snapshot for that chain", () => {
    const artifact = exportAddressBook({ snapshots: [makeSnapshot({ contracts: [] })] });
    expect(JSON.parse(artifact.json)).toEqual({});
    expect(artifact.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Type-safety compile check
// ---------------------------------------------------------------------------

describe("exportAddressBook — generated `ts` type-safety (real tsc compile)", () => {
  it("contains `as const` and the expected nested keys", () => {
    const snapshot = makeSnapshot({
      chainId: 1,
      contracts: [makeContract({ id: "MyContract", contractName: "MyContract" })],
    });
    const artifact = exportAddressBook({ snapshots: [snapshot] });

    expect(artifact.ts).toContain("as const");
    expect(artifact.ts).toContain("export type AddressBook = typeof addresses;");
    expect(artifact.ts).toMatch(/\n\s*1:\s*\{/);
    expect(artifact.ts).toContain("MyContract:");
  });

  it("compiles cleanly with tsc --noEmit: addresses[1]?.MyContract?.address is a valid, typed access", () => {
    const snapshot = makeSnapshot({
      chainId: 1,
      network: "mainnet",
      contracts: [makeContract({ id: "MyContract", contractName: "MyContract" })],
    });
    const artifact = exportAddressBook({ snapshots: [snapshot] });

    fs.writeFileSync(path.join(tmpDir, "addresses.ts"), artifact.ts, "utf8");
    fs.writeFileSync(
      path.join(tmpDir, "consumer.ts"),
      [
        'import { addresses, type AddressBook } from "./addresses.js";',
        "",
        "const a: string | undefined = addresses[1]?.MyContract?.address;",
        "void a;",
        "",
        "const book: AddressBook = addresses;",
        "void book;",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          include: ["*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const tscBin = resolveTscBin();
    expect(() =>
      execFileSync(tscBin, ["-p", tmpDir], { stdio: "pipe", encoding: "utf8" }),
    ).not.toThrow();
  });

  it("compiles cleanly with tsc --noEmit against the packageFiles index.js + index.d.ts pair", () => {
    const snapshot = makeSnapshot({
      chainId: 1,
      contracts: [makeContract({ id: "MyContract", contractName: "MyContract" })],
    });
    const artifact = exportAddressBook({
      snapshots: [snapshot],
      packageName: "@acme/address-book",
    });
    const files = artifact.packageFiles!;

    fs.writeFileSync(path.join(tmpDir, "index.js"), files["index.js"]!, "utf8");
    fs.writeFileSync(path.join(tmpDir, "index.d.ts"), files["index.d.ts"]!, "utf8");
    fs.writeFileSync(
      path.join(tmpDir, "consumer.ts"),
      [
        'import { addresses } from "./index.js";',
        "",
        "const a: string | undefined = addresses[1]?.MyContract?.address;",
        "void a;",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            allowJs: true,
            types: [],
          },
          include: ["*.ts", "*.js"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const tscBin = resolveTscBin();
    expect(() =>
      execFileSync(tscBin, ["-p", tmpDir], { stdio: "pipe", encoding: "utf8" }),
    ).not.toThrow();
  });
});

function resolveTscBin(): string {
  const candidates = [
    path.resolve(process.cwd(), "node_modules/.bin/tsc"),
    path.resolve(process.cwd(), "../../node_modules/.bin/tsc"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate a tsc binary (checked: ${candidates.join(", ")})`);
}

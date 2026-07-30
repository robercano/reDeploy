/**
 * Tests for the cross-chain dependency ref pre-resolution pass (issue #159):
 * resolve/crossRef.ts's resolveCrossRefArgs()/specHasCrossRefArgs(), and the
 * extracted journal-read primitive resolve/journal.ts's
 * loadAddressesFromJournal().
 *
 * "Fixture journal dir" strategy: rather than hand-crafting a
 * journal.jsonl (an Ignition-internal format), we run a REAL `deploy()` call
 * against the in-memory fake EIP-1193 provider (test/testHelpers) to produce
 * a genuine journal on disk — the exact same strategy already used by
 * test/deploy.test.ts's "ctx.resolvedAddresses populated from a PREVIOUS
 * run's journal" test for the same-network resolver case. This exercises the
 * real Ignition `status()` read path, not a mocked one.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import {
  resolveCrossRefArgs,
  specHasCrossRefArgs,
} from "../src/resolve/crossRef.js";
import { CrossRefError } from "../src/resolve/crossRefErrors.js";
import { loadAddressesFromJournal } from "../src/resolve/journal.js";
import type { DeploymentSpec } from "../src/spec/types.js";
import { deploy } from "../src/deploy/deploy.js";
import {
  makeFakeArtifactResolver,
  makeFakeProvider,
  makeTmpDir,
  rmTmpDir,
  FAKE_ACCOUNTS,
} from "./testHelpers/fakeEip1193Provider.js";

// ---------------------------------------------------------------------------
// specHasCrossRefArgs
// ---------------------------------------------------------------------------

describe("specHasCrossRefArgs", () => {
  it("returns false for a spec with no args at all", () => {
    const spec: DeploymentSpec = { version: 1, contracts: [{ id: "a", contract: "A" }] };
    expect(specHasCrossRefArgs(spec)).toBe(false);
  });

  it("returns false for a spec with only literal/ref/param/expr/resolver args", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "a", contract: "A" },
        {
          id: "b",
          contract: "B",
          args: [
            { kind: "literal", value: "x" },
            { kind: "ref", contract: "a" },
            { kind: "param", name: "p" },
            { kind: "expr", expression: "1n" },
            { kind: "resolver", name: "r" },
          ],
        },
      ],
      parameters: { p: 1 },
    };
    expect(specHasCrossRefArgs(spec)).toBe(false);
  });

  it("returns true when a constructor arg is a crossRef", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "b", contract: "B", args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }] },
      ],
    };
    expect(specHasCrossRefArgs(spec)).toBe(true);
  });

  it("returns true when upgradeable.initializer.args contains a crossRef", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "b",
          contract: "B",
          upgradeable: {
            kind: "uups",
            initializer: {
              function: "initialize",
              args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
            },
          },
        },
      ],
    };
    expect(specHasCrossRefArgs(spec)).toBe(true);
  });

  it("returns true when upgradeable.proxyAdminOwner is a crossRef", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "b",
          contract: "B",
          upgradeable: {
            kind: "transparent",
            proxyAdminOwner: { kind: "crossRef", network: "mainnet", contract: "registry" },
          },
        },
      ],
    };
    expect(specHasCrossRefArgs(spec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCrossRefArgs — fast paths / pass-through
// ---------------------------------------------------------------------------

describe("resolveCrossRefArgs — fast paths", () => {
  it("returns the SAME spec reference when there are no crossRef args", async () => {
    const spec: DeploymentSpec = { version: 1, contracts: [{ id: "a", contract: "A" }] };
    const result = await resolveCrossRefArgs(spec, { journals: {} });
    expect(result).toBe(spec);
  });

  it("leaves entries with no crossRef args untouched (same object reference)", async () => {
    const untouchedEntry = { id: "a", contract: "A" };
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        untouchedEntry,
        {
          id: "b",
          contract: "B",
          args: [{ kind: "crossRef", network: "net1", contract: "x" }],
        },
      ],
    };
    // net1's journal is empty (fresh dir) -> resolution will throw
    // CROSS_REF_NOT_DEPLOYED, but we only care that entry "a" is untouched up
    // to the point of iteration — use a network that DOES resolve instead.
    const tmpDir = makeTmpDir();
    try {
      const provider = makeFakeProvider();
      const seedResult = await deploy({
        spec: { version: 1, contracts: [{ id: "x", contract: "X" }] },
        provider,
        accounts: FAKE_ACCOUNTS,
        deploymentDir: tmpDir,
        artifactResolver: makeFakeArtifactResolver({ X: 0 }),
      });
      expect(seedResult.success).toBe(true);

      const result = await resolveCrossRefArgs(spec, {
        journals: { net1: { deploymentDir: tmpDir } },
      });
      expect(result.contracts[0]).toBe(untouchedEntry);
    } finally {
      rmTmpDir(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveCrossRefArgs — resolves a real address from a fixture journal dir
// ---------------------------------------------------------------------------

describe("resolveCrossRefArgs — resolves against a real journal", () => {
  let sourceDir: string;
  afterEach(() => {
    if (sourceDir) rmTmpDir(sourceDir);
  });

  it("substitutes a crossRef arg with the literal address read from the target network's journal", async () => {
    sourceDir = makeTmpDir();
    const provider = makeFakeProvider();

    const sourceResult = await deploy({
      spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: sourceDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
    });
    expect(sourceResult.success).toBe(true);
    const registryAddress = sourceResult.deployedAddresses["registry"];
    expect(registryAddress).toMatch(/^0x/);

    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
        },
      ],
    };

    const resolved = await resolveCrossRefArgs(spec, {
      journals: { mainnet: { deploymentDir: sourceDir } },
    });

    expect(resolved.contracts[0].args).toEqual([{ kind: "literal", value: registryAddress }]);
  });

  it("resolves a crossRef arg inside upgradeable.initializer.args", async () => {
    sourceDir = makeTmpDir();
    const provider = makeFakeProvider();
    const sourceResult = await deploy({
      spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: sourceDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
    });
    const registryAddress = sourceResult.deployedAddresses["registry"];

    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          upgradeable: {
            kind: "uups",
            initializer: {
              function: "initialize",
              args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
            },
          },
        },
      ],
    };

    const resolved = await resolveCrossRefArgs(spec, {
      journals: { mainnet: { deploymentDir: sourceDir } },
    });

    expect(resolved.contracts[0].upgradeable?.initializer?.args).toEqual([
      { kind: "literal", value: registryAddress },
    ]);
  });

  it("resolves a crossRef arg used as upgradeable.proxyAdminOwner", async () => {
    sourceDir = makeTmpDir();
    const provider = makeFakeProvider();
    const sourceResult = await deploy({
      spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: sourceDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
    });
    const registryAddress = sourceResult.deployedAddresses["registry"];

    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          upgradeable: {
            kind: "transparent",
            proxyAdminOwner: { kind: "crossRef", network: "mainnet", contract: "registry" },
          },
        },
      ],
    };

    const resolved = await resolveCrossRefArgs(spec, {
      journals: { mainnet: { deploymentDir: sourceDir } },
    });

    expect(resolved.contracts[0].upgradeable?.proxyAdminOwner).toEqual({
      kind: "literal",
      value: registryAddress,
    });
  });

  it("caches the journal read across multiple crossRef args on the same network", async () => {
    sourceDir = makeTmpDir();
    const provider = makeFakeProvider();
    const sourceResult = await deploy({
      spec: {
        version: 1,
        contracts: [
          { id: "registry", contract: "Registry" },
          { id: "token", contract: "Token" },
        ],
      },
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: sourceDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0, Token: 0 }),
    });
    expect(sourceResult.success).toBe(true);

    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [
            { kind: "crossRef", network: "mainnet", contract: "registry" },
            { kind: "crossRef", network: "mainnet", contract: "token" },
          ],
        },
      ],
    };

    const resolved = await resolveCrossRefArgs(spec, {
      journals: { mainnet: { deploymentDir: sourceDir } },
    });

    expect(resolved.contracts[0].args).toEqual([
      { kind: "literal", value: sourceResult.deployedAddresses["registry"] },
      { kind: "literal", value: sourceResult.deployedAddresses["token"] },
    ]);
  });

  it("leaves non-crossRef args in the same entry untouched", async () => {
    sourceDir = makeTmpDir();
    const provider = makeFakeProvider();
    const sourceResult = await deploy({
      spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: sourceDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
    });
    const registryAddress = sourceResult.deployedAddresses["registry"];

    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [
            { kind: "literal", value: "unchanged" },
            { kind: "crossRef", network: "mainnet", contract: "registry" },
          ],
        },
      ],
    };

    const resolved = await resolveCrossRefArgs(spec, {
      journals: { mainnet: { deploymentDir: sourceDir } },
    });

    expect(resolved.contracts[0].args).toEqual([
      { kind: "literal", value: "unchanged" },
      { kind: "literal", value: registryAddress },
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveCrossRefArgs — errors
// ---------------------------------------------------------------------------

describe("resolveCrossRefArgs — errors", () => {
  it("throws CrossRefError(CROSS_REF_UNKNOWN_NETWORK) when the network is absent from options.journals", async () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        {
          id: "vault",
          contract: "Vault",
          args: [{ kind: "crossRef", network: "ghostNetwork", contract: "registry" }],
        },
      ],
    };

    await expect(resolveCrossRefArgs(spec, { journals: {} })).rejects.toThrow(CrossRefError);

    try {
      await resolveCrossRefArgs(spec, { journals: {} });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossRefError);
      const crossRefErr = err as CrossRefError;
      expect(crossRefErr.code).toBe("CROSS_REF_UNKNOWN_NETWORK");
      expect(crossRefErr.message).toContain("ghostNetwork");
      expect(crossRefErr.message).toContain('"vault"');
    }
  });

  it("throws CrossRefError(CROSS_REF_NOT_DEPLOYED) when the target network's journal doesn't exist yet", async () => {
    const freshDir = makeTmpDir();
    try {
      const spec: DeploymentSpec = {
        version: 1,
        contracts: [
          {
            id: "vault",
            contract: "Vault",
            args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
          },
        ],
      };

      try {
        await resolveCrossRefArgs(spec, { journals: { mainnet: { deploymentDir: freshDir } } });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CrossRefError);
        expect((err as CrossRefError).code).toBe("CROSS_REF_NOT_DEPLOYED");
        expect((err as CrossRefError).message).toContain("mainnet");
        expect((err as CrossRefError).message).toContain('deploy network "mainnet" first');
      }
    } finally {
      rmTmpDir(freshDir);
    }
  });

  it("throws CrossRefError(CROSS_REF_NOT_DEPLOYED) when the journal exists but lacks the requested contract id", async () => {
    const sourceDir = makeTmpDir();
    try {
      const provider = makeFakeProvider();
      const sourceResult = await deploy({
        spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
        provider,
        accounts: FAKE_ACCOUNTS,
        deploymentDir: sourceDir,
        artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
      });
      expect(sourceResult.success).toBe(true);

      const spec: DeploymentSpec = {
        version: 1,
        contracts: [
          {
            id: "vault",
            contract: "Vault",
            args: [{ kind: "crossRef", network: "mainnet", contract: "neverDeployed" }],
          },
        ],
      };

      try {
        await resolveCrossRefArgs(spec, { journals: { mainnet: { deploymentDir: sourceDir } } });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CrossRefError);
        expect((err as CrossRefError).code).toBe("CROSS_REF_NOT_DEPLOYED");
        expect((err as CrossRefError).message).toContain("neverDeployed");
      }
    } finally {
      rmTmpDir(sourceDir);
    }
  });

  it("respects a custom moduleId when reading the target network's journal", async () => {
    const sourceDir = makeTmpDir();
    try {
      const provider = makeFakeProvider();
      const sourceResult = await deploy({
        spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
        provider,
        accounts: FAKE_ACCOUNTS,
        deploymentDir: sourceDir,
        artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
        moduleId: "SourceModule",
      });
      expect(sourceResult.success).toBe(true);
      const registryAddress = sourceResult.deployedAddresses["registry"];

      const spec: DeploymentSpec = {
        version: 1,
        contracts: [
          {
            id: "vault",
            contract: "Vault",
            args: [{ kind: "crossRef", network: "mainnet", contract: "registry" }],
          },
        ],
      };

      const resolved = await resolveCrossRefArgs(spec, {
        journals: { mainnet: { deploymentDir: sourceDir, moduleId: "SourceModule" } },
      });

      expect(resolved.contracts[0].args).toEqual([{ kind: "literal", value: registryAddress }]);
    } finally {
      rmTmpDir(sourceDir);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveCrossRefArgs — prototype-pollution guard (mirrors resolveSpec.ts's
// guard for the ResolverRegistry lookup)
// ---------------------------------------------------------------------------

describe("resolveCrossRefArgs — prototype-pollution guard", () => {
  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "throws CrossRefError(CROSS_REF_UNKNOWN_NETWORK) for network name %j when absent from an EMPTY journals map",
    async (network) => {
      const spec: DeploymentSpec = {
        version: 1,
        contracts: [{ id: "a", contract: "A", args: [{ kind: "crossRef", network, contract: "x" }] }],
      };
      try {
        await resolveCrossRefArgs(spec, { journals: {} });
        expect.fail(`should have thrown for network ${network}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CrossRefError);
        expect((err as CrossRefError).code).toBe("CROSS_REF_UNKNOWN_NETWORK");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// resolveCrossRefArgs — prototype-pollution guard on the ADDRESS lookup
// (addresses[contract]) — a real fixture journal that does NOT contain a
// prototype-key contract id must still be rejected as CROSS_REF_NOT_DEPLOYED,
// never silently resolving to an inherited Object.prototype member.
// ---------------------------------------------------------------------------

describe("resolveCrossRefArgs — prototype-pollution guard (contract id)", () => {
  let sourceDir: string;

  beforeAll(async () => {
    sourceDir = makeTmpDir();
    const provider = makeFakeProvider();
    const sourceResult = await deploy({
      spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
      provider,
      accounts: FAKE_ACCOUNTS,
      deploymentDir: sourceDir,
      artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
    });
    expect(sourceResult.success).toBe(true);
  });

  afterAll(() => {
    rmTmpDir(sourceDir);
  });

  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "throws CrossRefError(CROSS_REF_NOT_DEPLOYED) for contract id %j when absent from a real journal",
    async (contractId) => {
      const spec: DeploymentSpec = {
        version: 1,
        contracts: [
          {
            id: "vault",
            contract: "Vault",
            args: [{ kind: "crossRef", network: "mainnet", contract: contractId }],
          },
        ],
      };

      try {
        await resolveCrossRefArgs(spec, { journals: { mainnet: { deploymentDir: sourceDir } } });
        expect.fail(`should have thrown for contract id ${contractId}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CrossRefError);
        expect((err as CrossRefError).code).toBe("CROSS_REF_NOT_DEPLOYED");
        expect((err as CrossRefError).message).not.toMatch(/function|\[native code\]/);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// loadAddressesFromJournal (resolve/journal.ts) — the extracted primitive
// ---------------------------------------------------------------------------

describe("loadAddressesFromJournal", () => {
  it("returns an empty object for a directory with no journal.jsonl yet", async () => {
    const freshDir = makeTmpDir();
    try {
      const addresses = await loadAddressesFromJournal(freshDir);
      expect(addresses).toEqual({});
    } finally {
      rmTmpDir(freshDir);
    }
  });

  it("reads deployed addresses keyed by spec entry id (default moduleId)", async () => {
    const dir = makeTmpDir();
    try {
      const provider = makeFakeProvider();
      const result = await deploy({
        spec: {
          version: 1,
          contracts: [
            { id: "registry", contract: "Registry" },
            { id: "token", contract: "Token" },
          ],
        },
        provider,
        accounts: FAKE_ACCOUNTS,
        deploymentDir: dir,
        artifactResolver: makeFakeArtifactResolver({ Registry: 0, Token: 0 }),
      });
      expect(result.success).toBe(true);

      const addresses = await loadAddressesFromJournal(dir);
      expect(addresses).toEqual(result.deployedAddresses);
    } finally {
      rmTmpDir(dir);
    }
  });

  it("reads deployed addresses keyed correctly for a custom moduleId", async () => {
    const dir = makeTmpDir();
    try {
      const provider = makeFakeProvider();
      const result = await deploy({
        spec: { version: 1, contracts: [{ id: "registry", contract: "Registry" }] },
        provider,
        accounts: FAKE_ACCOUNTS,
        deploymentDir: dir,
        artifactResolver: makeFakeArtifactResolver({ Registry: 0 }),
        moduleId: "CustomModule",
      });
      expect(result.success).toBe(true);

      const addresses = await loadAddressesFromJournal(dir, "CustomModule");
      expect(addresses).toEqual({ registry: result.deployedAddresses["registry"] });
    } finally {
      rmTmpDir(dir);
    }
  });
});

/**
 * Tests for the proxy implementation-history data model (issue #155,
 * deploy/proxyHistory.ts).
 *
 * SCOPE: pure, typed helpers only — no chain/provider/journal involved, so
 * these are plain structural/unit tests over in-memory Record<string,string>
 * address books (mirroring the shape of DeployResult.deployedAddresses).
 */

import { describe, it, expect } from "vitest";
import {
  deriveInitialProxyHistory,
  deriveProxyHistoriesFromSpec,
  appendProxyImplementationRecord,
} from "../src/index.js";
import type { DeploymentSpec, ContractEntry, ProxyImplementationHistory } from "../src/index.js";

const IMPL_ADDR = "0x0000000000000000000000000000000000000010";
const PROXY_ADDR = "0x0000000000000000000000000000000000000011";

describe("deriveInitialProxyHistory", () => {
  it("returns undefined for a non-upgradeable entry", () => {
    const entry: ContractEntry = { id: "token", contract: "Token" };
    const result = deriveInitialProxyHistory(entry, { token: "0xabc" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the proxy address is missing from the address book", () => {
    const entry: ContractEntry = {
      id: "vault",
      contract: "Vault",
      upgradeable: { kind: "uups" },
    };
    const result = deriveInitialProxyHistory(entry, { vault_impl: IMPL_ADDR });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the implementation address is missing from the address book", () => {
    const entry: ContractEntry = {
      id: "vault",
      contract: "Vault",
      upgradeable: { kind: "uups" },
    };
    const result = deriveInitialProxyHistory(entry, { vault: PROXY_ADDR });
    expect(result).toBeUndefined();
  });

  it("derives a full history for a valid uups entry with both addresses present", () => {
    const entry: ContractEntry = {
      id: "vault",
      contract: "Vault",
      upgradeable: { kind: "uups" },
    };
    const history = deriveInitialProxyHistory(entry, {
      vault: PROXY_ADDR,
      vault_impl: IMPL_ADDR,
    });
    expect(history).toBeDefined();
    expect(history?.proxyId).toBe("vault");
    expect(history?.kind).toBe("uups");
    expect(history?.proxyAddress).toBe(PROXY_ADDR);
    expect(history?.currentImplementation).toEqual({
      implementationAddress: IMPL_ADDR,
      implementationContract: "Vault",
      setBy: "vault_impl",
    });
    expect(history?.history).toEqual([history?.currentImplementation]);
  });

  it("derives a full history for a transparent entry", () => {
    const entry: ContractEntry = {
      id: "vault",
      contract: "Vault",
      upgradeable: {
        kind: "transparent",
        proxyAdminOwner: { kind: "literal", value: "0x0000000000000000000000000000000000000002" },
      },
    };
    const history = deriveInitialProxyHistory(entry, {
      vault: PROXY_ADDR,
      vault_impl: IMPL_ADDR,
    });
    expect(history?.kind).toBe("transparent");
  });
});

describe("deriveProxyHistoriesFromSpec", () => {
  it("returns an empty array for a spec with no upgradeable entries", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "token", contract: "Token" }],
    };
    const histories = deriveProxyHistoriesFromSpec(spec, { token: "0xabc" });
    expect(histories).toEqual([]);
  });

  it("derives a history entry per upgradeable contract, skipping non-upgradeable ones", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [
        { id: "token", contract: "Token" },
        { id: "vaultA", contract: "Vault", upgradeable: { kind: "uups" } },
        { id: "vaultB", contract: "Vault", upgradeable: { kind: "uups" } },
      ],
    };
    const addresses = {
      token: "0xabc",
      vaultA: "0x0000000000000000000000000000000000000021",
      vaultA_impl: "0x0000000000000000000000000000000000000022",
      vaultB: "0x0000000000000000000000000000000000000031",
      vaultB_impl: "0x0000000000000000000000000000000000000032",
    };
    const histories = deriveProxyHistoriesFromSpec(spec, addresses);
    expect(histories).toHaveLength(2);
    expect(histories.map((h) => h.proxyId).sort()).toEqual(["vaultA", "vaultB"]);
  });

  it("skips an upgradeable entry missing from a partial/failed-deploy address book", () => {
    const spec: DeploymentSpec = {
      version: 1,
      contracts: [{ id: "vault", contract: "Vault", upgradeable: { kind: "uups" } }],
    };
    const histories = deriveProxyHistoriesFromSpec(spec, {});
    expect(histories).toEqual([]);
  });
});

describe("appendProxyImplementationRecord", () => {
  it("returns a NEW object, never mutating the input", () => {
    const original: ProxyImplementationHistory = {
      proxyId: "vault",
      kind: "uups",
      proxyAddress: PROXY_ADDR,
      currentImplementation: {
        implementationAddress: IMPL_ADDR,
        implementationContract: "Vault",
        setBy: "vault_impl",
      },
      history: [
        {
          implementationAddress: IMPL_ADDR,
          implementationContract: "Vault",
          setBy: "vault_impl",
        },
      ],
    };
    const frozen = JSON.parse(JSON.stringify(original));

    const upgraded = appendProxyImplementationRecord(original, {
      implementationAddress: "0x0000000000000000000000000000000000000099",
      implementationContract: "VaultV2",
      setBy: "vault_impl_v2Upgrade",
    });

    // Original is untouched.
    expect(original).toEqual(frozen);
    // The new object reflects the upgrade.
    expect(upgraded).not.toBe(original);
    expect(upgraded.currentImplementation.implementationContract).toBe("VaultV2");
    expect(upgraded.history).toHaveLength(2);
    expect(upgraded.history[0]).toEqual(original.currentImplementation);
    expect(upgraded.history[1]).toEqual(upgraded.currentImplementation);
    // proxyId/kind/proxyAddress carry over unchanged.
    expect(upgraded.proxyId).toBe(original.proxyId);
    expect(upgraded.kind).toBe(original.kind);
    expect(upgraded.proxyAddress).toBe(original.proxyAddress);
  });

  it("supports chaining multiple upgrades", () => {
    let history: ProxyImplementationHistory = {
      proxyId: "vault",
      kind: "uups",
      proxyAddress: PROXY_ADDR,
      currentImplementation: {
        implementationAddress: "0x01",
        implementationContract: "VaultV1",
        setBy: "vault_impl",
      },
      history: [{ implementationAddress: "0x01", implementationContract: "VaultV1", setBy: "vault_impl" }],
    };

    history = appendProxyImplementationRecord(history, {
      implementationAddress: "0x02",
      implementationContract: "VaultV2",
      setBy: "vault_impl_v2Upgrade",
    });
    history = appendProxyImplementationRecord(history, {
      implementationAddress: "0x03",
      implementationContract: "VaultV3",
      setBy: "vault_impl_v3Upgrade",
    });

    expect(history.history.map((r) => r.implementationContract)).toEqual([
      "VaultV1",
      "VaultV2",
      "VaultV3",
    ]);
    expect(history.currentImplementation.implementationContract).toBe("VaultV3");
  });
});

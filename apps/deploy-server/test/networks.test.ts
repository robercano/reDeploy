/**
 * Tests for src/networks.ts: the server-side network registry.
 *
 * Covers:
 *   - Backward-compat default network synthesized from legacy env vars.
 *   - Loading additional named networks from a NETWORKS_CONFIG JSON file.
 *   - Schema validation (NetworksConfigError on malformed config).
 *   - deployerPrivateKeyEnv indirection (secret stays out of the JSON file).
 *   - defaultNetwork selection (file-level, then DEFAULT_NETWORK env override).
 *   - resolveNetwork(): default fallback, known name, unknown name.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadNetworksRegistry,
  resolveNetwork,
  listNetworks,
  NetworksConfigError,
  DEFAULT_NETWORK_NAME,
  DEFAULT_MODULE_ID,
} from "../src/networks.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function writeConfigFile(content: unknown): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-networks-test-"));
  const configPath = path.join(tmpDir, "networks.json");
  fs.writeFileSync(configPath, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return configPath;
}

function baseEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...overrides };
  return env;
}

// ---------------------------------------------------------------------------
// DEFAULT_NETWORK_NAME / DEFAULT_MODULE_ID constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_NETWORK_NAME is 'default'", () => {
    expect(DEFAULT_NETWORK_NAME).toBe("default");
  });

  it("DEFAULT_MODULE_ID is 'Deployment'", () => {
    expect(DEFAULT_MODULE_ID).toBe("Deployment");
  });
});

// ---------------------------------------------------------------------------
// loadNetworksRegistry — backward-compat legacy default network
// ---------------------------------------------------------------------------

describe("loadNetworksRegistry — legacy default network (no NETWORKS_CONFIG)", () => {
  it("synthesizes a 'default' network with the built-in RPC_URL fallback when no env vars are set", () => {
    const registry = loadNetworksRegistry({ env: baseEnv() });

    expect(registry.defaultNetworkName).toBe("default");
    expect(registry.networks.size).toBe(1);

    const def = registry.networks.get("default");
    expect(def).toBeDefined();
    expect(def?.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(def?.deployerPrivateKey).toBeUndefined();
    expect(def?.deploymentDir).toBe(path.join(os.tmpdir(), "redeploy-deployments", "default"));
  });

  it("uses RPC_URL / DEPLOYER_PRIVATE_KEY / DEPLOYMENT_DIR when set", () => {
    const registry = loadNetworksRegistry({
      env: baseEnv({
        RPC_URL: "http://custom-rpc.example.com",
        DEPLOYER_PRIVATE_KEY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        DEPLOYMENT_DIR: "/tmp/some-custom-dir",
      }),
    });

    const def = registry.networks.get("default");
    expect(def?.rpcUrl).toBe("http://custom-rpc.example.com");
    expect(def?.deployerPrivateKey).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(def?.deploymentDir).toBe("/tmp/some-custom-dir");
  });

  it("treats an empty-string DEPLOYER_PRIVATE_KEY as unset", () => {
    const registry = loadNetworksRegistry({ env: baseEnv({ DEPLOYER_PRIVATE_KEY: "" }) });
    expect(registry.networks.get("default")?.deployerPrivateKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadNetworksRegistry — NETWORKS_CONFIG file
// ---------------------------------------------------------------------------

describe("loadNetworksRegistry — NETWORKS_CONFIG file", () => {
  it("merges additional named networks from the config file with the legacy default", () => {
    const configPath = writeConfigFile({
      networks: {
        local: { rpcUrl: "http://127.0.0.1:9545" },
        sepolia: {
          rpcUrl: "https://sepolia.example.com/v3/KEY",
          chainId: 11155111,
          deployerPrivateKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          moduleId: "Deployment",
          deploymentParameters: { someParam: 123 },
        },
      },
    });

    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });

    expect(registry.networks.size).toBe(3); // default + local + sepolia
    expect(registry.defaultNetworkName).toBe("default");

    const local = registry.networks.get("local");
    expect(local?.rpcUrl).toBe("http://127.0.0.1:9545");
    expect(local?.deploymentDir).toBe(path.join(os.tmpdir(), "redeploy-deployments", "local"));

    const sepolia = registry.networks.get("sepolia");
    expect(sepolia?.rpcUrl).toBe("https://sepolia.example.com/v3/KEY");
    expect(sepolia?.chainId).toBe(11155111);
    expect(sepolia?.deployerPrivateKey).toBe(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(sepolia?.moduleId).toBe("Deployment");
    expect(sepolia?.deploymentParameters).toEqual({ someParam: 123 });
  });

  it("a network literally named 'default' in the config file overrides the synthesized legacy default", () => {
    const configPath = writeConfigFile({
      networks: {
        default: { rpcUrl: "http://overridden.example.com" },
      },
    });

    const registry = loadNetworksRegistry({
      env: baseEnv({ NETWORKS_CONFIG: configPath, RPC_URL: "http://should-be-shadowed.example.com" }),
    });

    expect(registry.networks.size).toBe(1);
    expect(registry.networks.get("default")?.rpcUrl).toBe("http://overridden.example.com");
  });

  it("honors an explicit deploymentDir over the derived default", () => {
    const configPath = writeConfigFile({
      networks: {
        custom: { rpcUrl: "http://127.0.0.1:8545", deploymentDir: "/var/redeploy/custom-dir" },
      },
    });

    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });
    expect(registry.networks.get("custom")?.deploymentDir).toBe("/var/redeploy/custom-dir");
  });

  it("honors a top-level 'defaultNetwork' field", () => {
    const configPath = writeConfigFile({
      defaultNetwork: "sepolia",
      networks: {
        sepolia: { rpcUrl: "https://sepolia.example.com" },
      },
    });

    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });
    expect(registry.defaultNetworkName).toBe("sepolia");
  });

  it("DEFAULT_NETWORK env var overrides the file's 'defaultNetwork' field", () => {
    const configPath = writeConfigFile({
      defaultNetwork: "sepolia",
      networks: {
        sepolia: { rpcUrl: "https://sepolia.example.com" },
        mainnet: { rpcUrl: "https://mainnet.example.com" },
      },
    });

    const registry = loadNetworksRegistry({
      env: baseEnv({ NETWORKS_CONFIG: configPath, DEFAULT_NETWORK: "mainnet" }),
    });
    expect(registry.defaultNetworkName).toBe("mainnet");
  });

  it("resolves deployerPrivateKeyEnv indirection from the environment, never storing the literal in the file", () => {
    const configPath = writeConfigFile({
      networks: {
        sepolia: {
          rpcUrl: "https://sepolia.example.com",
          deployerPrivateKeyEnv: "SEPOLIA_TEST_KEY",
        },
      },
    });

    const registry = loadNetworksRegistry({
      env: baseEnv({
        NETWORKS_CONFIG: configPath,
        SEPOLIA_TEST_KEY: "0xccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }),
    });

    expect(registry.networks.get("sepolia")?.deployerPrivateKey).toBe(
      "0xccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
  });

  it("deployerPrivateKeyEnv wins over a literal deployerPrivateKey when both are present", () => {
    const configPath = writeConfigFile({
      networks: {
        sepolia: {
          rpcUrl: "https://sepolia.example.com",
          deployerPrivateKey: "0xLITERAL",
          deployerPrivateKeyEnv: "SEPOLIA_TEST_KEY",
        },
      },
    });

    const registry = loadNetworksRegistry({
      env: baseEnv({ NETWORKS_CONFIG: configPath, SEPOLIA_TEST_KEY: "0xFROM_ENV" }),
    });

    expect(registry.networks.get("sepolia")?.deployerPrivateKey).toBe("0xFROM_ENV");
  });

  it("a blank NETWORKS_CONFIG value is treated as unset (legacy default only)", () => {
    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: "   " }) });
    expect(registry.networks.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadNetworksRegistry — schema validation errors
// ---------------------------------------------------------------------------

describe("loadNetworksRegistry — NETWORKS_CONFIG schema errors", () => {
  it("throws NetworksConfigError when the file does not exist", () => {
    const missingPath = path.join(os.tmpdir(), "redeploy-networks-test-missing", `nope-${Date.now()}.json`);
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: missingPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for invalid JSON", () => {
    const configPath = writeConfigFile("{ not valid json");
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when the top-level value is not an object", () => {
    const configPath = writeConfigFile([1, 2, 3]);
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when 'networks' is missing", () => {
    const configPath = writeConfigFile({});
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when 'networks' is not an object", () => {
    const configPath = writeConfigFile({ networks: "nope" });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for an invalid network name (disallowed characters)", () => {
    const configPath = writeConfigFile({ networks: { "bad name!": { rpcUrl: "http://x" } } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when a network entry is not an object", () => {
    const configPath = writeConfigFile({ networks: { local: "nope" } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when rpcUrl is missing", () => {
    const configPath = writeConfigFile({ networks: { local: {} } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when rpcUrl is blank", () => {
    const configPath = writeConfigFile({ networks: { local: { rpcUrl: "   " } } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a non-numeric chainId", () => {
    const configPath = writeConfigFile({ networks: { local: { rpcUrl: "http://x", chainId: "1" } } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a non-string deploymentDir", () => {
    const configPath = writeConfigFile({ networks: { local: { rpcUrl: "http://x", deploymentDir: 123 } } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a non-string moduleId", () => {
    const configPath = writeConfigFile({ networks: { local: { rpcUrl: "http://x", moduleId: 123 } } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a non-object deploymentParameters", () => {
    const configPath = writeConfigFile({
      networks: { local: { rpcUrl: "http://x", deploymentParameters: "nope" } },
    });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a blank deployerPrivateKeyEnv", () => {
    const configPath = writeConfigFile({
      networks: { local: { rpcUrl: "http://x", deployerPrivateKeyEnv: "  " } },
    });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a non-string deployerPrivateKey", () => {
    const configPath = writeConfigFile({
      networks: { local: { rpcUrl: "http://x", deployerPrivateKey: 123 } },
    });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError for a blank top-level 'defaultNetwork'", () => {
    const configPath = writeConfigFile({ defaultNetwork: "  ", networks: { local: { rpcUrl: "http://x" } } });
    expect(() => loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) })).toThrow(
      NetworksConfigError,
    );
  });

  it("throws NetworksConfigError when the resolved default network name is not in the registry", () => {
    const configPath = writeConfigFile({ networks: { local: { rpcUrl: "http://x" } } });
    expect(() =>
      loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath, DEFAULT_NETWORK: "nonexistent" }) }),
    ).toThrow(NetworksConfigError);
  });

  it("the thrown error is an instance of Error with name 'NetworksConfigError'", () => {
    const configPath = writeConfigFile("not json");
    try {
      loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });
      expect.fail("expected loadNetworksRegistry to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworksConfigError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("NetworksConfigError");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveNetwork
// ---------------------------------------------------------------------------

describe("resolveNetwork", () => {
  it("resolves to the default network when requestedName is undefined", () => {
    const registry = loadNetworksRegistry({ env: baseEnv() });
    const resolution = resolveNetwork(registry, undefined);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.name).toBe("default");
    }
  });

  it("resolves to the default network when requestedName is an empty string", () => {
    const registry = loadNetworksRegistry({ env: baseEnv() });
    const resolution = resolveNetwork(registry, "");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.name).toBe("default");
    }
  });

  it("resolves a known network name to its config", () => {
    const configPath = writeConfigFile({ networks: { sepolia: { rpcUrl: "https://sepolia.example.com" } } });
    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });

    const resolution = resolveNetwork(registry, "sepolia");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.name).toBe("sepolia");
      expect(resolution.config.rpcUrl).toBe("https://sepolia.example.com");
    }
  });

  it("returns ok:false for an unknown network name", () => {
    const registry = loadNetworksRegistry({ env: baseEnv() });
    const resolution = resolveNetwork(registry, "nonexistent");
    expect(resolution.ok).toBe(false);
  });

  it("returns ok:false for prototype-pollution-style lookup keys (e.g. '__proto__')", () => {
    const registry = loadNetworksRegistry({ env: baseEnv() });
    const resolution = resolveNetwork(registry, "__proto__");
    expect(resolution.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listNetworks
// ---------------------------------------------------------------------------

describe("listNetworks", () => {
  it("lists the legacy 'default' network with no chainId when no NETWORKS_CONFIG is set", () => {
    const registry = loadNetworksRegistry({ env: baseEnv() });
    const listing = listNetworks(registry);

    expect(listing.defaultNetwork).toBe("default");
    expect(listing.networks).toEqual([{ name: "default" }]);
  });

  it("lists every configured network by name, including chainId when set", () => {
    const configPath = writeConfigFile({
      networks: {
        local: { rpcUrl: "http://127.0.0.1:9545" },
        sepolia: {
          rpcUrl: "https://sepolia.example.com/v3/KEY",
          chainId: 11155111,
          deployerPrivateKey: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      },
    });

    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });
    const listing = listNetworks(registry);

    expect(listing.networks).toHaveLength(3); // default + local + sepolia
    expect(listing.networks).toContainEqual({ name: "default" });
    expect(listing.networks).toContainEqual({ name: "local" });
    expect(listing.networks).toContainEqual({ name: "sepolia", chainId: 11155111 });
  });

  it("reflects a configured defaultNetwork", () => {
    const configPath = writeConfigFile({
      defaultNetwork: "sepolia",
      networks: { sepolia: { rpcUrl: "https://sepolia.example.com" } },
    });

    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });
    const listing = listNetworks(registry);

    expect(listing.defaultNetwork).toBe("sepolia");
  });

  it("never includes secret/path fields (rpcUrl, deployerPrivateKey, deploymentDir, deploymentParameters, moduleId)", () => {
    const configPath = writeConfigFile({
      networks: {
        sepolia: {
          rpcUrl: "https://sepolia.example.com/v3/SECRET_API_KEY",
          chainId: 11155111,
          deployerPrivateKey: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          deploymentDir: "/var/redeploy/secret-path",
          moduleId: "Deployment",
          deploymentParameters: { secretParam: "shh" },
        },
      },
    });

    const registry = loadNetworksRegistry({ env: baseEnv({ NETWORKS_CONFIG: configPath }) });
    const listing = listNetworks(registry);
    const serialized = JSON.stringify(listing);

    expect(serialized).not.toContain("SECRET_API_KEY");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("secret-path");
    expect(serialized).not.toContain("secretParam");
    expect(serialized).not.toContain("shh");

    const sepolia = listing.networks.find((n) => n.name === "sepolia");
    expect(sepolia).toEqual({ name: "sepolia", chainId: 11155111 });
    expect(Object.keys(sepolia as object).sort()).toEqual(["chainId", "name"]);
  });
});

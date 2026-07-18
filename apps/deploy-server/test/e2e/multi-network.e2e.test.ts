/**
 * E2E scenario — multi-network deploys end-to-end, real chains (issue #139).
 *
 * This is the capstone proof for #139: the deploy-server's `?network=`
 * wiring (server.ts's `handleDeploy` + networks.ts's registry) actually
 * deploys to TWO INDEPENDENT real chains, and — critically — proves the
 * PRECEDENCE a client can rely on: a network's server-side
 * `deploymentParameters` OVERRIDE any value the request body's
 * `spec.parameters` carries for the same name, exactly mirroring what the
 * studio bakes in as `networkOverrides` (client-side per-network overrides
 * are emitted as `spec.parameters` DEFAULTS at spec-generation time — see
 * server.ts's handleDeploy doc block and networks.ts's module doc for the
 * full precedence writeup).
 *
 * Unlike test/deploy.test.ts (which mocks @redeploy/core and @redeploy/reader
 * entirely), this suite runs the REAL HTTP server (`createServer()`) against
 * TWO REAL local Anvil chains and REAL Foundry-compiled bytecode — no mocks.
 *
 * SCENARIO
 * ========
 *   1. Start two independent Anvil chains (A, B) and two independent
 *      deploymentDirs (journals).
 *   2. Configure a NETWORKS_CONFIG with "alpha" (-> chain A) and "beta"
 *      (-> chain B), each with a DIFFERENT server-side `deploymentParameters
 *      .admin` override, and start the real deploy-server.
 *   3. POST the SAME bare DeploymentSpec — whose `spec.parameters.admin`
 *      simulates a studio-baked `networkOverrides` DEFAULT — to
 *      `/api/deploy?network=alpha`, then `?network=beta`.
 *   4. Read Registry's `hasRole(DEFAULT_ADMIN_ROLE, ...)` on-chain on both
 *      chains: the SERVER's deploymentParameters admin holds the role; the
 *      spec's baked-in default does NOT — proving server config wins.
 *   5. Prove per-network journal isolation: both deploymentDirs end up with
 *      non-empty, DISTINCT journals, and re-POSTing to `alpha` RESUMES
 *      (same registry address) rather than re-deploying — without touching
 *      beta's journal or chain.
 *
 * REQUIRES the `anvil` binary and the Foundry fixtures under contracts/out
 * (see ./anvilHarness.ts and test/e2e/README.md). If either is missing, this
 * whole suite is skipped with a console warning — never silently treated as
 * passing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server, request as httpRequest } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http as viemHttp, type Hex } from "viem";
import { createServer } from "../../src/server.js";
import type { DeploymentView } from "@redeploy/reader";
import { isAnvilAvailable, startAnvil, type AnvilInstance } from "./anvilHarness.js";

// ---------------------------------------------------------------------------
// Fixture resolution — mirrors packages/core/test/e2e/fixtures.ts's approach,
// but reimplemented here (test code cannot import across package test/ dirs).
// ---------------------------------------------------------------------------

// apps/deploy-server/test/e2e/multi-network.e2e.test.ts -> apps/deploy-server -> <repo>/contracts/out
const TEST_E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(TEST_E2E_DIR, "../..");
const FOUNDRY_OUT = process.env["FOUNDRY_OUT"] ?? resolve(PACKAGE_DIR, "../../contracts/out");

/** True iff the Foundry fixtures have been built (`forge build` in contracts/). */
function areFixturesBuilt(): boolean {
  return existsSync(resolve(FOUNDRY_OUT, "Registry.sol", "Registry.json"));
}

/** Reads Registry's ABI directly from the Foundry-built artifact JSON. */
function loadRegistryAbi(): readonly unknown[] {
  const artifactPath = resolve(FOUNDRY_OUT, "Registry.sol", "Registry.json");
  const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: readonly unknown[] };
  return parsed.abi;
}

const ANVIL_READY = isAnvilAvailable();
const FIXTURES_READY = areFixturesBuilt();

if (!ANVIL_READY) {
  console.warn(
    "[e2e] Skipping multi-network.e2e.test.ts — `anvil` binary not found on PATH. " +
      "Install Foundry (https://getfoundry.sh) to run these tests. See test/e2e/README.md.",
  );
}
if (ANVIL_READY && !FIXTURES_READY) {
  console.warn(
    "[e2e] Skipping multi-network.e2e.test.ts — contracts/out fixtures are not built. " +
      "Run `forge build` in contracts/. See test/e2e/README.md.",
  );
}

// ---------------------------------------------------------------------------
// Minimal real-HTTP + SSE helpers (re-implemented, not imported, from
// test/deploy.test.ts's patterns — see that file's doRequest/parseSse).
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function doRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const contentHeaders =
      body !== undefined
        ? {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
          }
        : {};

    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: contentHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

interface SseEvent {
  event: string;
  data: unknown;
}

function parseSse(body: string): SseEvent[] {
  const messages = body.split("\n\n").filter((m) => m.trim().length > 0);
  return messages.map((msg) => {
    const lines = msg.split("\n");
    let event = "";
    let dataRaw = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) dataRaw = line.slice("data: ".length);
    }
    return { event, data: JSON.parse(dataRaw) };
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!ANVIL_READY || !FIXTURES_READY)(
  "e2e: multi-network deploys end-to-end — real two-Anvil precedence + isolation proof (issue #139)",
  () => {
    let anvilA: AnvilInstance;
    let anvilB: AnvilInstance;
    let dirAlpha: string;
    let dirBeta: string;
    let configDir: string;
    let networksConfigPath: string;
    let server: Server;
    let port: number;
    let registryAbi: readonly unknown[];

    let addrSpecDefault: string;
    let addrAlphaServer: string;
    let addrBetaServer: string;

    let savedNetworksConfig: string | undefined;
    let savedFoundryOut: string | undefined;

    beforeAll(async () => {
      [anvilA, anvilB] = await Promise.all([startAnvil(), startAnvil()]);

      dirAlpha = mkdtempSync(join(tmpdir(), "redeploy-e2e-multinet-alpha-"));
      dirBeta = mkdtempSync(join(tmpdir(), "redeploy-e2e-multinet-beta-"));

      // Three distinct Anvil dev accounts (deterministic, identical across
      // instances): [1] simulates the studio-baked spec.parameters default,
      // [2]/[3] are the server-side per-network overrides for alpha/beta.
      addrSpecDefault = anvilA.accounts[1]!.address;
      addrAlphaServer = anvilA.accounts[2]!.address;
      addrBetaServer = anvilA.accounts[3]!.address;
      expect(new Set([addrSpecDefault, addrAlphaServer, addrBetaServer]).size).toBe(3);

      const networksConfig = {
        networks: {
          alpha: {
            rpcUrl: anvilA.rpcUrl,
            deployerPrivateKey: anvilA.accounts[0]!.privateKey,
            deploymentDir: dirAlpha,
            deploymentParameters: { admin: addrAlphaServer },
          },
          beta: {
            rpcUrl: anvilB.rpcUrl,
            deployerPrivateKey: anvilB.accounts[0]!.privateKey,
            deploymentDir: dirBeta,
            deploymentParameters: { admin: addrBetaServer },
          },
        },
      };

      configDir = mkdtempSync(join(tmpdir(), "redeploy-e2e-multinet-config-"));
      networksConfigPath = join(configDir, "networks.json");
      writeFileSync(networksConfigPath, JSON.stringify(networksConfig), "utf8");

      savedNetworksConfig = process.env["NETWORKS_CONFIG"];
      savedFoundryOut = process.env["FOUNDRY_OUT"];
      process.env["NETWORKS_CONFIG"] = networksConfigPath;
      process.env["FOUNDRY_OUT"] = FOUNDRY_OUT;

      registryAbi = loadRegistryAbi();

      server = createServer();
      await new Promise<void>((resolvePromise) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          port = typeof addr === "object" && addr !== null ? addr.port : 0;
          resolvePromise();
        });
      });
    }, 60_000);

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolvePromise, reject) => {
          server.close((err) => (err ? reject(err) : resolvePromise()));
        });
      }
      await Promise.all([anvilA?.stop(), anvilB?.stop()]);
      if (dirAlpha) rmSync(dirAlpha, { recursive: true, force: true });
      if (dirBeta) rmSync(dirBeta, { recursive: true, force: true });
      if (configDir) rmSync(configDir, { recursive: true, force: true });

      if (savedNetworksConfig === undefined) delete process.env["NETWORKS_CONFIG"];
      else process.env["NETWORKS_CONFIG"] = savedNetworksConfig;
      if (savedFoundryOut === undefined) delete process.env["FOUNDRY_OUT"];
      else process.env["FOUNDRY_OUT"] = savedFoundryOut;
    }, 30_000);

    /** Bare DeploymentSpec whose `parameters.admin` simulates a studio-baked networkOverrides default. */
    function buildSpec(): Record<string, unknown> {
      return {
        version: 1,
        parameters: { admin: addrSpecDefault },
        contracts: [{ id: "registry", contract: "Registry", args: [{ kind: "param", name: "admin" }] }],
      };
    }

    /** POSTs a deploy for `networkName`, parses the SSE stream, and returns the terminal `done` payload. */
    async function postDeploy(
      networkName: string,
      spec: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const res = await doRequest(port, "POST", `/api/deploy?network=${networkName}`, JSON.stringify(spec));
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      const events = parseSse(res.body);
      const doneEvent = events.find((e) => e.event === "done");
      expect(doneEvent, `expected a terminal 'done' SSE event for network ${networkName}`).toBeDefined();
      return doneEvent!.data as Record<string, unknown>;
    }

    /** GETs the current DeploymentView for `networkName` via the network-aware read endpoint. */
    async function getDeployment(networkName: string): Promise<DeploymentView> {
      const res = await doRequest(port, "GET", `/api/deployment?network=${networkName}`);
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as DeploymentView;
    }

    function findAddress(view: DeploymentView, id: string): string | null {
      return view.contracts.find((c) => c.id === id)?.address ?? null;
    }

    it(
      "deploys independently to two real Anvil chains, server deploymentParameters win over the client-baked spec default, and per-network resume is idempotent + isolated",
      async () => {
        const spec = buildSpec();

        // --- Deploy to alpha -----------------------------------------------
        const alphaDone = await postDeploy("alpha", spec);
        expect(alphaDone["success"]).toBe(true);

        const alphaView = await getDeployment("alpha");
        const alphaRegistry = findAddress(alphaView, "registry");
        expect(alphaRegistry).toBeTruthy();

        const clientA = createPublicClient({ transport: viemHttp(anvilA.rpcUrl) });
        const defaultAdminRole = await clientA.readContract({
          address: alphaRegistry as Hex,
          abi: registryAbi,
          functionName: "DEFAULT_ADMIN_ROLE",
        });

        const alphaServerHasRole = await clientA.readContract({
          address: alphaRegistry as Hex,
          abi: registryAbi,
          functionName: "hasRole",
          args: [defaultAdminRole, addrAlphaServer as Hex],
        });
        const alphaSpecDefaultHasRole = await clientA.readContract({
          address: alphaRegistry as Hex,
          abi: registryAbi,
          functionName: "hasRole",
          args: [defaultAdminRole, addrSpecDefault as Hex],
        });

        // PRECEDENCE: server-side deploymentParameters WON over the
        // client-baked spec.parameters default.
        expect(alphaServerHasRole).toBe(true);
        expect(alphaSpecDefaultHasRole).toBe(false);

        // --- Deploy the SAME spec to beta -----------------------------------
        const betaDone = await postDeploy("beta", spec);
        expect(betaDone["success"]).toBe(true);

        const betaView = await getDeployment("beta");
        const betaRegistry = findAddress(betaView, "registry");
        expect(betaRegistry).toBeTruthy();

        const clientB = createPublicClient({ transport: viemHttp(anvilB.rpcUrl) });

        const betaServerHasRole = await clientB.readContract({
          address: betaRegistry as Hex,
          abi: registryAbi,
          functionName: "hasRole",
          args: [defaultAdminRole, addrBetaServer as Hex],
        });
        const betaSpecDefaultHasRole = await clientB.readContract({
          address: betaRegistry as Hex,
          abi: registryAbi,
          functionName: "hasRole",
          args: [defaultAdminRole, addrSpecDefault as Hex],
        });

        expect(betaServerHasRole).toBe(true);
        expect(betaSpecDefaultHasRole).toBe(false);

        // Independent chains: beta's registry has real bytecode on chain B
        // (not merely an address computed the same way as alpha's).
        const betaCode = await clientB.getCode({ address: betaRegistry as Hex });
        expect(betaCode).toBeDefined();
        expect((betaCode as string).length).toBeGreaterThan(2); // more than just "0x"
        const alphaCode = await clientA.getCode({ address: alphaRegistry as Hex });
        expect(alphaCode).toBeDefined();
        expect((alphaCode as string).length).toBeGreaterThan(2);

        // --- Independent, non-empty journals ---------------------------------
        const journalAlphaPath = join(dirAlpha, "journal.jsonl");
        const journalBetaPath = join(dirBeta, "journal.jsonl");
        expect(existsSync(journalAlphaPath)).toBe(true);
        expect(existsSync(journalBetaPath)).toBe(true);
        expect(readFileSync(journalAlphaPath, "utf8").trim().length).toBeGreaterThan(0);
        expect(readFileSync(journalBetaPath, "utf8").trim().length).toBeGreaterThan(0);
        expect(dirAlpha).not.toBe(dirBeta);

        // --- Re-deploy to alpha: RESUMES (same address), never touches beta --
        const alphaResumeDone = await postDeploy("alpha", spec);
        expect(alphaResumeDone["success"]).toBe(true);

        const alphaResumeView = await getDeployment("alpha");
        const alphaResumeRegistry = findAddress(alphaResumeView, "registry");
        expect(alphaResumeRegistry).toBe(alphaRegistry);

        // beta's deployment is unaffected by the alpha resume.
        const betaAfterResumeView = await getDeployment("beta");
        expect(findAddress(betaAfterResumeView, "registry")).toBe(betaRegistry);
      },
      120_000,
    );
  },
);

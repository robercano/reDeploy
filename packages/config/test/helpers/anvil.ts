/**
 * TEST-ONLY Anvil harness for @redeploy/config's end-to-end suite.
 *
 * IMPORTANT — SCOPE
 * ==================
 * Issue #97 (this suite) originally depended on a *shared* Anvil harness to be
 * delivered by issue #96 (module:core). At the time this suite was written,
 * #96 had not landed anywhere importable from @redeploy/config, and per the
 * module-boundary rules this package cannot reach into `packages/core/test`
 * (or any other module) to borrow one.
 *
 * This file is therefore a small, CONFIG-LOCAL, TEST-ONLY harness that lives
 * entirely under `packages/config/test/`. It is intentionally minimal (spawn
 * Anvil, wait for RPC readiness, expose a funded dev key, tear down) and is
 * NOT meant to be reused outside this package. If/when issue #96 ships a
 * shared harness, this file should be deleted in favour of it.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as net from "node:net";

// ---------------------------------------------------------------------------
// Well-known Anvil deterministic dev accounts
// ---------------------------------------------------------------------------

/**
 * Anvil's default deterministic account #0 — private key.
 * This is a PUBLIC, well-known test-only key (the same one Anvil prints on
 * every startup banner). It is never used against a real network.
 */
export const ANVIL_DEV_PRIVATE_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Address corresponding to {@link ANVIL_DEV_PRIVATE_KEY_0}. */
export const ANVIL_DEV_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

/**
 * Anvil's default deterministic account #1 — private key.
 * Also a PUBLIC, well-known test-only key. Used in tests as a secondary
 * account (e.g. the recipient of a granted role) distinct from the deployer.
 */
export const ANVIL_DEV_PRIVATE_KEY_1 =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/** Address corresponding to {@link ANVIL_DEV_PRIVATE_KEY_1}. */
export const ANVIL_DEV_ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

// ---------------------------------------------------------------------------
// Foundry availability check
// ---------------------------------------------------------------------------

/**
 * Returns true iff both `anvil` and `forge` binaries are runnable on PATH.
 *
 * Used to skip the e2e suite cleanly (`describe.skipIf`) on machines without
 * Foundry installed, rather than hard-failing the whole test run.
 */
export function isFoundryAvailable(): boolean {
  try {
    const anvil = spawnSync("anvil", ["--version"], { stdio: "ignore" });
    const forge = spawnSync("forge", ["--version"], { stdio: "ignore" });
    return anvil.status === 0 && forge.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Anvil process lifecycle
// ---------------------------------------------------------------------------

export interface AnvilInstance {
  /** HTTP JSON-RPC URL of the running Anvil instance. */
  readonly rpcUrl: string;
  /** The ephemeral TCP port Anvil was started on. */
  readonly port: number;
  /** Terminate the Anvil subprocess and wait for it to exit. */
  stop(): Promise<void>;
}

/** Ask the OS for a free ephemeral TCP port by binding to port 0. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address !== null && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("failed to allocate a free ephemeral port")));
      }
    });
  });
}

/** Poll `rpcUrl` with `eth_chainId` until it responds or `timeoutMs` elapses. */
async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: unknown };
        if (body && body.result !== undefined) {
          return;
        }
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  throw new Error(
    `Anvil did not become ready at ${rpcUrl} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}

/**
 * Spawn a fresh, isolated Anvil instance on an ephemeral local port and wait
 * until its JSON-RPC endpoint is responsive.
 *
 * Each call starts an independent chain (own genesis, own deterministic
 * accounts) so tests never interfere with one another.
 */
export async function startAnvil(): Promise<AnvilInstance> {
  const port = await getFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(
    "anvil",
    ["--port", String(port), "--host", "127.0.0.1", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  // Race readiness against an early, unexpected exit so a failed spawn does
  // not hang the test suite for the full readiness timeout.
  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once("exit", (code) => {
      reject(new Error(`anvil exited early (code ${String(code)}): ${stderrBuf}`));
    });
    child.once("error", (err) => reject(err));
  });

  try {
    await Promise.race([waitForRpcReady(rpcUrl, 15_000), earlyExit]);
  } catch (err) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  return {
    rpcUrl,
    port,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      await new Promise<void>((resolve) => {
        const onExit = (): void => resolve();
        child.once("exit", onExit);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // best-effort cleanup
            }
          }
        }, 3_000).unref();
      });
    },
  };
}
